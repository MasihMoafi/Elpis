'use strict';
const { stripTypeScriptTypes } = require('node:module');
/** @param {string} source */
module.exports = source => stripTypeScriptTypes(source, { mode: 'strip' });
