#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2020 Joyent, Inc.
#

ENGBLD_USE_BUILDIMAGE	= false
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

NAME 			= ziploader
NODE_PREBUILT_TAG       = gz
NODE_PREBUILT_VERSION	:= v0.10.48
# sdc-minimal-multiarch-lts 15.4.1
NODE_PREBUILT_IMAGE     = 18b094b0-eb01-11e5-80c1-175dac7ddf02

TIMESTAMP := $(shell date -u "+%Y%m%dT%H%M%SZ")
FILENAME := "ziploader-$(TIMESTAMP)"
UUID := $(shell uuid -v 4)

ifeq ($(shell uname -s),SunOS)
        NODE_PREBUILT_TAG = gz
        include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
else
        NODE := $(shell which node)
        NPM := $(shell which npm)
        NPM_EXEC=$(NPM)
endif
include ./deps/eng/tools/mk/Makefile.node_modules.defs

.PHONY: all
all: $(STAMP_NODE_MODULES)

.PHONY: manifest
manifest: bits/$(NAME)/$(FILENAME).tgz
	@echo "=> building manifest (bits/$(NAME)/$(FILENAME).manifest"
	mkdir -p bits/$(NAME)
	cat manifest.tmpl | sed \
        -e "s/{{BUILDSTAMP}}/$(TIMESTAMP)/g" \
        -e "s/{{SHA1}}/$(shell sha1sum bits/$(NAME)/$(FILENAME).tgz | cut -d ' ' -f1)/g" \
        -e "s/{{SIZE}}/$(shell stat -c '%s' bits/$(NAME)/$(FILENAME).tgz)/g" \
        -e "s/{{UUID}}/$(UUID)/g" \
        -e "s/{{VERSION}}/$(TIMESTAMP)/g" \
        > bits/$(NAME)/$(FILENAME).manifest

.PHONY:
publish: bits/$(NAME)/$(FILENAME).tgz manifest

bits/$(NAME)/$(FILENAME).tgz: all
	@echo "=> building tar (bits/$(NAME)/$(FILENAME).tgz)"
	mkdir -p bits/$(NAME)
	tar -zcvf bits/$(NAME)/$(FILENAME).tgz \
	    *.js \
            LICENSE \
            node_modules \
            package.json \
            README.md

check::
	jshint *.js

include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.node_modules.targ
include ./deps/eng/tools/mk/Makefile.targ
