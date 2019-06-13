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
var fs = require('fs');
var LineStream = require('lstream');
var net = require('net');
var path = require('path');
var restify = require('restify-clients');
var vasync = require('vasync');

var CLI_OPTIONS = [
    {
        names: ['dryrun', 'n'],
        type: 'bool',
        help: 'Dump what would be sent to zipkin. (without sending)'
    },
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
        names: ['logList'],
        type: 'string',
        help: 'File containing a list of log files to pump',
        helpArg: 'FILES'
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
    '/var/svc/log/smartdc-agent-cn-agent:default.log',
    '{{cloudapi}}/var/svc/log/smartdc-application-cloudapi:cloudapi-8081.log',
    '{{cloudapi}}/var/svc/log/smartdc-application-cloudapi:cloudapi-8082.log',
    '{{cloudapi}}/var/svc/log/smartdc-application-cloudapi:cloudapi-8083.log',
    '{{cloudapi}}/var/svc/log/smartdc-application-cloudapi:cloudapi-8084.log',
    '{{cnapi}}/var/svc/log/smartdc-site-cnapi:default.log',
    '{{docker}}/var/svc/log/smartdc-application-docker:default.log',
    '{{fwapi}}/var/svc/log/smartdc-application-fwapi:default.log',
    '{{imgapi}}/var/svc/log/smartdc-site-imgapi:default.log',
    '{{napi}}/var/svc/log/smartdc-application-napi:default.log',
    '{{papi}}/var/svc/log/smartdc-application-papi:default.log',
    '{{vmapi}}/var/svc/log/smartdc-site-vmapi:default.log',
    '{{workflow}}/var/svc/log/smartdc-application-wf-api:default.log',
    '{{workflow}}/var/svc/log/smartdc-application-wf-runner:default.log'
];
var MAGIC_KEY = 'TritonTracing';
var MAGIC_VAL = 'TRITON';
var PUMP_FREQ = 1 * 1000;

var pumper;

function translateAnnotationValue(kind) {
    switch (kind) {
        case 'client-end':
        case 'client-recv-res':
        case 'client-recv':
        case 'client-receive':
            return 'cr';
        case 'client-send-req':
        case 'client-send':
        case 'client-start':
            return 'cs';
        case 'rpc-context-created':
            return 'lc';
        case 'server-request':
            return 'sr';
        case 'server-response':
            return 'ss';
        default:
            console.error('WARNING: assuming ' + kind + ' is a local span');
            return 'lc';
    }
}

// Zipkin trace IDs are 128bit and can be represented as a hex string,
// but with no UUID style dashes.  Span ids are still only 64 bits.
// https://github.com/openzipkin/zipkin/issues/1298
function zipkinifyTraceId(uuid) {
    return (uuid.replace(/-/g, ''));
}

function zipkinifySpanId(uuid) {
    // Need to take the first 16 digits because sadly some things use v1 for
    // generating UUIDs (I'm looking at you restify!)
    return (zipkinifyTraceId(uuid).substr(0, 16));
}


