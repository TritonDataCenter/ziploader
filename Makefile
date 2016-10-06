#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

TIMESTAMP = $(shell date -u "+%Y%m%dT%H%M%SZ")
FILENAME = "ziploader-$(TIMESTAMP).tgz"

.PHONY: tar
tar: deps
	@echo "=> building tar (output/$(FILENAME))"
	@mkdir -p output
	@tar -zcvf output/$(FILENAME) \
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
