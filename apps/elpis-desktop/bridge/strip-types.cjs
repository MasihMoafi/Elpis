'use strict';
const { stripTypeScriptTypes } = require('node:module');
module.exports = source => stripTypeScriptTypes(source, { mode: 'strip' });
