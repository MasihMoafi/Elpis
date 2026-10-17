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
  return { directory, screenshots, request, load, save, origin };
}

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

test('Love Spot inbox merges durably, retains partial JSON, and imports new screenshots only once', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.screenshots, 'old.png'), PNG);
  const stream = await f.request('/events'), reader = stream.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  await f.save({ elements: [element('a', 3)], files: {} });
  await fs.writeFile(path.join(f.directory, 'inbox', 'add.json'), JSON.stringify({ elements: [element('a', 2), element('inbox')] }));
  await fs.writeFile(path.join(f.directory, 'inbox', 'partial.json'), '{');
  await fs.writeFile(path.join(f.screenshots, 'new.png'), PNG.subarray(0, 10));
  await new Promise(resolve => setTimeout(resolve, 300));
  await fs.writeFile(path.join(f.screenshots, 'new.png'), PNG);
  let scene;
  for (let i = 0; i < 30; i++) {
    scene = (await f.load()).scene;
    if (scene.elements.some(e => e.type === 'image') && scene.elements.some(e => e.id === 'inbox')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(scene.elements.find(e => e.id === 'a').version, 3);
  assert.equal(scene.elements.filter(e => e.type === 'image').length, 1);
  assert.equal(Object.values(scene.files)[0].dataURL, `data:image/png;base64,${PNG.toString('base64')}`);
  await assert.rejects(fs.access(path.join(f.directory, 'inbox', 'add.json')));
  assert.equal(await fs.readFile(path.join(f.directory, 'inbox', 'partial.json'), 'utf8'), '{');
  await fs.writeFile(path.join(f.directory, 'inbox', 'partial.json'), JSON.stringify({ elements: [element('finished')] }));
  for (let i = 0; i < 20 && !(await f.load()).scene.elements.some(e => e.id === 'finished'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok((await f.load()).scene.elements.some(e => e.id === 'finished'));
});

test('Love Spot independent processes serialize their merges on the same drawing', async t => {
  const f = await fixture(t);
  const module = new URL('./love-spot-store.cjs', import.meta.url).pathname;
  await Promise.all(Array.from({ length: 8 }, (_, i) => exec(process.execPath, ['-e', `const {createLoveSpot}=require(${JSON.stringify(module)});createLoveSpot({directory:process.argv[1]}).save(JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exitCode=1});`, f.directory, JSON.stringify({ elements: [element(`process-${i}`)], files: {} })])));
  assert.equal((await f.load()).scene.elements.length, 8);
});
