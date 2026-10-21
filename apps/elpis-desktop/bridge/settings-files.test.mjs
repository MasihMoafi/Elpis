import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSettingsFiles } from './settings-files.mjs';
import { startDesktopServer } from './server.mjs';

const home = () => fs.mkdtemp(path.join(os.tmpdir(), 's2-files-'));
test('both engine files create, roundtrip Unicode/long text and empty contents across reopen', async () => {
  const root = await home(), files = createSettingsFiles(root);
  for (const kind of ['instructions', 'memory']) {
    const initial = await files.read(kind); assert.equal(initial.version, 'missing');
    const content = '# Rules\nفارسی\n' + 'a'.repeat(150000);
    const saved = await files.save(kind, { version: initial.version, content });
    assert.equal(await fs.readFile(saved.path, 'utf8'), content);
    assert.deepEqual(await createSettingsFiles(root).read(kind), saved);
    assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
    const empty = await files.save(kind, { version: saved.version, content: '' });
    assert.equal(empty.content, ''); assert.notEqual(empty.version, 'missing');
  }
});
test('stale and concurrent saves refuse overwrite; invalid kind, content, symlinks and directories fail', async () => {
  const root = await home(), files = createSettingsFiles(root);
  const original = await files.save('instructions', { version: 'missing', content: 'original' });
  const results = await Promise.allSettled(['first', 'second'].map(content => files.save('instructions', { version: original.version, content })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal((await files.read('instructions')).content, 'first');
  await assert.rejects(files.read('../config.toml'), /Unknown/);
  for (const input of [{ version: original.version, content: null }, { content: 'x' }, { version: original.version, content: 'x', path: '/elsewhere' }]) await assert.rejects(files.save('instructions', input));
  await fs.symlink('AGENTS.md', path.join(root, 'linked'));
  const other = await home(); await fs.symlink(other, path.join(root, 'memories'));
  await assert.rejects(files.save('memory', { version: 'missing', content: 'escape' }), /local directory/);
  assert.deepEqual(await fs.readdir(other), []);
  const root2 = await home(); await fs.symlink(path.join(root, 'AGENTS.md'), path.join(root2, 'AGENTS.md'));
  await assert.rejects(createSettingsFiles(root2).read('instructions'));
  const root3 = await home(); await fs.mkdir(path.join(root3, 'AGENTS.md'));
  await assert.rejects(createSettingsFiles(root3).read('instructions'), /regular file/);
});
test('failed atomic rename preserves original and cleans the temporary file', async () => {
  const root = await home(), files = createSettingsFiles(root);
  const original = await files.save('instructions', { version: 'missing', content: 'original' });
  const broken = createSettingsFiles(root, { ...fs, rename: async () => { throw Error('rename refused'); } });
  await assert.rejects(broken.save('instructions', { version: original.version, content: 'new' }), /rename refused/);
  assert.equal((await files.read('instructions')).content, 'original');
  assert.deepEqual(await fs.readdir(root), ['AGENTS.md']);
});
test('real authenticated HTTP save writes only the throwaway ELPIS_HOME and reports conflicts', async t => {
  const root = await home(), client = new EventEmitter(); client.close = () => {};
  const app = await startDesktopServer({ client, elpisHome: root, loveSpot: { directory: path.join(root, 'love') } });
  t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin;
  const endpoint = origin + '/api/settings/files/instructions';
  assert.equal((await fetch(endpoint)).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: url.hash.slice(7) }) });
  const headers = { Origin: origin, 'Content-Type': 'application/json', Cookie: auth.headers.get('set-cookie').split(';')[0] };
  const initial = await (await fetch(endpoint, { headers })).json();
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ version: initial.version, content: 'HTTP-only evidence فارسی' }) });
  assert.equal(response.status, 200);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'HTTP-only evidence فارسی');
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ version: initial.version, content: 'overwrite' }) })).status, 409);
  const about = await (await fetch(origin + '/api/about', { headers })).json();
  assert.match(about.version, /^\d+\./); assert.match(about.releaseNotes, /releases/);
});
