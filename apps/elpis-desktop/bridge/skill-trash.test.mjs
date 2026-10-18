import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
import { SkillTrash } from './skill-trash.mjs';

async function fixture(t) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, 'skill-trash-'));
  const root = path.join(home, 'skills'), calls = [];
  const skills = [];
  for (const [name, scope, pluginId] of [['own', 'user'], ['project', 'repo'], ['built-in', 'system'], ['managed', 'admin'], ['plugin', 'user', 'docs@local']]) {
    const file = path.join(root, name, 'SKILL.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nname: ${name}\ndescription: Throwaway test skill\n---\nTest content\n`);
    await fs.writeFile(path.join(path.dirname(file), 'notes.txt'), 'Companion file');
    skills.push({ name, scope, pluginId, path: file, enabled: true });
  }
  const socket = new EventEmitter(); socket.close = () => {};
  socket.send = raw => {
    const request = JSON.parse(raw); calls.push(request);
    const result = request.method === 'skills/list' ? { data: [{ cwd: home, skills: skills.filter(skill => existsSync(skill.path)), errors: [] }] }
      : request.method === 'plugin/installed' ? { marketplaces: [] } : { config: {} };
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket, { rewindHome: path.join(home, 'rewind'),
    githubConnector: { snapshot: async () => ({ name: 'GitHub', enabled: false, transport: 'gh' }) },
    skillTrashOptions: { env: { ...process.env, XDG_DATA_HOME: path.join(home, 'data') } } });
  t.after(() => client.close());
  return { home, root, client, skills, calls };
}

test('owned user and project folders go to the real GIO Trash and Undo restores their bytes; list is refreshed', async t => {
  const f = await fixture(t);
  for (const name of ['own', 'project']) {
    const skill = f.skills.find(skill => skill.name === name), before = await fs.readFile(skill.path, 'utf8');
    const result = await f.client.deleteSkill({ path: skill.path, cwd: f.home });
    assert.equal(result.skills.data.some(item => item.path === skill.path), false);
    await assert.rejects(fs.stat(path.dirname(skill.path)), { code: 'ENOENT' });
    assert.ok(result.deleted.token);
    const restored = await f.client.undoSkillDelete({ token: result.deleted.token, cwd: f.home });
    assert.equal(await fs.readFile(skill.path, 'utf8'), before);
    assert.equal(await fs.readFile(path.join(path.dirname(skill.path), 'notes.txt'), 'utf8'), 'Companion file');
    assert.ok(restored.skills.data.some(item => item.path === skill.path));
    await assert.rejects(f.client.undoSkillDelete({ token: result.deleted.token }), /Undo|expired/i);
  }
  assert.ok(f.calls.filter(call => call.method === 'skills/list').length >= 6);
  assert.ok(f.calls.filter(call => call.method === 'skills/list').every(call => call.params.forceReload === true));
});

test('built-in, admin, plugin and unknown scopes have no delete capability and cannot be trashed', async t => {
  const f = await fixture(t);
  f.skills.push({ ...f.skills[0], name: 'unknown', scope: 'future', path: f.skills[0].path.replace('/own/', '/unknown/') });
  await fs.mkdir(path.dirname(f.skills.at(-1).path)); await fs.writeFile(f.skills.at(-1).path, 'protected');
  const snapshot = await f.client.customize(f.home);
  for (const skill of f.skills.filter(skill => !['own', 'project'].includes(skill.name))) {
    assert.equal(snapshot.skills.data.find(item => item.path === skill.path).deletable, false);
    await assert.rejects(f.client.deleteSkill({ path: skill.path }), /turned off|protected|owned/i);
    assert.ok(await fs.stat(skill.path));
  }
});

test('delete refuses unlisted paths, traversal, symlink folders/files and changes after listing', async t => {
  const f = await fixture(t), own = f.skills[0];
  const outside = path.join(f.home, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'SKILL.md'), 'outside');
  const link = path.join(f.root, 'escape'); await fs.symlink(outside, link);
  f.skills.push({ ...own, path: path.join(link, 'SKILL.md') });
  const fileLink = path.join(f.root, 'file-link'); await fs.mkdir(fileLink); await fs.symlink(path.join(outside, 'SKILL.md'), path.join(fileLink, 'SKILL.md'));
  f.skills.push({ ...own, path: path.join(fileLink, 'SKILL.md') });
  for (const file of [path.join(outside, 'SKILL.md'), `${f.root}/own/../../outside/SKILL.md`, path.join(link, 'SKILL.md'), path.join(fileLink, 'SKILL.md'), f.root, 'relative/SKILL.md']) {
    await assert.rejects(f.client.deleteSkill({ path: file }), /listed|path|root|symbolic|symlink|folder/i);
  }
  await fs.rename(path.dirname(own.path), path.join(f.home, 'moved'));
  await fs.symlink(outside, path.dirname(own.path));
  await assert.rejects(f.client.deleteSkill({ path: own.path }), /symlink|symbolic|root/i);
  assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), 'outside');
});

