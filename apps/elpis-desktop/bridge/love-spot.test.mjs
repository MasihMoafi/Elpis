import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from './server.mjs';
import { createLoveSpot } from './love-spot-store.cjs';

const FAKE_ACP_AGENT = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));

const exec = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const element = (id, version = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: 100, x: 0, y: 0, width: 100, height: 80, ...extra });
async function fixture(t, { loveAgents } = {}) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'love-spot-'));
  const directory = path.join(root, 'drawing'), screenshots = path.join(root, 'Screenshots');
  await fs.mkdir(screenshots);
  const client = new EventEmitter(); Object.assign(client, { connected: true, pendingApprovals: [], close() {} });
  const app = await startDesktopServer({ client, loveSpot: { directory, screenshots }, trashFile: path.join(root, 'trash.json'), ...(loveAgents ? { loveAgents } : {}) });
  t.after(async () => { await app.close(); await exec('gio', ['trash', root]); });
  const url = new URL(app.url), origin = url.origin;
  const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: url.hash.slice(7) }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const request = (suffix = '', data, headers = {}) => fetch(`${origin}/api/love-spot${suffix}`, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'content-type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const load = async () => { const reply = await request(); assert.equal(reply.status, 200); return reply.json(); };
  const save = async scene => { const reply = await request('', scene); assert.equal(reply.status, 200); return reply.json(); };
  return { directory, screenshots, request, load, save, origin, client };
}

test('Love Spot agent routes authenticate, run the saved drawing over ACP and answer its permission request', async t => {
  // The card runs as an ACP agent process: the scripted SDK agent, which logs what reaches it.
  const log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'love-route-')), 'agent.jsonl');
  const nodeSpec = node => ({ name: node.name, command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: log, FAKE_ACP_NAME: 'route' }, instructions: node.prompt });
  const f = await fixture(t, { loveAgents: { nodeSpec } });
  for (const route of ['run', 'permission']) assert.equal((await fetch(`${f.origin}/api/love-spot/agents/${route}`, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'agent' }) })).status, 401);
  await f.save({ elements: [element('agent', 1, { customData: { loveAgent: { name: 'Writer', preset: 'writer', model: 'gpt-6-luna', provider: 'openai', prompt: 'Be precise', task: '[permission] Route seed' } } })], files: {} });
  assert.equal((await f.request('/agents/run', { id: 'agent', unknown: true })).status, 400);
  assert.equal((await f.request('/agents/run', { id: 'agent', cwd: 'relative' })).status, 400);
  assert.equal((await f.request('/agents/permission', { id: 'agent', optionId: 'allow_once' })).status, 409, 'nothing is waiting yet');
  await assert.rejects(fs.access(log), 'no agent started for a refused request');
  const running = f.request('/agents/run', { id: 'agent' });
  const card = async () => (await f.load()).scene.elements[0].customData.loveAgent;
  while ((await card()).status !== 'waiting') await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await card()).permission.title, 'Write notes.txt');
  assert.equal((await f.request('/agents/permission', { id: 'agent', optionId: 'made-up' })).status, 400);
  assert.equal((await f.request('/agents/permission', { id: 'agent', optionId: 'allow_once' })).status, 200);
  const reply = await running;
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).results[0].output, 'route(default) answered: permission: allow_once. [permission] Route seed');
  const saved = await card();
  assert.deepEqual([saved.status, saved.sessionId, saved.permission], ['completed', 'route-session-1', null]);
  assert.deepEqual(JSON.parse((await fs.readFile(log, 'utf8')).split('\n').find(line => line.includes('"session/new"'))).params._meta, { systemPrompt: { append: 'Be precise' } });
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

test('text flush reaches its archived page without changing the page another window selected', async t => {
  const f = await fixture(t), original = (await f.load()).scene.page;
  const next = await (await f.request('/pages', { action: 'new', page: original })).json();
  const text = element('verdict', 3, { type: 'text', text: 'My final verdict', originalText: 'My final verdict' });
  const saved = await f.request('/text', { page: original, elements: [text] });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).scene.elements[0].text, text.text);
  assert.equal((await f.load()).scene.page.session, next.scene.page.session);
  assert.equal((await f.load()).scene.elements.length, 0, 'old text must not enter the new page');
  assert.equal((await f.request('/text', { page: original, elements: [element('shape')] })).status, 400);
  assert.equal((await f.request('/text', { page: { ...original, session: 'unrelated' }, elements: [text] })).status, 409);
});

