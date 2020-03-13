/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

@Library('jenkins-joylib@v1.0.4') _

pipeline {

    agent {
        label joyCommonLabels(image_ver: '15.4.1')
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
    }

    stages {
        stage('build image and upload') {
            steps {
                sh('''
set -o errexit
set -o pipefail
ENGBLD_BITS_UPLOAD_IMGAPI=true
make all release publish bits-upload
''')
            }
        }
    }

    post {
        always {
            joyMattermostNotification()
        }
    }
}
