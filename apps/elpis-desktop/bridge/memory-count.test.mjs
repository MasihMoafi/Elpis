import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createSettingsFiles } from './settings-files.mjs';
import { startDesktopServer } from './server.mjs';

const { createTestTempDir, removeTestTempDir } = createRequire(import.meta.url)('../tests/temp-root.cjs');

test('counts saved Markdown files in the native memory folder and fails when a folder is unreadable', async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), 'memory-count-'));
  t.after(() => removeTestTempDir(home));
  const files = createSettingsFiles(home), memory = path.join(home, 'memories');
  assert.equal(await files.countMemoryFiles(), 0, 'a missing memory folder has no files');
  const nested = path.join(memory, 'rollout_summaries', 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(memory, 'MEMORY.md'), 'secret: not returned');
  await fs.writeFile(path.join(nested, 'first.MD'), 'multiple\n- facts\n- do not count');
  await fs.writeFile(path.join(nested, 'second.markdown'), 'one file');
  await fs.writeFile(path.join(nested, 'ignored.txt'), 'not Markdown');
  await fs.mkdir(path.join(nested, 'directory.md'));
  await fs.symlink(path.join(memory, 'MEMORY.md'), path.join(nested, 'linked.md'));
  await fs.symlink(memory, path.join(nested, 'loop'));
  assert.equal(await files.countMemoryFiles(), 4, 'files and file links count; directories and directory links do not');
  await fs.chmod(nested, 0);
  try { await assert.rejects(files.countMemoryFiles(), /unavailable/i); }
  finally { await fs.chmod(nested, 0o700); }
  await fs.rename(memory, path.join(home, 'original-memory'));
  await fs.symlink(path.join(home, 'original-memory'), memory);
  await assert.rejects(files.countMemoryFiles(), /unavailable/i, 'a linked memory root cannot match reset');
});

test('the count endpoint authenticates, rejects parameters and returns no file contents', async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), 'memory-count-http-'));
  t.after(() => removeTestTempDir(home));
  await fs.mkdir(path.join(home, 'memories'));
  await fs.writeFile(path.join(home, 'memories', 'private.md'), 'a private memory');
  const client = new EventEmitter(); client.close = () => {};
  const bridge = await startDesktopServer({ client, elpisHome: home, loveSpot: { directory: path.join(home, 'love') }, trashFile: path.join(home, 'trash.json') });
  t.after(() => bridge.close());
  const url = new URL(bridge.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.equal((await fetch(`${origin}/api/memories/count`)).status, 401);
  const session = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const headers = { cookie: session.headers.get('set-cookie').split(';')[0], origin };
  assert.equal((await fetch(`${origin}/api/memories/count?path=elsewhere`, { headers })).status, 400);
  const result = await fetch(`${origin}/api/memories/count`, { headers });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { count: 1 });
  await fs.chmod(path.join(home, 'memories'), 0);
  try {
    const failure = await fetch(`${origin}/api/memories/count`, { headers });
    assert.equal(failure.status, 503);
    assert.doesNotMatch(JSON.stringify(await failure.json()), /private memory|private\.md/);
  } finally { await fs.chmod(path.join(home, 'memories'), 0o700); }
});
