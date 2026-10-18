import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLoveSpot } from './love-spot-store.cjs';
import { createLoveSpotTalk } from './love-spot-talk.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
const note = (id, text, color = '#e03131', extra = {}) => ({ id, type: 'text', text, strokeColor: color, version: 1, versionNonce: 1, x: 20, y: 30, width: 240, height: 40, updated: 1, ...extra });
async function fixture(t) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'love-talk-')), store = createLoveSpot({ directory, screenshots: path.join(directory, 'shots') });
  const client = new EventEmitter(), created = [], sent = [], entries = [];
  Object.assign(client, {
    settings: async () => ({ main: { model: 'luna', provider: 'openai' } }),
    models: async () => ({ data: [{ model: 'luna', inputModalities: ['text', 'image'] }, { model: 'text', inputModalities: ['text'] }], nextCursor: null }),
    createThread: async value => { created.push(value); return { thread: { id: 'chat', ...value } }; },
    readThread: async () => ({ thread: { id: 'chat', name: 'Love Spot', cwd: directory }, data: [...entries].reverse(), nextCursor: null }),
    resume: async () => ({ activeTurnId: null }),
    send: async (id, value) => { sent.push({ id, ...value }); return { turn: { id: `turn-${sent.length}` } }; },
  });
  const talk = createLoveSpotTalk({ client, store });
  t.after(async () => { talk.close(); store.close(); await promisify(execFile)('gio', ['trash', directory]); });
  const finish = (id = 'turn-1', status = 'completed') => client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: 'chat', turn: { id, status, items: [{ id: 'reply', type: 'agentMessage', text: 'Here with you.' }] } } } });
  return { directory, store, talk, client, created, sent, finish, entries };
}
test('Talk creates one persistent normal chat, attributes live notes by colour, includes PNG only for image models', async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note('masih', 'Apricot'), note('agent', 'Blue thought', '#1971c2'), note('gone', 'Do not include', '#e03131', { isDeleted: true })] });
  const { revision } = await f.store.read(); await f.store.picture({ revision, png: PNG });
  await f.talk.send({ text: 'Hello', model: 'luna', revision });
  assert.equal(f.created.length, 1); assert.equal(f.created[0].name, 'Love Spot'); assert.equal(f.created[0].cwd, f.directory);
  const notes = f.sent[0].attachments.find(a => a.type === 'text').text;
  assert.match(notes, /Masih.*Apricot/s); assert.match(notes, /agent.*Blue thought/s); assert.doesNotMatch(notes, /Do not include/);
  assert.equal(f.sent[0].attachments.find(a => a.type === 'image').dataUrl, `data:image/png;base64,${PNG}`);
  f.finish(); await f.talk.idle();
  const current = await f.store.read(); await f.store.picture({ revision: current.revision, png: PNG });
  await f.talk.send({ text: 'Again', model: 'text', revision: current.revision });
  assert.equal(f.created.length, 1); assert.equal(f.sent[1].attachments.some(a => a.type === 'image'), false);
  f.finish('turn-2'); await f.talk.idle();
  f.talk.close(); const second = createLoveSpotTalk({ client: f.client, store: f.store }); t.after(() => second.close());
  await second.read(); await second.send({ text: 'After restart', model: 'text' }); assert.equal(f.created.length, 1);
});
test('replies are blue, unsigned, collision-free, idempotent and saved without a UI subscriber', async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note('masih', 'Newest', '#e03131', { updated: 10 }), note('block', 'Obstacle', '#e03131', { x: 20, y: 100, width: 500, height: 500 })] });
  await f.talk.send({ text: 'Hi', model: 'text' }); f.finish(); f.finish(); await f.talk.idle();
  const scene = (await f.store.read()).scene, reply = scene.elements.find(e => e.text === 'Here with you.');
  assert.ok(reply); assert.equal(reply.strokeColor, '#1971c2'); assert.equal(scene.elements.filter(e => e.text === reply.text).length, 1);
  for (const e of scene.elements.filter(e => e.id !== reply.id)) assert.ok(reply.x + reply.width <= e.x || e.x + e.width <= reply.x || reply.y + reply.height <= e.y || e.y + e.height <= reply.y);
});
test('empty, failed and interrupted replies add nothing; invalid messages and stale pictures fail before send', async t => {
  const f = await fixture(t);
  await assert.rejects(f.talk.send({ text: '   ', model: 'text' })); assert.equal(f.created.length, 0);
  await assert.rejects(f.talk.send({ text: 'Hi', model: 'luna', revision: 'stale' })); assert.equal(f.sent.length, 0);
  await f.talk.send({ text: 'Hi', model: 'text' }); f.finish('turn-1', 'failed'); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.length, 0);
  await f.talk.send({ text: 'Hi again', model: 'text' }); f.finish('turn-2', 'interrupted'); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.length, 0);
});

test('completion before send returns does not leave Talk busy, including empty and failed turns', async t => {
  const f = await fixture(t);
  let number = 0;
  f.client.send = async () => {
    const id = `fast-${++number}`;
    f.client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: 'chat', turn: { id, status: 'completed', items: [] } } } });
    return { turn: { id } };
  };
  assert.equal((await f.talk.send({ text: 'Hello', model: 'text' })).busy, false);
  assert.equal((await f.talk.send({ text: 'Again', model: 'text' })).busy, false);
  assert.equal((await f.store.read()).scene.elements.length, 0);
});

test('simultaneous sends are refused and a missing saved chat is reported without making a duplicate', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'text' });
  await assert.rejects(f.talk.send({ text: 'Duplicate', model: 'text' }), /already replying/);
  assert.equal(f.sent.length, 1);
  f.talk.close(); f.client.readThread = async () => { throw new Error('Chat was deleted'); };
  const next = createLoveSpotTalk({ client: f.client, store: f.store }); t.after(() => next.close());
  await assert.rejects(next.send({ text: 'Hello', model: 'text' }), /Chat was deleted/);
  assert.equal(f.created.length, 1);
});

test('a recorded user item replaces the provisional prompt and only the final answer becomes a note', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'text' });
  for (const item of [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Thinking aloud' },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'The answer' },
  ]) f.client.emit('event', { type: 'message', data: { method: 'item/completed', params: { threadId: 'chat', turnId: 'turn-1', item } } });
  f.client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: 'chat', turn: { id: 'turn-1', status: 'completed', items: [] } } } });
  await f.talk.idle();
  assert.equal((await f.talk.read()).entries.filter(e => e.item.type === 'userMessage').length, 1);
  assert.deepEqual((await f.store.read()).scene.elements.map(e => e.originalText), ['The answer']);
});

test('a reply started on another page stays in Talk and does not write onto the newly selected page', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'About the original page', model: 'text' });
  await f.store.changePage({ action: 'new', name: 'Quiet' });
  f.finish(); await f.talk.idle();
  assert.deepEqual((await f.store.read()).scene.elements, []);
  const chat = await f.talk.read();
  assert.ok(chat.entries.some(e => e.item.text === 'Here with you.'));
  assert.match(chat.error, /page changed/i);
});
