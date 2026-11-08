"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

test("main errors are logged and shown as a notice, never a modal; a startup failure shows one plain message and exits", () => {
  for (const kind of ["throw", "reject", "startup", "delayed"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-error-guard-"));
    try {
      const script = `
        const Module = require('node:module');
        const original = Module._load;
        const events = require('node:events');
        const app = new events.EventEmitter();
        app.getPath = () => ${JSON.stringify(dir)};
        app.exit = code => process.exit(code);
        let available = ${JSON.stringify(kind)} !== 'delayed';
        const contents = new events.EventEmitter();
        contents.isLoading = () => false; contents.executeJavaScript = code => { console.log('NOTICE', code); return Promise.resolve(); };
        const window = { isDestroyed: () => false, webContents: contents };
        Module._load = function(id, ...args) { if (id === 'electron') return { app, BrowserWindow: { getAllWindows: () => available ? [window] : [] }, dialog: { showErrorBox: () => { console.log('DIALOG'); } } }; return original.call(this, id, ...args); };
        const guard = require(${JSON.stringify(path.join(__dirname, "main-error-guard.cts"))});
        if (${JSON.stringify(kind)} !== 'startup') guard.ready();
        if (${JSON.stringify(kind)} === 'reject') Promise.reject(new Error('guard regression'));
        else setImmediate(() => { throw new Error('guard regression'); });
        if (${JSON.stringify(kind)} === 'delayed') setTimeout(() => { available = true; app.emit('browser-window-created', {}, window); contents.emit('did-finish-load'); }, 30);
        setTimeout(() => process.exit(0), 100);
      `;
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5000 });
      assert.equal(child.status, kind === "startup" ? 1 : 0, child.stderr);
      assert.match(fs.readFileSync(path.join(dir, "main.log"), "utf8"), /guard regression/);
      if (kind !== "startup") {
        assert.match(child.stdout, /NOTICE/);
        assert.doesNotMatch(child.stdout, /DIALOG/);
      } else {
        assert.doesNotMatch(child.stdout, /NOTICE/);
        assert.match(child.stdout, /DIALOG/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
