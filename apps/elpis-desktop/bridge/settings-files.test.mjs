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
test('linked instruction and memory files edit their targets, preserve links and reject drafts from an old target', async () => {
  for (const [kind, relative] of [['instructions', 'AGENTS.md'], ['memory', 'memories/MEMORY.md']]) {
    const root = await home(), outside = await home(), files = createSettingsFiles(root);
    const link = path.join(root, relative), target = path.join(outside, 'shared.md');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.writeFile(target, 'shared rules فارسی'); await fs.symlink(target, link);
    const before = await files.read(kind);
    assert.equal(before.path, target); assert.equal(before.content, 'shared rules فارسی');
    const saved = await files.save(kind, { version: before.version, content: 'updated shared rules' });
    assert.equal(await fs.readFile(target, 'utf8'), saved.content);
    assert.equal(await fs.readlink(link), target);
    assert.deepEqual(await createSettingsFiles(root).read(kind), saved);
    const replacement = path.join(outside, 'replacement.md');
    await fs.writeFile(replacement, saved.content);
    await fs.symlink(replacement, `${link}.new`); await fs.rename(`${link}.new`, link);
    await assert.rejects(files.save(kind, { version: saved.version, content: 'stale draft' }), error => error.status === 409);
    assert.equal(await fs.readFile(replacement, 'utf8'), saved.content);
    assert.equal(await fs.readFile(target, 'utf8'), saved.content);
  }
});
test('broken and cyclic file links report an actionable conflict without replacing the link', async () => {
  for (const cycle of [false, true]) {
    const root = await home(), link = path.join(root, 'AGENTS.md'), files = createSettingsFiles(root);
    const target = cycle ? link : path.join(root, 'missing.md'); await fs.symlink(target, link);
    await assert.rejects(files.read('instructions'), error => error.status === 409 && /link/i.test(error.message));
    await assert.rejects(files.save('instructions', { version: 'missing', content: 'draft' }), error => error.status === 409);
    assert.equal(await fs.readlink(link), target);
    if (!cycle) await assert.rejects(fs.access(target), error => error.code === 'ENOENT');
  }
});
test('stale and concurrent saves refuse overwrite; invalid kind, content, parent links and directories fail', async () => {
  const root = await home(), files = createSettingsFiles(root);
  const original = await files.save('instructions', { version: 'missing', content: 'original' });
  const results = await Promise.allSettled(['first', 'second'].map(content => files.save('instructions', { version: original.version, content })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal((await files.read('instructions')).content, 'first');
  await assert.rejects(files.read('../config.toml'), /Unknown/);
  for (const input of [{ version: original.version, content: null }, { content: 'x' }, { version: original.version, content: 'x', path: '/elsewhere' }]) await assert.rejects(files.save('instructions', input));
  const other = await home(); await fs.symlink(other, path.join(root, 'memories'));
  await assert.rejects(files.save('memory', { version: 'missing', content: 'escape' }), /local directory/);
  assert.deepEqual(await fs.readdir(other), []);
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
  const target = path.join(root, 'shared-rules.md');
  await fs.rename(path.join(root, 'AGENTS.md'), target); await fs.symlink(target, path.join(root, 'AGENTS.md'));
  const linked = await fetch(endpoint, { headers });
  assert.equal(linked.status, 200, 'linked global instructions load through the authenticated Settings route');
  assert.equal((await linked.json()).path, target);
  const about = await (await fetch(origin + '/api/about', { headers })).json();
  assert.match(about.version, /^\d+\./); assert.match(about.releaseNotes, /releases/);
});