function arrayifyBinaryAnnotations(obj) {
    var i;
    var newBA = [];

    Object.keys(obj.binaryAnnotations).forEach(function (k) {
        var value = obj.binaryAnnotations[k];
        // Need to escape the value "tags", otherwise zipkin thinks this is a
        // v2 span element and the POST will fail.
        if (value === 'tags') {
            value = 'tags_';
        }
        newBA.push({
            key: k,
            value: value
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
// and adds them to the 'proto' object. For the special objects 'moray.rpc'
// which don't have string values, we flatten one more level.
//
function stringifyObj(proto, prefix, obj) {
    var idx;
    var keys;

    if (typeof(obj) !== 'object') {
         proto[prefix] = obj.toString();
         return;
    }

    keys = Object.keys(obj);

    if (prefix === 'moray.rpc') {
        for (idx = 0; idx < keys.length; idx++) {
            stringifyObj(proto, prefix + '.' + keys[idx], obj[keys[idx]]);
        }
        return;
    }

    for (idx = 0; idx < keys.length; idx++) {
        proto[prefix + '.' + keys[idx]] = obj[keys[idx]].toString();
    }
}

function serviceName(obj) {
    // var server;

    // if (obj.tags['http.method'] && obj.tags['http.url']) {
    //     if (obj.tags['client.name']
    //         && obj.tags['client.name'].indexOf('sdc-clients:') === 0) {

    //         server = obj.tags['client.name'].substr(12);
    //     }
    // }

    // if (!server && obj.tags && obj.tags['http.headers']
    //     && obj.tags['http.headers'].server) {

    //     server = obj.tags['http.headers'].server;
    // }

    // if (server) {
    //     switch (server) {
    //         case 'Compute Node Agent':
    //             server = 'cn-agent';
    //             break;
    //         case 'Compute Node API':
    //             server = 'cnapi';
    //             break;
    //         case 'WorkflowAPI':
    //             server = 'wfapi';
    //             break;
    //         case 'SmartDC Firewall API':
    //             server = 'fwapi';
    //             break;
    //         case 'SDC Package API 7.0.0':
    //             server = 'papi';
    //             break;
    //         case 'SmartDataCenter Networking API':
    //             server = 'napi';
    //             break;
    //         default:
    //             break;
    //     }

    //     if (server.match(/^imgapi\/[0-9\.]+$/)) {
    //         server = 'imgapi';
    //     }

    //     if (obj.name === 'workflow-api') {
    //         obj.name = 'wfapi';
    //     } else if (obj.name === 'workflow-runner') {
    //         obj.name = 'wfrunner';
    //     }

    //     // console.log('SERVER [' + server + ']');
    //     return (obj.name + ' -> ' + server);
    // }

    // console.log('OBJ.NAME [' + obj.name + ']');
    switch (obj.name) {
        case 'PackagesAPI':
            return 'papi';
        case 'workflow-api':
            return 'wfapi';
        case 'workflow-runner':
            return 'wfrunner';
    }

    return (obj.name);
}

function isLocalSpan(obj) {
    if (obj.logs.length === 2
        && obj.logs[0].event === 'local-begin'
        && obj.logs[1].event === 'local-end'
        && obj.logs[0].hasOwnProperty('timestamp')
        && obj.logs[1].hasOwnProperty('timestamp')) {

        return true;
    }
    return false;
}

// See also: https://github.com/openzipkin/zipkin/issues/808
function processLocalSpan(obj, proto) {
    var endTs = Number(obj.logs[1].timestamp) * 1000;
    var startTs = Number(obj.logs[0].timestamp) * 1000;

    proto.timestamp = startTs;
    proto.duration = endTs - startTs;

    // Always have at least 1us of duration since it makes tools happier, and
    // our granularity is 1ms so it's likely we didn't actually take 0.000ms.
    if (proto.duration === 0) {
        proto.duration = 1;
    }
    delete proto.annotations;

    return;
}

function objHandler(obj) {
    var ba;
    var id;
    var ipKey = 'ipv4';
    var ipPort = 0;
    var ipVal = '0.0.0.0';
    var local = false;
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
        id: zipkinifySpanId(id),
        traceId: zipkinifyTraceId(obj.traceId),
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
        proto.parentId = zipkinifySpanId(obj.parentSpanId);
    }

    proto.duration = obj.elapsed * 1000;
    if (proto.duration === 0) {
        proto.duration = 1;
    }

    // look for a special local span and if we have one, treat it specially.
    if (isLocalSpan(obj)) {
        local = true;
        processLocalSpan(obj, proto);

        if (obj.tags['peer.addr'] && net.isIP(obj.tags['peer.addr'])) {
            ipKey = net.isIPv6(obj.tags['peer.addr']) ? 'ipv6' : 'ipv4';
            ipVal = obj.tags['peer.addr']
        }
        if (obj.tags['peer.port']) {
            ipPort = obj.tags['peer.port'];
        }
    } else {
        // console.log('TAGS: ' + JSON.stringify(obj.tags));

        // Each "log" entry has a timestamp and will be considered an "annotation"
        // in Zipkin's terminology.
        obj.logs.forEach(function _addEvt(evt) {
            ipKey = 'ipv4';
            ipVal = '0.0.0.0';

            if (obj.tags['peer.addr'] && net.isIP(obj.tags['peer.addr'])) {
                ipKey = net.isIPv6(obj.tags['peer.addr']) ? 'ipv6' : 'ipv4';
                ipVal = obj.tags['peer.addr'];
            }
            // TODO(cburroughs): Use [key]:val syntax once node v4 is available
            var annotation = {
                endpoint: {
                    port: obj.tags['peer.port'] || 0,
                    serviceName: serviceName(obj)
                }, timestamp: Number(evt.timestamp) * 1000,
                value: translateAnnotationValue(evt.event)
            };
            annotation['endpoint'][ipKey] = ipVal;
            proto.annotations.push(annotation);
        });
    }

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

    if (local) {
        // local spans need this special binaryAnnotation per:
        // https://github.com/openzipkin/zipkin/issues/808
        ba = {
            "key": "lc",
            "value": 'localComponent',
            "endpoint": {
                "serviceName": serviceName(obj),
                "ipv4": "0.0.0.0",
                "port": "0"
            }
        };
        ba.endpoint[ipKey] = ipVal;
        proto.binaryAnnotations.push(ba);
    }

    return (proto);
}

function loadArgs(stor, cb) {
    var exitStatus = 0;
    var filename;
    var help;
    var idx;
    var opts;
    var parser = dashdash.createParser({options: CLI_OPTIONS});

    try {
        opts = parser.parse(process.argv);
    } catch (e) {
        cb(e);
    }

    // if there are arguments, they should be absolute filenames
    if (opts._args.length > 0) {
        for (idx = 0; idx < opts._args.length; idx++) {
            filename = opts._args[idx];
            if (opts._args[idx] === '-') {
                filename = '/dev/stdin';
            }

            if (filename[0] !== '/') {
                console.error('FATAL: "' + filename + '" is not an absolute path');
                exitStatus = 2;
                opts.help = true;
                break;
            }

            if (!stor.inputFiles) {
                stor.inputFiles = [];
            }

            if (stor.inputFiles.indexOf(filename) === -1) {
                stor.inputFiles.push(filename);
            }
        }
    }
    if (opts.logList) {
        stor.inputFiles = fs.readFileSync(
            opts.logList, {encoding: 'utf8'})
            .split('\n')
            .filter(function(x) {return x});
    }

    if (opts.dryrun) {
        stor.dryRun = true;
    } else if (!opts.host) {
        console.error('FATAL: Zipkin host is required.');
        exitStatus = 2;
        opts.help = true;
    }

    // Use `parser.help()` for formatted options help.
    if (opts.help) {
        help = parser.help({includeEnv: true}).trimRight();
        console.log('usage: ziploader [OPTIONS] [FILES]\n' + 'options:\n' + help);
        process.exit(exitStatus);
    }

    if (!opts.dryrun) {
        stor.zipkinHost = opts.host;
        stor.zipkinPort = opts.port;
    }

    cb();
}

function pumpToZipkin(stor, load) {
    var client;
    var contents = '';
    var idx;
    var key;
    var traces = {};
    var url;

    if (!stor.dryRun) {
        url = 'http://' + stor.zipkinHost + ':' + stor.zipkinPort + '/zipkin';
    }

    for (idx = 0; idx < load.length; idx++) {
        key = (url ? url + '/traces/'+ load[idx].traceId : load[idx].traceId);
        traces[key] = (traces[key] ? traces[key] + 1 : 1);
        var parentId = load[idx].parentId ? load[idx].parentId : 'null';
        console.error('[' + load[idx].traceId + '/' +
                      load[idx].zonename + ']: ' +
                      parentId + ' -> ' + load[idx].id +
                      ' (' + load[idx].name + ')');
        delete load[idx].zonename;
    }

    if (stor.dryRun) {
        console.log(JSON.stringify(load, null, 2));
        return;
    }

    client = restify.createJsonClient({url: url, agent: false});

    client.post({path: '/api/v1/spans',
                // Newer Zipkin servers will fail if the accept type is json.
                headers: {
                    accept: '*/*'
                }
            },
            load,
            function(err, req, res, obj) {
        if (err) {
            console.log('Error: ', err);
        }
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

        pumper = setTimeout(pump, PUMP_FREQ);
    }

    pump();
    cb();
}

function processSpanLog(stor, obj) {

    if (!obj.hasOwnProperty(MAGIC_KEY)) {
        return;
    }
    assert.equal(obj[MAGIC_KEY], MAGIC_VAL, 'bad magic');

    var zipobj = objHandler(obj);

    if (!stor.queue) {
        stor.queue = [];
    }

    // XXX: For now: skip some junk that we don't care about (/ping)
    if (obj.tags['http.url'] && obj.tags['http.url'].indexOf('/ping') === 0) {
        return;
    }

    // XXX: Skip docker:exec calls (i.e. interactive docker commands).
    if (obj.name === 'execstart' && obj.localEndpoint &&
            obj.localEndpoint.serviceName === 'docker') {
        return;
    }

    stor.queue.push(zipobj);

    return;
}

function findUfdsAdmin(stor, cb) {

    // when in files mode, we don't need to deal with templates
    if (stor.inputFiles) {
        cb();
        return;
    }

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

    // when in files mode, we don't need to deal with templates
    if (stor.inputFiles) {
        cb();
        return;
    }

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

    // when in files mode, we don't need to deal with templates
    if (stor.inputFiles) {
        cb();
        return;
    }

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
    var _onLstreamReadable = function _onLstreamReadable(lstream) {
        var line;
        var obj;

        // read the first line
        line = lstream.read();

        while (line !== null) {
            assert.string(line, 'line');

            if (line[0] === '{' && line.indexOf(MAGIC_KEY) !== -1) {
                // just let it throw if not JSON: that's a bug
                obj = JSON.parse(line.trim());
                processSpanLog(stor, obj);
            }

            // read the next line
            line = lstream.read();
        }
    };

    if (stor.inputFiles) {
        vasync.forEachParallel({
            func: function _readInput(filename, _cb) {
                var lstream = new LineStream({encoding: 'utf8'});
                lstream.on('readable', function() {
                    _onLstreamReadable(lstream);
                });
                console.error('reading from ' + filename);
                var stream = fs.createReadStream(filename, 'utf8');
                stream.on('end', function () {
                    _cb();
                });
                stream.pipe(lstream);
            }, inputs: stor.inputFiles
        }, function (err, results) {
            if (pumper) {
                clearTimeout(pumper);
            }

            // one last pump
            if (stor.queue.length > 0) {
                pumpToZipkin(stor, stor.queue);
            }
            cb(err);
        });
    } else {
        var lstream = new LineStream({encoding: 'utf8'});
        lstream.on('readable', function() {
            _onLstreamReadable(lstream);
        });
        var watcher;
        watcher = child_process.spawn('/usr/bin/tail',
            ['-0F'].concat(stor.tailFiles), {stdio: 'pipe'});
        console.error('tail running with pid ' + watcher.pid);

        watcher.stdout.pipe(lstream);
        watcher.stdin.end();

        watcher.on('exit', function _onWatcherExit(code, signal) {
            console.error({code: code, signal: signal}, 'tail exited');
            // TODO: restart if we're not done?
            // TODO: Error if code !== 0?
            cb();
        });
    }
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
