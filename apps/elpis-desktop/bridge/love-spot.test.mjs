import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from './server.mjs';
import { createLoveSpot } from './love-spot-store.cjs';

const FAKE_ACP_AGENT = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));

const exec = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const element = (id, version = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: 100, x: 0, y: 0, width: 100, height: 80, ...extra });

test('only a brand-new Love Spot board gets the handwritten welcome and heart', async t => {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const root = createTestTempDir(path.join(base, 'love-spot-welcome-'));
  const screenshots = path.join(root, 'Screenshots');
  const fresh = createLoveSpot({ directory: path.join(root, 'fresh'), screenshots });
  const emptyDirectory = path.join(root, 'saved-empty'), empty = createLoveSpot({ directory: emptyDirectory, screenshots });
  const savedDirectory = path.join(root, 'saved'), saved = createLoveSpot({ directory: savedDirectory, screenshots });
  const archivedDirectory = path.join(root, 'archived'), archived = createLoveSpot({ directory: archivedDirectory, screenshots });
  const handDrawn = { id: 'hand-drawn', type: 'line', x: 1, y: 2, width: 8, height: 9, points: [[0, 0], [8, 9]], version: 1, versionNonce: 1 };
  await fs.mkdir(emptyDirectory, { recursive: true });
  await fs.writeFile(path.join(emptyDirectory, 'scene.excalidraw'), JSON.stringify({ elements: [], files: {}, appState: {} }));
  await fs.mkdir(savedDirectory, { recursive: true });
  await fs.writeFile(path.join(savedDirectory, 'scene.excalidraw'), JSON.stringify({ elements: [handDrawn], files: {}, appState: {} }));
  await fs.mkdir(path.join(archivedDirectory, 'pages'), { recursive: true });
  await fs.writeFile(path.join(archivedDirectory, 'pages', 'Original.excalidraw'), JSON.stringify({ elements: [], files: {}, appState: {} }));
  t.after(async () => { await Promise.all([fresh.close(), empty.close(), saved.close(), archived.close()]); removeTestTempDir(root); });

  const first = (await fresh.read()).scene;
  const welcome = first.elements.find(e => e.type === 'text');
  const heart = first.elements.find(e => e.type === 'line');
  assert.equal(welcome?.text, 'Welcome to Love Spot');
  assert.equal(welcome.fontFamily, 5, 'the welcome uses the board handwriting');
  assert.equal(welcome.strokeColor, '#000000');
  assert.equal(heart?.strokeColor, '#e03131');
  assert.ok(heart.points.length >= 8, 'the heart is drawn as a hand-shaped path');
  assert.deepEqual(heart.points[0], heart.points.at(-1), 'the hand-drawn heart closes');
  assert.deepEqual((await empty.read()).scene.elements, [], 'a saved empty board stays empty');
  assert.deepEqual((await saved.read()).scene.elements, [handDrawn], 'saved board content is left alone');
  assert.deepEqual((await archived.read()).scene.elements, [], 'a missing current file with saved pages is not a new store');
});

