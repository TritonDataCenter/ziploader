#!/usr/node/bin/node
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright 2016, Joyent, Inc.
//
// This tool is intended to run in the global zone of a Triton node and will
// stream the triton tracer logs to a specified zipkin instance.
//

var assert = require('assert-plus');
var child_process = require('child_process');
var dashdash = require('dashdash');
var forkexec = require('forkexec');
var LineStream = require('lstream');
var path = require('path');
var restify = require('restify-clients');
var vasync = require('vasync');

var CLI_OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['host', 'H'],
        type: 'string',
        help: 'Zipkin host (required)',
        helpArg: 'HOST'
    },
    {
        names: ['port', 'P'],
        type: 'string',
        help: 'Zipkin port (default 9411)',
        helpArg: 'PORT',
        default: 9411
    }
];
var FILES = [
    '{{cnapi}}//var/svc/log/smartdc-site-cnapi:default.log',
    '{{docker}}/var/svc/log/smartdc-application-docker:default.log',
    '{{fwapi}}/var/svc/log/smartdc-application-fwapi:default.log',
    '{{vmapi}}/var/svc/log/smartdc-site-vmapi:default.log'
];
var MAGIC_KEY = 'TritonTracing';
var MAGIC_VAL = 'TRITON';
var PUMP_FREQ = 1 * 1000;

function translateAnnotationValue(kind) {
    switch (kind) {
        case 'client-recv-res':
            return 'cr';
        case 'client-send-req':
            return 'cs';
        case 'server-request':
            return 'sr';
        case 'server-response':
            return 'ss';
        default:
            console.error('WARNING: assuming ' + kind + ' is a local span');
            return 'lc';
    }
}

function zipkinifyId(uuid) {
    // Need to take the first 16 digits because sadly some things use v1 for
    // generating UUIDs (I'm looking at you restify!) and it appears that zipkin
    // chokes on such UUIDs and thinks they'll all the same because of:
    //
    // https://github.com/openzipkin/zipkin/commit/90342b4b5fa36ec844de4dd68ebe6ab74c5e142d
    //
    // which is related to:
    //
    // https://github.com/openzipkin/zipkin/issues/1262
    // https://github.com/openzipkin/zipkin/issues/1298
    //
    // So, currently it only uses the last 16 characters even when it gets 32.
    //
    return (uuid.replace(/-/g, '').substr(0, 16));
}

function arrayifyBinaryAnnotations(obj) {
    var i;
    var newBA = [];

    Object.keys(obj.binaryAnnotations).forEach(function (k) {
        newBA.push({
            key: k,
            value: obj.binaryAnnotations[k]
        });
    });

    obj.binaryAnnotations = newBA;
}

// Flattens an object (obj) that looks like:
//
// 'restify.timers': {
//     bunyan: 0.058,
//     checkApprovedForProvisioning: 0.007,
//     ...
// }
//
// into:
//
// 'restify.timers.bunyan': 0.058,
// 'restify.timers.checkApprovedForProvisioning': 0.007,
// ...
//
// and adds them to the 'proto' object.
//
function stringifyObj(proto, prefix, obj) {
    var idx;
    var keys = Object.keys(obj);

    for (idx = 0; idx < keys.length; idx++) {
        proto[prefix + '.' + keys[idx]] = obj[keys[idx]].toString();
    }
}

function serviceName(obj) {
    var server;

    if (obj.tags['http.method'] && obj.tags['http.url']) {
        if (obj.tags['client.name']
            && obj.tags['client.name'].indexOf('sdc-clients:') === 0) {

            server = obj.tags['client.name'].substr(12);
        }
    }

    if (!server && obj.tags && obj.tags['http.headers']
        && obj.tags['http.headers'].server) {

        server = obj.tags['http.headers'].server;
    }

    if (server) {
        switch (server) {
            case 'compute node agent':
                server = 'cn-agent';
                break;
            case 'WorkflowAPI':
                server = 'wfapi';
                break;
            default:
                break;
        }
        return (obj.name + ' -> ' + server);
    }

    return (obj.name);
}

