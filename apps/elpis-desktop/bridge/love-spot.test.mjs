import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { startDesktopServer } from './server.mjs';

const exec = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const element = (id, version = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: 100, x: 0, y: 0, width: 100, height: 80, ...extra });
async function fixture(t) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'love-spot-'));
  const directory = path.join(root, 'drawing'), screenshots = path.join(root, 'Screenshots');
  await fs.mkdir(screenshots);
  const client = new EventEmitter(); Object.assign(client, { connected: true, pendingApprovals: [], close() {} });
  const app = await startDesktopServer({ client, loveSpot: { directory, screenshots }, trashFile: path.join(root, 'trash.json') });
  t.after(async () => { await app.close(); await exec('gio', ['trash', root]); });
  const url = new URL(app.url), origin = url.origin;
  const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: url.hash.slice(7) }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const request = (suffix = '', data) => fetch(`${origin}/api/love-spot${suffix}`, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const load = async () => { const reply = await request(); assert.equal(reply.status, 200); return reply.json(); };
  const save = async scene => { const reply = await request('', scene); assert.equal(reply.status, 200); return reply.json(); };
  return { directory, screenshots, request, load, save, origin, client };
}

test('Love Spot agent route authenticates, reads the saved drawing, and persists chat results', async t => {
  const f = await fixture(t), calls = [];
  Object.assign(f.client, {
    models: async () => ({ data: [{ model: 'gpt-6-luna' }] }),
    createThread: async body => { calls.push(body); return { thread: { id: 'real-route-chat' } }; },
    send: async id => {
      f.client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: id, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'Only the real route knows this answer' }] } } } });
      return { turn: { id: 'route-turn' } };
    },
  });
  assert.equal((await fetch(`${f.origin}/api/love-spot/agents/run`, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'agent' }) })).status, 401);
  await f.save({ elements: [element('agent', 1, { customData: { loveAgent: { name: 'Writer', preset: 'writer', model: 'gpt-6-luna', provider: 'openai', prompt: 'Be precise', task: 'Route seed' } } })], files: {} });
  assert.equal((await f.request('/agents/run', { id: 'agent', unknown: true })).status, 400);
  assert.equal((await f.request('/agents/run', { id: 'agent', cwd: 'relative' })).status, 400);
  assert.equal(calls.length, 0);
  const reply = await f.request('/agents/run', { id: 'agent' });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).results[0].output, 'Only the real route knows this answer');
  assert.equal((await f.load()).scene.elements[0].customData.loveAgent.threadId, 'real-route-chat');
});

test('Love Spot load/save unions stale windows, keeps newest versions and deletion tombstones', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.load()).scene.elements, []);
  await Promise.all([f.save({ elements: [element('a')], files: {} }), f.save({ elements: [element('b')], files: {} })]);
  await f.save({ elements: [element('a', 3, { isDeleted: true })], files: {} });
  await f.save({ elements: [element('a', 2)], files: {} });
  const { scene } = await f.load();
  assert.deepEqual(scene.elements.map(e => e.id).sort(), ['a', 'b']);
  assert.equal(scene.elements.find(e => e.id === 'a').isDeleted, true);
  await f.save({ elements: [element('b', 1, { versionNonce: 1, x: 123 })], files: {} });
  assert.equal((await f.load()).scene.elements.find(e => e.id === 'b').x, 123);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'scene.excalidraw'), 'utf8')).elements.length, 2);
});

test('Love Spot rejects malformed saves and leaves an unreadable existing scene intact', async t => {
  const f = await fixture(t);
  await f.save({ elements: [element('safe')], files: {} });
  for (const value of [null, {}, { elements: [{}] }, { elements: [], files: [] }, { elements: [element('a', NaN)], files: {} }]) assert.equal((await f.request('', value)).status, 400);
  assert.equal((await f.load()).scene.elements[0].id, 'safe');
  await fs.writeFile(path.join(f.directory, 'scene.excalidraw'), '{unfinished');
  assert.equal((await f.request('', { elements: [], files: {} })).status, 409);
  assert.equal(await fs.readFile(path.join(f.directory, 'scene.excalidraw'), 'utf8'), '{unfinished');
  assert.equal((await fetch(`${f.origin}/api/love-spot`)).status, 401);
});

test('Love Spot picture requires the current revision and PNG bytes', async t => {
  const f = await fixture(t), a = await f.save({ elements: [element('a')], files: {} });
  assert.equal((await f.request('/picture', { revision: a.revision, png: PNG.toString('base64') })).status, 200);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'view.png')), PNG);
  await f.save({ elements: [element('b')], files: {} });
  assert.equal((await f.request('/picture', { revision: a.revision, png: PNG.toString('base64') })).status, 409);
  assert.equal((await f.request('/picture', { revision: (await f.load()).revision, png: 'not a PNG' })).status, 400);
});

