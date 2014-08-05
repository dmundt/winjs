// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
(function () {
    "use strict";

    var config = require("../../config.js");

    module.exports = {
        options: {
            config: ".jscsrc"
        },
        buildFiles: {
            src: config.lint.buildFiles,
            options: {
            },
        },
        srcFiles: {
            src: config.lint.srcFiles,
            options: {
            },
        },
    };
})();