function objHandler(obj) {
    var id;
    var span = {};
    var name;
    var proto = {};

    assert.uuid(obj.spanId, 'obj.spanId');
    assert.uuid(obj.traceId, 'obj.traceId');
    if (obj.parentSpanId !== '0') {
        assert.optionalUuid(obj.parentSpanId, 'obj.parentSpanId');
    }
    assert.string(obj.operation, 'obj.operation');

    id = obj.spanId;

    proto = {
        annotations: [],
        binaryAnnotations: {
            reqId: obj.traceId
        }, // obj for now, we'll convert later
        name: obj.operation,
        id: zipkinifyId(id),
        traceId: zipkinifyId(obj.traceId),
        zonename: obj.name
    };

    if (proto.name === 'restify_request') {
        // try to give it a more useful name
        if (obj.tags['http.method'] && obj.tags['http.url']) {
            if (obj.tags['client.name'] && obj.tags['client.name'].indexOf('sdc-clients:') === 0) {
                name = obj.tags['client.name'].substr(12) + ' ' + obj.tags['http.method'];
            } else {
                name = obj.tags['http.method'];
            }
            // /packages?xyz -> /packages
            proto.name
                = name + ' ' + obj.tags['http.url'].split('?')[0].substr(0,80);
        }
    }

    if (obj.parentSpanId && obj.parentSpanId !== '0') {
        proto.parentId = zipkinifyId(obj.parentSpanId);
    } else {
        proto.parentId = proto.traceId;
        proto.duration = obj.elapsed * 1000;
    }

    // console.log('TAGS: ' + JSON.stringify(obj.tags));

    // Each "log" entry has a timestamp and will be considered an "annotation"
    // in Zipkin's terminology.
    obj.logs.forEach(function _addEvt(evt) {
        proto.annotations.push({
            endpoint: {
                ipv4: obj.tags['peer.addr'] || '0.0.0.0',
                port: obj.tags['peer.port'] || 0,
                serviceName: serviceName(obj)
            }, timestamp: Number(evt.timestamp) * 1000,
            value: translateAnnotationValue(evt.event)
        });
    });

    if (!obj.tags.hasOwnProperty('hostname')) {
        obj.tags.hostname = obj.hostname;
    }
    obj.tags.pid = obj.pid;

    // These are already in the annotations
    delete obj.tags['peer.addr'];
    delete obj.tags['peer.port'];

    Object.keys(obj.tags).forEach(function _addTag(k) {
        if (typeof(obj.tags[k]) === 'object') {
            stringifyObj(proto.binaryAnnotations, k, obj.tags[k]);
        } else {
            proto.binaryAnnotations[k] = obj.tags[k].toString();
        }
    });

    arrayifyBinaryAnnotations(proto);

    return (proto);
}

function loadArgs(stor, cb) {
    var exitStatus = 0;
    var help;
    var opts;
    var parser = dashdash.createParser({options: CLI_OPTIONS});

    try {
        opts = parser.parse(process.argv);
    } catch (e) {
        cb(e);
    }

    if (!opts.host) {
        console.error('FATAL: Zipkin host is required.');
        exitStatus = 2;
        opts.help = true;
    }

    // Use `parser.help()` for formatted options help.
    if (opts.help) {
        help = parser.help({includeEnv: true}).trimRight();
        console.log('usage: ziploader [OPTIONS]\n' + 'options:\n' + help);
        process.exit(exitStatus);
    }

    stor.zipkinHost = opts.host;
    stor.zipkinPort = opts.port;

    cb();
}

function pumpToZipkin(stor, load) {
    var client;
    var contents = '';
    var idx;
    var key;
    var traces = {};
    var url;

    url = 'http://' + stor.zipkinHost + ':' + stor.zipkinPort;
    client = restify.createJsonClient({url: url});

    for (idx = 0; idx < load.length; idx++) {
        key = url + '/traces/'+ load[idx].traceId;
        traces[key] = (traces[key] ? traces[key] + 1 : 1);
        console.log('[' + load[idx].traceId + '/' + load[idx].zonename + ']: ' + load[idx].parentId + ' -> ' + load[idx].id + ' (' + load[idx].name + ')');
        delete load[idx].zonename;
    }

    client.post('/api/v1/spans', load, function(err, req, res, obj) {
        assert.ifError(err);
        console.log('%d -> %j', res.statusCode, res.headers);
        // console.log(JSON.stringify(load, null, 2));
        console.log('== UPDATED TRACES: ==');
        console.log(Object.keys(traces).join('\n'));
    });
}

