// 1 Nov, Masih: "make such leftovers don't appear again". Installs had piled up: 74 desktop versions (2.4 GB) and six
// engine bundles of 459 MB, none ever removed. After an install the newest five stay, with the current and rollback
// versions and any version a running process uses; the rest go to the trash.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pruneVersions } from '../../scripts/prune-versions.mts';

// Under the home folder, not /tmp: gio trash cannot trash on a tmpfs mount.
function versions(t: TestContext, count: number) {
  const scratch = path.join(homedir(), '.cache/elpis-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'prune-versions-'));
  t.after(() => { execFileSync('gio', ['trash', root]); });
  const dir = path.join(root, 'versions');
  // Created oldest first; v01 is the oldest.
  const names = Array.from({ length: count }, (_, i) => `v${String(i + 1).padStart(2, '0')}`);
  // Folder birth times are kernel ticks (about 4 ms) apart at best; a pause keeps the creation order visible.
  for (const name of names) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); mkdirSync(path.join(dir, name, 'bin'), { recursive: true }); writeFileSync(path.join(dir, name, 'bin/app'), name); }
  return { dir, names, left: () => readdirSync(dir).sort() };
}

test('an install keeps the newest five plus the current and rollback versions and trashes the rest', (t) => {
  const v = versions(t, 9);
  const trashed = pruneVersions(v.dir, { keep: [path.join(v.dir, 'v09/bin/app'), path.join(v.dir, 'v02')] });
  assert.deepEqual(v.left(), ['v02', 'v05', 'v06', 'v07', 'v08', 'v09']);
  assert.deepEqual(trashed.map(dir => path.basename(dir)).sort(), ['v01', 'v03', 'v04']);
});

test('a version a running process uses, or the live launcher names, is kept', async (t) => {
  const v = versions(t, 8);
  const launcher = path.join(path.dirname(v.dir), 'launcher');
  writeFileSync(launcher, `#!/bin/sh\nFRONTEND="${v.dir}/v02/bin/app"\n`);
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', path.join(v.dir, 'v01/bin/app')], { stdio: 'ignore' });
  t.after(() => { running.kill(); });
  await once(running, 'spawn');
  pruneVersions(v.dir, { namedIn: [launcher] });
  assert.deepEqual(v.left(), ['v01', 'v02', 'v04', 'v05', 'v06', 'v07', 'v08']);
});

test('fewer than six versions are left alone', (t) => {
  const v = versions(t, 5);
  assert.deepEqual(pruneVersions(v.dir), []);
  assert.deepEqual(v.left(), v.names);
});