async function fixture(t, { loveAgents, prepareScreenshots } = {}) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const root = createTestTempDir(path.join(base, 'love-spot-'));
  const directory = path.join(root, 'drawing'), screenshots = path.join(root, 'Screenshots');
  await fs.mkdir(directory); await fs.mkdir(screenshots);
  await fs.writeFile(path.join(directory, 'scene.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} }));
  if (prepareScreenshots) await prepareScreenshots(screenshots);
  const client = new EventEmitter(); Object.assign(client, { connected: true, pendingApprovals: [], close() {} });
  const app = await startDesktopServer({ client, loveSpot: { directory, screenshots }, trashFile: path.join(root, 'trash.json'), ...(loveAgents ? { loveAgents } : {}) });
  t.after(async () => { await app.close(); removeTestTempDir(root); });
  const url = new URL(app.url), origin = url.origin;
  const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: url.hash.slice(7) }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const request = (suffix = '', data, headers = {}) => fetch(`${origin}/api/love-spot${suffix}`, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'content-type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const load = async () => { const reply = await request(); assert.equal(reply.status, 200); return reply.json(); };
  const save = async scene => { const reply = await request('', scene); assert.equal(reply.status, 200); return reply.json(); };
  return { directory, screenshots, request, load, save, origin, client };
}

test('normal Love Spot chat turns receive portrait choices without changing other chats', async t => {
  const f = await fixture(t);
  await f.load();
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, '.love-spot-chat.json'), JSON.stringify({ threadId: 'love-chat' }));
  const sent = [];
  f.client.send = async (id, body) => { sent.push({ id, body }); return { turn: { id: 'turn-portrait' } }; };
  for (const id of ['love-chat', 'other-chat']) {
    const response = await f.request(`/../threads/${id}/turns`, { text: 'Hello', attachments: [] });
    assert.equal(response.status, 200);
  }
  assert.match(sent[0].body.attachments.find(item => item.id === 'matilda-portrait').text, /kissPuckered/);
  assert.deepEqual(sent[1].body.attachments, []);
});

test('Love Spot agent routes authenticate and run saved drawing agents over ACP without waiting for tool approval', async t => {
  // The card runs as an ACP agent process: the scripted SDK agent, which logs what reaches it.
  const logRoot = createTestTempDir(path.join(os.tmpdir(), 'love-route-'));
  t.after(() => removeTestTempDir(logRoot));
  const log = path.join(logRoot, 'agent.jsonl');
  const nodeSpec = node => ({ name: node.name, command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: log, FAKE_ACP_NAME: 'route' }, instructions: node.prompt });
  const f = await fixture(t, { loveAgents: { nodeSpec, timeoutMs: 10000 } });
  for (const route of ['run', 'permission']) assert.equal((await fetch(`${f.origin}/api/love-spot/agents/${route}`, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'agent' }) })).status, 401);
  await f.save({ elements: [element('agent', 1, { customData: { loveAgent: { name: 'Writer', preset: 'writer', model: 'gpt-6-luna', provider: 'openai', prompt: 'Be precise', task: '[permission] Route seed' } } })], files: {} });
  assert.equal((await f.request('/agents/run', { id: 'agent', unknown: true })).status, 400);
  assert.equal((await f.request('/agents/run', { id: 'agent', cwd: 'relative' })).status, 400);
  assert.equal((await f.request('/agents/permission', { id: 'agent', optionId: 'allow_once' })).status, 409, 'nothing is waiting yet');
  await assert.rejects(fs.access(log), 'no agent started for a refused request');
  const reply = await f.request('/agents/run', { id: 'agent' });
  const card = async () => (await f.load()).scene.elements[0].customData.loveAgent;
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).results[0].output, 'route(default) answered: permission: allow_once. [permission] Route seed');
  const saved = await card();
  assert.deepEqual([saved.status, saved.sessionId, saved.permission], ['completed', 'route-session-1', null]);
  const messages = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(messages.filter(message => message.permission).map(message => message.permission), [{ outcome: 'selected', optionId: 'allow_once' }], 'the automatic permission is delivered to the ACP process exactly once');
  assert.deepEqual(messages.find(message => message.method === 'session/new').params._meta, { systemPrompt: { append: 'Be precise' } });
  for (const optionId of ['made-up', 'allow_once']) assert.equal((await f.request('/agents/permission', { id: 'agent', optionId })).status, 409, 'an old client cannot answer a permission an automatic agent already settled');
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
  const f = await fixture(t, { prepareScreenshots: screenshots => fs.writeFile(path.join(screenshots, 'old.png'), PNG) });
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

test('screenshots are captured before any event subscriber and between visits without sharing them', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.screenshots, 'before-visit.png'), PNG);
  await new Promise(resolve => setTimeout(resolve, 400));
  const tray = async () => (await (await f.request('/screenshots')).json()).screenshots;
  assert.deepEqual((await tray()).map(s => s.name), ['before-visit.png']);
  assert.equal((await f.load()).scene.elements.length, 0);
  const reader = (await f.request('/events')).body.getReader(); await reader.read(); await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 100));
  await fs.writeFile(path.join(f.screenshots, 'between-visits.png'), PNG);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual((await tray()).map(s => s.name).sort(), ['before-visit.png', 'between-visits.png']);
  assert.equal((await f.load()).scene.elements.length, 0);
});

