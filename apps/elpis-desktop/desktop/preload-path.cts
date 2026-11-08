"use strict";

const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { stripTypeScriptTypes }: typeof import("node:module") = require("node:module");

// Sandboxed Electron preloads run as scripts, so Node cannot strip their types on load.
const names = new Set(["preload", "browser-page-preload", "quick-entry-preload", "screenshot-popup-preload"]);
let directory: string | undefined;

function preloadPathImpl(name: string): string {
  if (!names.has(name)) throw new Error(`Unknown preload: ${name}`);
  if (!directory) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-preload-"));
    const temporaryDirectory = directory;
    process.once("exit", () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  }
  const target = path.join(directory, `${name}.cjs`);
  if (!fs.existsSync(target)) {
    const source = fs.readFileSync(path.join(__dirname, `${name}.cts`), "utf8");
    fs.writeFileSync(target, stripTypeScriptTypes(source), { mode: 0o600 });
  }
  return target;
}

export declare const preloadPath: typeof preloadPathImpl;
module.exports = { preloadPath: preloadPathImpl };
