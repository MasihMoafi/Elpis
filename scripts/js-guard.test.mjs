import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./js-guard.mjs', import.meta.url));
test('gate rejects a late error guard and new JavaScript files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'elpis-js-guard-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    mkdirSync(path.join(dir, 'apps/elpis-desktop/desktop'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'));
    const main = path.join(dir, 'apps/elpis-desktop/desktop/main.cts');
    const install = "'use strict';\nconst errorGuard: typeof import('./main-error-guard.cts') = require('./main-error-guard.cts');\n";
    writeFileSync(main, install);
    writeFileSync(path.join(dir, 'scripts/js-allowlist.txt'), 'allowed.js\n');
    writeFileSync(path.join(dir, 'allowed.js'), '');
    const run = () => spawnSync(process.execPath, [guard, dir], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    writeFileSync(main, "require('electron');\n" + install);
    assert.match(run().stderr, /install the main error guard first/);
    assert.equal(run().status, 1);
    writeFileSync(main, install);
    writeFileSync(path.join(dir, 'new.mjs'), '');
    assert.match(run().stderr, /new\.mjs/);
    assert.equal(run().status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