function startPumping(stor, cb) {
    function pump() {
        var load = stor.queue;

        stor.queue = [];

        if (load && load.length > 0) {
            pumpToZipkin(stor, load);
        }

        setTimeout(pump, PUMP_FREQ);
    }

    pump();
    cb();
}

function processSpanLog(stor, obj) {
    assert.equal(obj[MAGIC_KEY], MAGIC_VAL, 'bad magic');

    var zipobj = objHandler(obj);

    if (!stor.queue) {
        stor.queue = [];
    }

    // XXX: For now: skip some junk that we don't care about (/ping)
    if (obj.tags['http.url'] && obj.tags['http.url'].indexOf('/ping') === 0) {
        return;
    }

    stor.queue.push(zipobj);

    return;
}

function findUfdsAdmin(stor, cb) {
    forkexec.forkExecWait({
        argv: ['/usr/bin/bash', '/lib/sdc/config.sh', '-json']
    }, function (err, info) {
        if (!err) {
            stor.ufdsAdmin = JSON.parse(info.stdout).ufds_admin_uuid;
            assert.uuid(stor.ufdsAdmin);
        }
        cb(err);
    });
}

function findReplacements(stor, cb) {
    forkexec.forkExecWait({
        argv: [
            '/usr/sbin/vmadm',
            'lookup', '-j', '-o', 'zonepath,tags',
            'owner_uuid=' + stor.ufdsAdmin,
            'tags.smartdc_role=~[a-z]'
        ]
    }, function (err, info) {
        var idx;
        var vms;

        stor.replacements = {};

        if (!err) {
            vms = JSON.parse(info.stdout);
            for (idx = 0; idx < vms.length; idx++) {
                stor.replacements['{{' + vms[idx].tags.smartdc_role + '}}']
                    = path.join(vms[idx].zonepath, '/root');
            }
        }
        cb(err);
    });
}

function templatifyFiles(stor, cb) {
    var i;
    var j;
    var keys;
    var pattern;

    keys = Object.keys(stor.replacements);
    for (i = 0; i < keys.length; i++) {
        for (j = 0; j < FILES.length; j++) {
            if (FILES[j].indexOf(keys[i]) === 0) {
                // this FILES entry starts with our zone's tag
                FILES[j] = FILES[j].replace(keys[i], stor.replacements[keys[i]]);
            }
        }
    }

    // keep only those which are now absolute paths
    stor.tailFiles = [];
    for (j = 0; j < FILES.length; j++) {
        if (FILES[j].indexOf('/') === 0) {
            stor.tailFiles.push(FILES[j]);
        }
    }

    cb();
}

function startTailing(stor, cb) {
    var lstream = new LineStream({encoding: 'utf8'});
    var watcher;

    lstream.on('readable', function _onLstreamReadable() {
        var line;
        var obj;

        // read the first line
        line = lstream.read();

        while (line !== null) {
            assert.string(line, 'line');

            if (line.indexOf('{') === 0 && line.indexOf(MAGIC_KEY) !== -1) {
                // just let it throw if not JSON: that's a bug
                obj = JSON.parse(line.trim());
                processSpanLog(stor, obj);
            }

            // read the next line
            line = lstream.read();
        }
    });

    watcher = child_process.spawn('/usr/bin/tail',
        ['-0F'].concat(stor.tailFiles), {stdio: 'pipe'});
    console.log('tail running with pid ' + watcher.pid);

    watcher.stdout.pipe(lstream);
    watcher.stdin.end();

    watcher.on('exit', function _onWatcherExit(code, signal) {
        console.error({code: code, signal: signal}, 'tail exited');
        // TODO: restart if we're not done?
        // TODO: Error if code !== 0?
        cb();
    });
}

// main
vasync.pipeline({
    arg: {},
    funcs: [
        loadArgs,
        findUfdsAdmin,
        findReplacements,
        templatifyFiles,
        startPumping,
        startTailing
    ]
}, function _pipelineComplete(err) {
    assert.ifError(err);
});