test('two Love Spot stores converge on equal-version deletes in either order, but allow newer undo and redo', async t => {
  const f = await fixture(t);
  const other = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => other.close());
  for (const [index, [deleteFirst, liveNonce, deletedNonce]] of [
    [true, 1, 900], [false, 1, 900], [true, 900, 1], [false, 900, 1], [true, 100, 100], [false, 100, 100],
  ].entries()) {
    const id = `conflict-${index}`;
    const live = element(id, 2, { isDeleted: false, versionNonce: liveNonce });
    const deleted = { ...live, isDeleted: true, versionNonce: deletedNonce };
    const page = (await f.load()).scene.page;
    const fromElpis = e => f.save({ elements: [e], files: {}, page });
    const fromStandalone = e => other.save({ elements: [e], files: {}, page });
    await fromElpis(deleteFirst ? deleted : live);
    await fromStandalone(deleteFirst ? live : deleted);
    assert.equal((await other.read()).scene.elements.find(e => e.id === id).isDeleted, true,
      `delete must win: deleteFirst=${deleteFirst}, liveNonce=${liveNonce}, deletedNonce=${deletedNonce}`);
    await fromStandalone({ ...live, version: 1, versionNonce: 0 });
    assert.equal((await f.load()).scene.elements.find(e => e.id === id).isDeleted, true);
    await fromElpis({ ...live, version: 3 });
    assert.equal((await other.read()).scene.elements.find(e => e.id === id).isDeleted, false, 'newer undo must restore');
    await fromStandalone({ ...deleted, version: 4 });
    assert.equal((await f.load()).scene.elements.find(e => e.id === id).isDeleted, true, 'newer redo must delete');
  }
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

test('Love Spot cached bootstrap skips loaded bytes and still sends changed scenes and stale-cache recovery', { timeout: 10000 }, async t => {
  const f = await fixture(t), initial = await f.save({ elements: [element('cached')], files: {} });
  const reader = (await f.request(`/events?revision=${initial.revision}`)).body.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder(), first = decoder.decode((await reader.read()).value);
  assert.ok(first.includes('"type":"screenshots"'));
  assert.ok(first.includes('id: love-spot'), 'metadata must identify a future reconnect');
  assert.equal(first.includes('"type":"scene"'), false);
  const changed = await f.save({ elements: [element('only-the-update-can-know-this')], files: {} });
  let update = '';
  while (!update.includes('only-the-update-can-know-this')) update += decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(update.includes(changed.revision));
  const stale = (await f.request(`/events?revision=${initial.revision}`)).body.getReader();
  t.after(() => stale.cancel());
  assert.ok(decoder.decode((await stale.read()).value).includes('only-the-update-can-know-this'));
});

test('Love Spot cached bootstrap rejects invalid hints and always refreshes a reconnect', async t => {
  const f = await fixture(t), initial = await f.save({ elements: [element('reconnect')], files: {} });
  for (const suffix of ['/events?revision=bad', '/events?revision=', `/events?revision=${initial.revision}&revision=${initial.revision}`]) {
    assert.equal((await f.request(suffix)).status, 400);
  }
  const reader = (await f.request(`/events?revision=${initial.revision}`, undefined, { 'last-event-id': 'love-spot' })).body.getReader();
  t.after(() => reader.cancel());
  const message = new TextDecoder().decode((await reader.read()).value);
  assert.ok(message.includes('"type":"scene"'), 'reconnect must refresh even if the API cache and original hint have the same hash');
  assert.ok(message.includes(initial.revision));
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
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.view-revision', 'inbox', 'pages', 'scene.excalidraw', 'view.png']);
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

test('Love Spot watcher does not reread an unchanged drawing and delivers external replacements', async t => {
  const f = await fixture(t);
  await f.save({ elements: [element('large', 1, { text: 'x'.repeat(2_000_000) })], files: {} });
  const file = path.join(f.directory, 'scene.excalidraw'), original = fs.readFile.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'readFile', (...args) => { if (args[0] === file) reads++; return original(...args); });
  const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots }), events = [];
  t.after(() => store.close());
  await store.watch(event => events.push(event));
  await new Promise(resolve => setTimeout(resolve, 350));
  const settled = reads;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(reads, settled, 'idle ticks must stat without reading or hashing the drawing');
  await fs.writeFile(`${file}.replacement`, JSON.stringify({ elements: [element('external')], files: {} }));
  await fs.rename(`${file}.replacement`, file);
  for (let i = 0; i < 30 && !events.some(e => e.scene?.elements.some(e => e.id === 'external')); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(events.some(e => e.scene?.elements.some(e => e.id === 'external')));
  assert.equal(reads, settled + 1, 'one changed file needs one read');
});

test('Love Spot pages discover archives, preserve drawings, rename, and reject delayed saves across switches', async t => {
  const f = await fixture(t), first = await f.save({ elements: [element('original')], files: {} });
  await fs.mkdir(path.join(f.directory, 'pages'), { recursive: true });
  await fs.writeFile(path.join(f.directory, 'pages', '2026-10-18-morning.excalidraw'), JSON.stringify({ elements: [element('archived')], files: {} }));
  const listing = await f.request('/pages');
  assert.equal(listing.status, 200);
  assert.ok((await listing.json()).pages.some(p => p.name === '2026-10-18-morning' && Number.isFinite(p.modified)));
  const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots }), events = [];
  t.after(() => store.close()); await store.watch(e => events.push(e));
  const created = await f.request('/pages', { action: 'new', name: 'Ideas', page: first.scene.page });
  assert.equal(created.status, 200);
  const fresh = await created.json();
  assert.deepEqual(fresh.scene.elements, []);
  assert.equal(fresh.scene.page.name, 'Ideas');
  assert.equal((await f.request('', first.scene)).status, 409, 'a delayed old-window save must never mix pages');
  await f.save({ ...fresh.scene, elements: [element('new-page')] });
  assert.equal((await f.request('/pages', { action: 'rename', name: 'Ideas renamed', page: fresh.scene.page })).status, 200);
  assert.ok((await fs.readdir(path.join(f.directory, 'pages'))).includes('Ideas renamed.excalidraw'));
  assert.ok(!(await fs.readdir(path.join(f.directory, 'pages'))).includes('Ideas.excalidraw'));
  const archive = await f.request('/pages', { action: 'switch', name: '2026-10-18-morning' });
  assert.equal(archive.status, 200);
  assert.equal((await archive.json()).scene.elements[0].id, 'archived');
  for (let i = 0; i < 30 && !events.some(e => e.scene?.page?.name === '2026-10-18-morning'); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(events.some(e => e.scene?.page?.name === '2026-10-18-morning'), 'another store process sees the page switch');
  const original = await f.request('/pages', { action: 'switch', name: first.scene.page.name });
  assert.equal((await original.json()).scene.elements[0].id, 'original');
  assert.equal((await f.request('', first.scene)).status, 409, 'returning to the same page still rejects an earlier visit');
  const renamed = await f.request('/pages', { action: 'switch', name: 'Ideas renamed' });
  assert.equal((await renamed.json()).scene.elements[0].id, 'new-page');
});

