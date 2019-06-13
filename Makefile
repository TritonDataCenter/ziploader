#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

TIMESTAMP := $(shell date -u "+%Y%m%dT%H%M%SZ")
FILENAME := "ziploader-$(TIMESTAMP)"
UUID := $(shell uuid -v 4)

.PHONY: release
release: tar manifest

.PHONY: manifest
manifest: output/$(FILENAME).tgz
	@echo "=> building manifest (output/$(FILENAME).manifest"
	@cat manifest.tmpl | sed \
        -e "s/{{BUILDSTAMP}}/$(TIMESTAMP)/g" \
        -e "s/{{SHA1}}/$(shell sha1sum output/$(FILENAME).tgz | cut -d ' ' -f1)/g" \
        -e "s/{{SIZE}}/$(shell stat -c '%s' output/$(FILENAME).tgz)/g" \
        -e "s/{{UUID}}/$(UUID)/g" \
        -e "s/{{VERSION}}/$(TIMESTAMP)/g" \
        > output/$(FILENAME).manifest

output/$(FILENAME).tgz: tar

.PHONY: tar
tar: deps
	@echo "=> building tar (output/$(FILENAME).tgz)"
	@mkdir -p output
	@tar -zcvf output/$(FILENAME).tgz \
        *.js \
        LICENSE \
        node_modules \
        package.json \
        README.md

.PHONY: deps
deps:
	@mkdir -p node_modules
	@echo "=> npm install"
	@npm install
	./node_modules/.bin/kthxbai || true # work around trentm/node-kthxbai#1
	./node_modules/.bin/kthxbai

.PHONY: clean
clean:
	@echo "=> cleaning"
	@rm -rf output

check:
	jshint *.js
