import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { dismissPersonalTip, openPersonal, personalStatus } from './personal.mts';
import { startDesktopServer } from './server.mts';

async function home(t: TestContext) {
  const root = path.join(os.homedir(), '.cache/elpis-tests');
  await fs.mkdir(root, { recursive: true });
  const dir = createTestTempDir(path.join(root, 'personal-'));
  t.after(() => removeTestTempDir(dir));
  return dir;
}

test('a personal skill is created on first use from the bundled template; edits survive reopening and concurrent opens', async t => {
  const dir = await home(t), status = await personalStatus(dir);
  assert.equal(status.showTip, true);
  await assert.rejects(fs.stat(status.path), { code: 'ENOENT' });
  const opened = await openPersonal(dir);
  assert.equal(opened.showTip, false);
  const template = await fs.readFile(new URL('../../../codex-rs/skills/src/assets/personal/SKILL.md', import.meta.url), 'utf8');
  assert.equal(await fs.readFile(status.path, 'utf8'), template);
  const mine = template + '\nI learn by trying: PERSONAL_EDIT_7319\n';
  await fs.writeFile(status.path, mine);
  await Promise.all([openPersonal(dir), openPersonal(dir)]);
  assert.equal(await fs.readFile(status.path, 'utf8'), mine);
  assert.equal((await personalStatus(dir)).showTip, false);
});

test('dismissal is remembered on disk and never creates the profile', async t => {
  const dir = await home(t);
  assert.equal((await dismissPersonalTip(dir)).showTip, false);
  assert.equal((await personalStatus(dir)).showTip, false);
  await assert.rejects(fs.stat(path.join(dir, 'skills/personal/SKILL.md')), { code: 'ENOENT' });
});

test('personal HTTP actions are authenticated, validated and scoped to the runtime home', async t => {
  const dir = await home(t), client = Object.assign(new EventEmitter(), { close() {}, pendingApprovals: [] });
  const app = await startDesktopServer({ client, elpisHome: dir });
  t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = (route: string, data: unknown, cookie?: string) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  assert.equal((await post('/api/personal', { action: 'open' })).status, 401);
  const setCookie = (await post('/api/session', { token })).headers.get('set-cookie'); assert.ok(setCookie);
  const cookie = setCookie.split(';')[0]!;
  const initial = await fetch(origin + '/api/personal', { headers: { Cookie: cookie } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).showTip, true);
  assert.equal((await post('/api/personal', { action: 'bad' }, cookie)).status, 400);
  assert.equal((await post('/api/personal', { action: 'open', home: '/tmp/elsewhere' }, cookie)).status, 400);
  const opened = await post('/api/personal', { action: 'open' }, cookie);
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { path: path.join(dir, 'skills/personal/SKILL.md'), showTip: false });
  assert.match(await fs.readFile(path.join(dir, 'skills/personal/SKILL.md'), 'utf8'), /Learning method:/);
});