test('Love Spot inbox merges durably and retains partial JSON', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.screenshots, 'old.png'), PNG);
  const stream = await f.request('/events'), reader = stream.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  await f.save({ elements: [element('a', 3)], files: {} });
  await fs.writeFile(path.join(f.directory, 'inbox', 'add.json'), JSON.stringify({ elements: [element('a', 2), element('inbox')] }));
  await fs.writeFile(path.join(f.directory, 'inbox', 'partial.json'), '{');
  let scene;
  for (let i = 0; i < 30; i++) {
    scene = (await f.load()).scene;
    if (scene.elements.some(e => e.id === 'inbox')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(scene.elements.find(e => e.id === 'a').version, 3);
  for (let i = 0; i < 30 && await fs.stat(path.join(f.directory, 'inbox', 'add.json')).catch(() => false); i++) await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(fs.access(path.join(f.directory, 'inbox', 'add.json')));
  assert.equal(await fs.readFile(path.join(f.directory, 'inbox', 'partial.json'), 'utf8'), '{');
  await fs.writeFile(path.join(f.directory, 'inbox', 'partial.json'), JSON.stringify({ elements: [element('finished')] }));
  for (let i = 0; i < 20 && !(await f.load()).scene.elements.some(e => e.id === 'finished'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok((await f.load()).scene.elements.some(e => e.id === 'finished'));
});

async function screenshotFixture(t) {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.screenshots, 'old.png'), PNG);
  const saved = await f.save({ elements: [element('existing-image', 1, { type: 'image' })], files: {} });
  await f.request('/picture', { revision: saved.revision, png: PNG.toString('base64') });
  const events = [], reader = (await f.request('/events')).body.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder(); let buffer = '';
  void (async () => {
    while (true) {
      const { done, value } = await reader.read(); if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        if (event.startsWith('data: ')) events.push(JSON.parse(event.slice(6)));
      }
    }
  })().catch(() => {});
  const tray = async () => {
    const response = await f.request('/screenshots'); assert.equal(response.status, 200);
    return (await response.json()).screenshots;
  };
  const wait = async check => {
    for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail('screenshot watcher did not settle');
  };
  return { ...f, saved, events, tray, wait };
}

test('new screenshots remain private in memory, newest first, without changing scene, inbox or picture', async t => {
  const f = await screenshotFixture(t), before = await fs.readFile(path.join(f.directory, 'scene.excalidraw'));
  await fs.writeFile(path.join(f.screenshots, 'partial.png'), PNG.subarray(0, 10));
  await fs.writeFile(path.join(f.screenshots, 'first.png'), PNG);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'scene.excalidraw')), before);
  await fs.writeFile(path.join(f.screenshots, 'latest.png'), PNG);
  await f.wait(async () => (await f.tray()).length === 2);
  const shots = await f.tray();
  assert.deepEqual(shots.map(s => s.name), ['latest.png', 'first.png']);
  assert.equal(shots[0].dataURL, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'view.png')), PNG);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'inbox')), []);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.view-revision', 'inbox', 'scene.excalidraw', 'view.png']);
  await fs.writeFile(path.join(f.screenshots, 'partial.png'), PNG);
  await f.wait(async () => (await f.tray()).length === 3);
  assert.ok(f.events.some(e => e.type === 'screenshots' && e.screenshots.length));
  assert.ok(f.events.filter(e => e.type === 'scene').every(e => e.scene.elements.length === 1));
});

test('placing a private screenshot uses the existing import geometry and consumes it for all windows', async t => {
  const f = await screenshotFixture(t);
  await fs.writeFile(path.join(f.screenshots, 'chosen.png'), PNG);
  await f.wait(async () => (await f.tray()).length === 1);
  const [shot] = await f.tray();
  const reader = (await f.request('/events')).body.getReader(); t.after(() => reader.cancel());
  const decoder = new TextDecoder(); let initial = '';
  while (!initial.includes('"type":"screenshots"')) initial += decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(initial.includes(shot.id), 'a second window receives the same private tray');
  await fs.unlink(path.join(f.screenshots, 'chosen.png')); // Placement uses the captured bytes.
  assert.equal((await f.request('/screenshots', { id: shot.id, action: 'place' })).status, 200);
  const { scene } = await f.load(), image = scene.elements.find(e => e.id === shot.id);
  assert.equal(image.type, 'image'); assert.equal(image.y, 140); assert.equal(image.width, 8);
  assert.equal(scene.files[image.fileId].dataURL, shot.dataURL);
  assert.ok(scene.elements.some(e => e.id === 'existing-image'));
  assert.deepEqual(await f.tray(), []);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'view.png')), PNG);
  assert.equal((await f.request('/screenshots', { id: shot.id, action: 'place' })).status, 404);
  assert.equal((await f.load()).scene.elements.length, 2);
});

test('dismissed screenshots stay dismissed and leave all shared files unchanged', async t => {
  const f = await screenshotFixture(t), before = await fs.readFile(path.join(f.directory, 'scene.excalidraw'));
  await fs.writeFile(path.join(f.screenshots, 'private.png'), PNG);
  await f.wait(async () => (await f.tray()).length === 1);
  const [shot] = await f.tray();
  assert.equal((await f.request('/screenshots', null)).status, 400);
  assert.equal((await f.request('/screenshots', { id: shot.id, action: 'other' })).status, 400);
  assert.equal((await f.request('/screenshots', { id: '../private.png', action: 'place' })).status, 404);
  assert.equal((await f.request('/screenshots', { id: shot.id, action: 'dismiss' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(await f.tray(), []);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'scene.excalidraw')), before);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'view.png')), PNG);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'inbox')), []);
});

test('Love Spot independent processes serialize their merges on the same drawing', async t => {
  const f = await fixture(t);
  const module = new URL('./love-spot-store.cjs', import.meta.url).pathname;
  await Promise.all(Array.from({ length: 8 }, (_, i) => exec(process.execPath, ['-e', `const {createLoveSpot}=require(${JSON.stringify(module)});createLoveSpot({directory:process.argv[1]}).save(JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exitCode=1});`, f.directory, JSON.stringify({ elements: [element(`process-${i}`)], files: {} })])));
  assert.equal((await f.load()).scene.elements.length, 8);
});
