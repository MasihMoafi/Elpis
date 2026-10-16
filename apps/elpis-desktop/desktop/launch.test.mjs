import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('application-menu launch uses bundled Electron and carries an explicit Node path without shell setup', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis dock launch '));
  for (const dir of ['desktop', 'out', 'node_modules/electron/dist']) fs.mkdirSync(path.join(app, dir), { recursive: true });
  fs.copyFileSync(new URL('./launch.sh', import.meta.url), path.join(app, 'desktop/launch.sh'));
  fs.writeFileSync(path.join(app, 'out/index.html'), '<title>Check</title>');
  fs.writeFileSync(path.join(app, 'node_modules/electron/path.txt'), 'electron');
  fs.writeFileSync(path.join(app, 'node_modules/electron/dist/electron'), '#!/bin/bash\nprintf "%s\\n" "$ELPIS_NODE_BIN" "$PATH" "$@" > "$ELPIS_LAUNCH_TEST_MARKER"\n', { mode: 0o700 });
  const marker = path.join(app, 'launched');
  const result = spawnSync('/bin/bash', [path.join(app, 'desktop/launch.sh'), '--smoke'], {
    env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', ELPIS_NODE_BIN: process.execPath, ELPIS_LAUNCH_TEST_MARKER: marker }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [node, searchPath, ...args] = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(node, process.execPath);
  assert.equal(searchPath.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.deepEqual(args, [app, '--smoke']);
});