test('Undo refuses a forged token and never overwrites a recreated skill', async t => {
  const f = await fixture(t), skill = f.skills[0];
  await assert.rejects(f.client.undoSkillDelete({ token: '../../outside' }), /Undo|expired/i);
  const result = await f.client.deleteSkill({ path: skill.path });
  await fs.mkdir(path.dirname(skill.path)); await fs.writeFile(skill.path, 'replacement');
  await assert.rejects(f.client.undoSkillDelete({ token: result.deleted.token }), /exists|restore/i);
  assert.equal(await fs.readFile(skill.path, 'utf8'), 'replacement');
});

test('expired Undo leaves the entire skill folder safely in Trash', async t => {
  const f = await fixture(t), skill = f.skills[0];
  let now = 0;
  const trash = new SkillTrash({ env: { ...process.env, XDG_DATA_HOME: path.join(f.home, 'data') }, now: () => now });
  const deleted = await trash.delete(skill.path, [{ ...skill, plugin: null }]);
  now = 60001;
  await assert.rejects(trash.undo(deleted.token), /expired/);
  await assert.rejects(fs.stat(skill.path), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.home, 'data/Trash/files/own/notes.txt'), 'utf8'), 'Companion file');
});

test('a folder containing another listed skill cannot be deleted along with it', async t => {
  const f = await fixture(t), skill = f.skills[0];
  const nested = path.join(path.dirname(skill.path), 'bundled/SKILL.md');
  await fs.mkdir(path.dirname(nested)); await fs.writeFile(nested, 'protected');
  f.skills.push({ ...skill, scope: 'system', path: nested });
  await assert.rejects(f.client.deleteSkill({ path: skill.path }), /other listed skills/);
  assert.equal(await fs.readFile(nested, 'utf8'), 'protected');
});

test('Trash collisions, spaces, percent signs and non-ASCII folder names restore the exact skill', async t => {
  const f = await fixture(t), name = 'مهارت 100% $(echo shell)';
  const paths = ['user', 'project'].map(scope => path.join(f.home, scope, 'skills', name, 'SKILL.md'));
  for (const [index, file] of paths.entries()) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `Skill ${index}`);
    f.skills.push({ name, path: file, scope: index ? 'repo' : 'user', enabled: true });
  }
  const first = await f.client.deleteSkill({ path: paths[0] }), second = await f.client.deleteSkill({ path: paths[1] });
  await f.client.undoSkillDelete({ token: second.deleted.token });
  await f.client.undoSkillDelete({ token: first.deleted.token });
  for (const [index, file] of paths.entries()) assert.equal(await fs.readFile(file, 'utf8'), `Skill ${index}`);
});

test('skill Trash HTTP routes require an app session and reject extra fields', async t => {
  const f = await fixture(t);
  const app = await startDesktopServer({ client: f.client, staticDir: f.home, trashFile: path.join(f.home, 'chats.json'), elpisHome: f.home,
    loveSpot: { directory: path.join(f.home, 'drawing'), screenshots: path.join(f.home, 'screenshots') } });
  t.after(() => app.close());
  const url = new URL(app.url), post = (route, body, cookie) => fetch(url.origin + route, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/customize/skill/delete', { path: f.skills[0].path })).status, 401);
  const auth = await post('/api/session', { token: new URLSearchParams(url.hash.slice(1)).get('token') });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/customize/skill/delete', { path: f.skills[0].path, root: '/' }, cookie)).status, 400);
  const deleted = await post('/api/customize/skill/delete', { path: f.skills[0].path }, cookie);
  assert.equal(deleted.status, 200);
  assert.equal((await post('/api/customize/skill/undo', { token: (await deleted.json()).deleted.token }, cookie)).status, 200);
});