test('opening Love Spot reports a background screenshot error and clearing it resumes capture', async t => {
  const f = await fixture(t), store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => store.close()); await store.start();
  // A directory at the metadata file path produces a real read failure.
  const blocked = path.join(f.directory, '.screenshot-choices.json');
  await fs.mkdir(blocked, { recursive: true });
  await fs.writeFile(path.join(f.screenshots, 'retry-after-error.png'), PNG);
  await new Promise(resolve => setTimeout(resolve, 400));
  const events = []; await store.watch(event => events.push(event));
  assert.ok(events.some(e => e.type === 'error' && e.message === 'Love Spot could not sync the drawing.'), 'a background failure must be visible when the board opens');
  await fs.rmdir(blocked);
  for (let i = 0; i < 40 && !store.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(store.screenshotsList()[0]?.name, 'retry-after-error.png', 'capture must retry without dropping the new screenshot');
  assert.equal((await store.read()).scene.elements.length, 0);
  let recovered = [];
  for (let i = 0; i < 40; i++) {
    recovered = []; const unwatch = await store.watch(event => recovered.push(event)); unwatch();
    if (!recovered.some(e => e.type === 'error')) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(recovered.some(e => e.type === 'error'), false, 'a recovered error must not follow a later subscriber');
});

test('unavailable private IPC keeps local capture working, reports the failure and retries sharing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'love-ipc-failure-'));
  const directory = path.join(root, 'drawing'), screenshots = path.join(root, 'Screenshots'); await fs.mkdir(directory); await fs.mkdir(screenshots);
  await fs.writeFile(path.join(directory, 'scene.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} }));
  const store = createLoveSpot({ directory, screenshots });
  let other;
  t.after(async () => { await store.close(); if (other) await other.close(); await fs.rm(root, { recursive: true, force: true }); });
  const mkdir = fs.mkdir.bind(fs);
  const blocked = t.mock.method(fs, 'mkdir', async (file, ...args) => {
    if (path.basename(file).startsWith('elpis-shots-')) throw Object.assign(new Error('Test private IPC unavailable'), { code: 'EACCES' });
    return mkdir(file, ...args);
  });
  const events = []; await store.watch(event => events.push(event));
  await fs.writeFile(path.join(screenshots, 'local-during-ipc-failure.png'), PNG);
  for (let i = 0; i < 40 && !store.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(store.screenshotsList()[0]?.name, 'local-during-ipc-failure.png');
  assert.ok(events.some(e => e.type === 'error' && /screenshot trays/.test(e.message)), 'the unavailable connection must be visible');
  blocked.mock.restore();
  other = createLoveSpot({ directory, screenshots }); await other.start();
  for (let i = 0; i < 100 && !other.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(other.screenshotsList()[0]?.name, 'local-during-ipc-failure.png', 'sharing must resume without losing the pending screenshot');
  assert.equal((await store.read()).scene.elements.length, 0);
});

test('independent screenshot watchers consume one choice across page switches and keep dismissals private', async t => {
  const f = await fixture(t);
  const a = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  const b = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => { a.close(); b.close(); });
  await a.watch(() => {}); await b.watch(() => {});
  const wait = async check => {
    for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail('independent screenshot watchers did not settle');
  };
  await fs.writeFile(path.join(f.screenshots, 'placed-once.png'), PNG);
  await wait(() => a.screenshotsList().length === 1 && b.screenshotsList().length === 1);
  const shot = a.screenshotsList()[0];
  await assert.rejects(a.chooseScreenshot({ id: shot.id, action: 'place', dataURL: 'data:text/plain;base64,cHJpdmF0ZQ==' }), /Invalid drawing image/);
  assert.equal(a.screenshotsList().length, 1, 'a refused import must retain the private screenshot for retry');
  assert.equal((await a.read()).scene.elements.length, 0);
  await a.chooseScreenshot({ id: shot.id, action: 'place' });
  await wait(() => b.screenshotsList().length === 0);
  await a.changePage({ action: 'new', name: 'Next page' });
  await assert.rejects(b.chooseScreenshot({ id: shot.id, action: 'place' }), /already left/);
  assert.equal((await b.read()).scene.elements.length, 0, 'a stale tray cannot place the same screenshot on another page');
  await fs.writeFile(path.join(f.screenshots, 'dismiss-everywhere.png'), PNG);
  await wait(() => a.screenshotsList().length === 1 && b.screenshotsList().length === 1);
  await b.chooseScreenshot({ id: b.screenshotsList()[0].id, action: 'dismiss' });
  await wait(() => a.screenshotsList().length === 0);
  assert.equal((await a.read()).scene.elements.length, 0);
  assert.ok(JSON.parse(await fs.readFile(path.join(f.directory, '.screenshot-choices.json'), 'utf8')).every(id => /^shot-[a-f0-9]{32}$/.test(id)), 'choice metadata contains no screenshot names or pixels');
});

test('a later Love Spot process receives private pending screenshots from the already running app', async t => {
  const f = await fixture(t), a = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => a.close());
  await a.watch(() => {});
  await fs.writeFile(path.join(f.screenshots, 'before-second-app.png'), PNG);
  for (let i = 0; i < 40 && !a.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(a.screenshotsList().length, 1);
  const script = `const {createLoveSpot}=require(process.argv[1]); (async()=>{
    const b=createLoveSpot({directory:process.argv[2],screenshots:process.argv[3]});
    try { await b.start(); for(let i=0;i<40&&!b.screenshotsList().length;i++)await new Promise(r=>setTimeout(r,30));
      console.log(JSON.stringify({shots:b.screenshotsList(),scene:(await b.read()).scene}));
    } finally { await b.close(); }
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = JSON.parse((await exec(process.execPath, ['-e', script, fileURLToPath(new URL('./love-spot-store.cjs', import.meta.url)), f.directory, f.screenshots])).stdout);
  assert.deepEqual(result.shots, a.screenshotsList(), 'a new process must not classify the other app\'s pending screenshot as old');
  assert.equal(result.scene.elements.length, 0);
});

test('a later app receives a private screenshot backlog larger than one IPC response', async t => {
  const f = await fixture(t), store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => store.close());
  let captured = 0; await store.watch(e => { if (e.type === 'screenshots') captured = e.screenshots.length; });
  // A valid ancillary PNG text chunk exercises transport size without huge pixel dimensions.
  const data = Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(10 * 1024 * 1024, 'x')]);
  const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8);
  chunk.writeUInt32BE((await import('node:zlib')).crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const png = Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
  const expected = Array.from({ length: 7 }, (_, i) => `backlog-${i}.png`);
  await Promise.all(expected.map(name => fs.writeFile(path.join(f.screenshots, name), png)));
  for (let i = 0; i < 100 && captured < expected.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(captured, expected.length);
  const script = `const {createLoveSpot}=require(process.argv[1]); (async()=>{
    const b=createLoveSpot({directory:process.argv[2],screenshots:process.argv[3]}); let names=[];
    try { await b.watch(e=>{if(e.type==='screenshots')names=e.screenshots.map(s=>s.name)});
      for(let i=0;i<150&&names.length<7;i++)await new Promise(r=>setTimeout(r,100));
      console.log(JSON.stringify({names,shared:(await b.read()).scene.elements.length}));
    } finally { await b.close(); }
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = JSON.parse((await exec(process.execPath, ['-e', script, fileURLToPath(new URL('./love-spot-store.cjs', import.meta.url)), f.directory, f.screenshots])).stdout);
  assert.deepEqual(result.names.sort(), expected, 'every pending screenshot must arrive in the later process');
  assert.equal(result.shared, 0);
});

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
  const module = fileURLToPath(new URL('./love-spot-store.cjs', import.meta.url));
  await Promise.all(Array.from({ length: 8 }, (_, i) => exec(process.execPath, ['-e', `const {createLoveSpot}=require(${JSON.stringify(module)});createLoveSpot({directory:process.argv[1]}).save(JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exitCode=1});`, f.directory, JSON.stringify({ elements: [element(`process-${i}`)], files: {} })])));
  assert.equal((await f.load()).scene.elements.length, 8);
});

for (const barrier of ['owner-read', 'owner-unlink', 'empty-claim']) test(`a stale lock waiter cannot reap its live successor after ${barrier}`, { timeout: 15000 }, async t => {
  const f = await fixture(t), module = fileURLToPath(new URL('./love-spot-store.cjs', import.meta.url));
  const script = `
    const fs = require('node:fs/promises'), [directory, role, barrier] = process.argv.slice(1);
    const { createLoveSpot } = require(${JSON.stringify(module)});
    const proceed = new Promise(resolve => process.once('message', resolve));
    const read = fs.readFile, write = fs.writeFile, unlink = fs.unlink, open = fs.open, kill = process.kill;
    let held = false;
    fs.open = async (...args) => {
      if (barrier === 'empty-claim' && args[1] === 'wx' && String(args[0]).endsWith('/owner') && role === 'waiter' && !held) {
        held = true; process.send('before-claim'); await proceed;
      }
      const handle = await open(...args);
      if (barrier === 'empty-claim' && args[1] === 'wx' && String(args[0]).endsWith('/owner') && role === 'successor' && !held) {
        held = true; process.send('owns'); await proceed;
      }
      return handle;
    };
    fs.readFile = async (...args) => {
      const value = await read(...args);
      if (role === 'waiter' && barrier === 'owner-read' && String(args[0]).endsWith('/owner') && !held) {
        held = true; process.send('read-old'); await proceed;
      }
      return value;
    };
    fs.writeFile = async (...args) => {
      const result = await write(...args);
      if (String(args[0]).endsWith('/.scene-lock/owner')) {
        process.send('owns');
        if (['first', 'successor'].includes(role) && !held) { held = true; await proceed; }
      }
      return result;
    };
    fs.unlink = async (...args) => {
      if (role === 'waiter' && barrier === 'owner-unlink' && String(args[0]).endsWith('/owner') && !held) {
        held = true; process.send('before-unlink'); await proceed;
      }
      return unlink(...args);
    };
    process.kill = (...args) => { const result = kill(...args); process.send('probed-live'); return result; };
    createLoveSpot({ directory }).save({ elements: [{ id: role, type: 'rectangle', version: 1, versionNonce: 0, x: 0, y: 0, width: 10, height: 10 }], files: {} })
      .then(() => process.disconnect()).catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
  `;
  const worker = role => {
    const child = spawn(process.execPath, ['-e', script, f.directory, role, barrier], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = []; let stderr = '';
    child.on('message', value => messages.push(value)); child.stderr.on('data', data => { stderr += data; });
    const exit = new Promise(resolve => child.once('exit', code => resolve({ code, stderr })));
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const wait = async choices => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const message = messages.find(value => choices.includes(value));
        if (message) return message;
        if (child.exitCode !== null) throw Error(`Lock worker ${role} exited: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw Error(`Lock worker ${role} did not report ${choices}`);
    };
    return { child, exit, wait };
  };
  const first = worker('first'); await first.wait(['owns']);
  let waiter;
  if (barrier === 'owner-read') {
    waiter = worker('waiter'); await waiter.wait(['read-old']);
    first.child.send('continue'); assert.equal((await first.exit).code, 0);
  } else {
    first.child.send('continue'); assert.equal((await first.exit).code, 0);
    const lock = path.join(f.directory, '.scene-lock');
    await fs.mkdir(lock);
    if (barrier === 'owner-unlink') await fs.writeFile(path.join(lock, 'owner'), String(first.child.pid));
    else { const old = new Date(Date.now() - 31000); await fs.utimes(lock, old, old); }
    waiter = worker('waiter'); await waiter.wait([barrier === 'owner-unlink' ? 'before-unlink' : 'before-claim']);
    if (barrier === 'owner-unlink') { const cleaner = worker('cleaner'); assert.equal((await cleaner.exit).code, 0); }
  }
  const successor = worker('successor'); await successor.wait(['owns']);
  waiter.child.send('continue');
  assert.equal(await waiter.wait(['owns', 'probed-live']), 'probed-live', 'a stale PID observation must not steal a live successor lock');
  if (barrier === 'empty-claim') assert.equal(await fs.readFile(path.join(f.directory, '.scene-lock/owner'), 'utf8'), '', 'a failed claimant must leave the winning claim intact');
  successor.child.send('continue');
  for (const result of await Promise.all([successor.exit, waiter.exit])) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.load()).scene.elements.map(e => e.id).sort(), (barrier === 'owner-unlink' ? ['cleaner', 'first', 'successor', 'waiter'] : ['first', 'successor', 'waiter']));
});

test('empty locks retain their grace and busy timeout, then recover without losing saved elements', { timeout: 15000 }, async t => {
  const f = await fixture(t), lock = path.join(f.directory, '.scene-lock');
  await f.save({ elements: [element('kept')], files: {} });
  await fs.mkdir(lock);
  const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots }), started = Date.now();
  await assert.rejects(store.save({ elements: [element('pending')], files: {} }), error => error.status === 503 && /drawing is busy/.test(error.message));
  assert.ok(Date.now() - started >= 5000, 'a fresh empty lock keeps the existing five-second timeout');
  assert.deepEqual((await f.load()).scene.elements.map(e => e.id), ['kept']);
  const old = new Date(Date.now() - 31000); await fs.utimes(lock, old, old);
  await store.save({ elements: [element('pending')], files: {} });
  assert.deepEqual((await f.load()).scene.elements.map(e => e.id).sort(), ['kept', 'pending']);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

// 19 Oct 17:11: a crash between creating the owner file and writing its pid left it empty. Number('') is 0, and
// process.kill(0, 0) succeeds, so the lock looked owned forever and every save said "The drawing is busy".
test('a lock whose owner file is empty is recovered after the same grace', { timeout: 15000 }, async t => {
  const f = await fixture(t), lock = path.join(f.directory, '.scene-lock');
  await f.save({ elements: [element('kept')], files: {} });
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner'), '');
  const old = new Date(Date.now() - 31000); await fs.utimes(path.join(lock, 'owner'), old, old); await fs.utimes(lock, old, old);
  const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  await store.save({ elements: [element('pending')], files: {} });
  assert.deepEqual((await f.load()).scene.elements.map(e => e.id).sort(), ['kept', 'pending']);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('Love Spot watcher does not reread an unchanged drawing and delivers external replacements', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'love-watcher-'));
  const directory = path.join(root, 'drawing'), screenshots = path.join(root, 'Screenshots');
  await fs.mkdir(screenshots);
  const store = createLoveSpot({ directory, screenshots }), events = [];
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await store.save({ elements: [element('large', 1, { text: 'x'.repeat(2_000_000) })], files: {} });
  const file = path.join(directory, 'scene.excalidraw'), original = fs.readFile.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'readFile', (...args) => { if (args[0] === file) reads++; return original(...args); });
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

test('the page list is in one stable order, newest number first, whatever was edited last', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.directory, 'pages'), { recursive: true });
  for (const [index, name] of ['Page 8', 'Page 12', 'Page 9', 'Page 11', 'Page 10'].entries()) {
    const file = path.join(f.directory, 'pages', `${name}.excalidraw`);
    await fs.writeFile(file, JSON.stringify({ elements: [], files: {} }));
    await fs.utimes(file, new Date(2026, 9, 22, 8, index), new Date(2026, 9, 22, 8, index)); // touched in an order unlike their numbers
  }
  const names = (await (await f.request('/pages')).json()).pages.map(page => page.name).filter(name => name.startsWith('Page '));
  assert.deepEqual(names, ['Page 12', 'Page 11', 'Page 10', 'Page 9', 'Page 8']);
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

// 29 Oct, Masih on the dark board: "This is matilda in dark mode!" Her saved SVG face showed as a negative there.
test('opening a board replaces her older faces with the raster one and keeps a custom portrait', async t => {
  const { BOARD_FACE, FACE_DATA_URL, PORTRAIT_DATA_URL } = (await import('./matilda-face.cjs')).default;
  for (const [saved, mimeType, wanted] of [[FACE_DATA_URL, 'image/svg+xml', BOARD_FACE], [PORTRAIT_DATA_URL, 'image/webp', BOARD_FACE], [`data:image/png;base64,${PNG.toString('base64')}`, 'image/png', null]]) {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { recursive: true });
    const face = { id: 'love-face-turn-1', type: 'image', fileId: 'matilda-face', version: 1, versionNonce: 1, x: 0, y: 0, width: 96, height: 96 };
    await fs.writeFile(path.join(f.directory, 'scene.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, elements: [face], appState: {}, files: { 'matilda-face': { id: 'matilda-face', dataURL: saved, mimeType, created: 1 } } }));
    const file = (await f.load()).scene.files['matilda-face'];
    assert.deepEqual({ dataURL: file.dataURL, mimeType: file.mimeType }, wanted ?? { dataURL: saved, mimeType }, mimeType);
  }
});

test('pages not kept go to the trash after a week untouched; kept pages and the open page stay', async t => {
  const fsp = (await import('node:fs/promises')).default, pathm = (await import('node:path')).default, osm = (await import('node:os')).default;
  const { createLoveSpot } = await import('./love-spot-store.cjs');
  const { createTestTempDir, removeTestTempDir } = await import('../tests/temp-root.cjs');
  const base = pathm.join(osm.homedir(), '.cache/elpis-tests'); await fsp.mkdir(base, { recursive: true });
  const directory = createTestTempDir(pathm.join(base, 'love-pages-'));
  t.after(() => removeTestTempDir(directory));
  await fsp.writeFile(pathm.join(directory, 'scene.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, elements: [], files: {}, appState: {}, page: { name: 'Open', session: 's' } }));
  await fsp.mkdir(pathm.join(directory, 'pages'));
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const name of ['Old note', 'Old kept', 'Fresh']) await fsp.writeFile(pathm.join(directory, 'pages', `${name}.excalidraw`), JSON.stringify({ type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} }));
  for (const name of ['Old note', 'Old kept']) await fsp.utimes(pathm.join(directory, 'pages', `${name}.excalidraw`), old / 1000, old / 1000);
  const store = createLoveSpot({ directory, screenshots: pathm.join(directory, 'shots') });
  t.after(() => store.close());
  // The rule's first run: old pages get their week from today, not at once.
  let listed = await store.listPages();
  assert.deepEqual(listed.pages.map(p => p.name).sort(), ['Fresh', 'Old kept', 'Old note', 'Open']);
  const page = (await store.read()).scene.page;
  await store.changePage({ action: 'keep', name: 'Old kept', page });
  listed = await store.listPages();
  assert.equal(listed.pages.find(p => p.name === 'Old kept').kept, true);
  assert.ok(listed.pages.find(p => p.name === 'Old note').expires > Date.now(), 'an unkept page shows when it will leave');
  // A week after the rule began.
  const life = JSON.parse(await fsp.readFile(pathm.join(directory, '.page-lifecycle.json'), 'utf8'));
  await fsp.writeFile(pathm.join(directory, '.page-lifecycle.json'), JSON.stringify({ ...life, since: old }));
  listed = await store.listPages();
  assert.deepEqual(listed.pages.map(p => p.name).sort(), ['Fresh', 'Old kept', 'Open'], 'only the old page nobody kept left');
});