test('Love Spot pages reject unsafe names, collisions, and corrupt archives without changing the drawing', async t => {
  const f = await fixture(t);
  const saved = await f.save({ elements: [element('safe')], files: {} });
  for (const name of ['../escape', '/tmp/escape', '', 'a/b', 'a\\b', '.', 'x'.repeat(101)]) {
    assert.equal((await f.request('/pages', { action: 'new', name })).status, 400, name);
  }
  assert.equal((await f.request('/pages', { action: 'new', name: saved.scene.page.name })).status, 409);
  assert.equal((await f.request('/pages', { action: 'switch', name: 'missing' })).status, 404);
  await fs.writeFile(path.join(f.directory, 'pages', 'broken.excalidraw'), '{');
  assert.equal((await f.request('/pages', { action: 'switch', name: 'broken' })).status, 409);
  assert.equal((await f.load()).revision, saved.revision);
});

test('Love Spot saves prune unused image files, keep live references, and accept undo with retained editor files', async t => {
  const f = await fixture(t);
  const image = element('image', 1, { type: 'image', fileId: 'pixels' });
  const pixels = { id: 'pixels', mimeType: 'image/png', dataURL: `data:image/png;base64,${PNG.toString('base64')}` };
  await f.save({ elements: [image], files: { pixels, unused: { ...pixels, id: 'unused' } } });
  assert.deepEqual(Object.keys((await f.load()).scene.files), ['pixels']);
  await f.save({ elements: [{ ...image, version: 2, isDeleted: true }], files: { pixels } });
  assert.deepEqual((await f.load()).scene.files, {});
  await f.save({ elements: [image], files: { pixels } });
  assert.deepEqual((await f.load()).scene.files, {}, 'a stale live version cannot retain deleted image bytes');
  await f.save({ elements: [{ ...image, version: 3 }], files: { pixels } });
  assert.equal((await f.load()).scene.files.pixels.dataURL, pixels.dataURL);
  await fs.writeFile(path.join(f.directory, 'pages', 'Unused archive.excalidraw'), JSON.stringify({ elements: [], files: { pixels } }));
  const selected = await f.request('/pages', { action: 'switch', name: 'Unused archive' });
  assert.deepEqual((await selected.json()).scene.files, {}, 'switching an archive also saves only live image references');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'pages', 'Unused archive.excalidraw'), 'utf8')).files, {});
});
