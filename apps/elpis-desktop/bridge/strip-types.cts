"use strict";
const { stripTypeScriptTypes } = require("node:module");
module.exports = (source: string) => stripTypeScriptTypes(source, { mode: "strip" });
