"use strict";

const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { stripTypeScriptTypes }: typeof import("node:module") = require("node:module");

// Sandboxed Electron preloads run as scripts, so Node cannot strip their types on load.
const names = new Set(["preload", "browser-page-preload", "quick-entry-preload", "screenshot-popup-preload"]);
// A sandboxed preload cannot require its neighbours, so its local modules are bundled in front of it.
const bundled: Record<string, string[]> = { "browser-page-preload": ["browser-page-locate"] };
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
    const read = (file: string) => stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, `${file}.cts`), "utf8"));
    const modules = (bundled[name] ?? [])
      .map(
        file =>
          `local["./${file}.cts"] = (() => { const module = { exports: {} }; ${read(file)}\nreturn module.exports; })();`,
      )
      .join("\n");
    const source = modules
      ? `const local = {};\n${modules}\n((require) => {${read(name)}\n})(id => local[id] ?? require(id));`
      : read(name);
    fs.writeFileSync(target, source, { mode: 0o600 });
  }
  return target;
}

export declare const preloadPath: typeof preloadPathImpl;
module.exports = { preloadPath: preloadPathImpl };
