import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createLoveSpot } from './love-spot-store.cjs';
import { createLoveSpotTalk } from './love-spot-talk.mjs';
import { createMatildaCompanion } from './matilda-companion.mjs';
import { LOVE_SPOT_AUDIO } from '../lib/love-spot-audio.mjs';
import { splitPainting } from './love-spot-painting.cjs';

const enabledAudio = { available: true };

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
const note = (id, text, color = '#e03131', extra = {}) => ({ id, type: 'text', text, strokeColor: color, version: 1, versionNonce: 1, x: 20, y: 30, width: 240, height: 40, updated: 1, ...extra });
async function fixture(t, { refuseFast = false, audio = enabledAudio, companion = false } = {}) {
  const base = os.tmpdir();
  const directory = createTestTempDir(path.join(base, 'love-talk-')), store = createLoveSpot({ directory, screenshots: path.join(directory, 'shots') });
  const client = new EventEmitter(), created = [], sent = [], entries = [], speeds = [];
  Object.assign(client, {
    settings: async () => ({ main: { model: 'luna', provider: 'openai' } }),
    voiceStatus: async () => ({ available: true, voice: 'juniper' }),
    models: async () => ({ data: [{ model: 'luna', inputModalities: ['text', 'image'] }, { model: 'text', inputModalities: ['text'] }], nextCursor: null }),
    createThread: async value => { created.push(value); return { thread: { id: 'chat', ...value } }; },
    readThread: async () => ({ thread: { id: 'chat', name: 'Love Spot', cwd: directory }, data: [...entries].reverse(), nextCursor: null }),
    resume: async () => ({ activeTurnId: null }),
    send: async (id, value) => { sent.push({ id, ...value }); return { turn: { id: `turn-${sent.length}` } }; },
    setServiceTier: async (id, value) => { speeds.push({ id, ...value }); if (refuseFast) throw Error('no Fast here'); return { serviceTier: 'priority' }; },
  });
  const presence = companion ? createMatildaCompanion({ store, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-matilda-test' } }) : undefined;
  const talk = createLoveSpotTalk({ client, store, audio, companion: presence });
  t.after(async () => { talk.close(); store.close(); removeTestTempDir(directory); });
  const finish = (id = 'turn-1', status = 'completed', reply = 'Here with you.') => client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: 'chat', turn: { id, status, items: [{ id: 'reply', type: 'agentMessage', text: reply }] } } } });
  return { directory, store, talk, client, created, sent, finish, entries, speeds, presence };
}
test('board commands attach actual action results to the normal reply without treating discussion as a command', async t => {
  const f = await fixture(t, { companion: true, audio: LOVE_SPOT_AUDIO });
  await f.talk.send({ text: 'Matilda, pin yourself.', model: 'text' });
  const result = f.sent[0].attachments.find(a => a.name === 'Matilda action result.txt');
  assert.match(result.text, /"ok":true/);
  assert.equal((await f.presence.read('settings')).pinned, true);
  f.finish(); await f.talk.idle();
  await f.talk.send({ text: 'Could you add a pin button?', model: 'text' });
  assert.equal(f.sent[1].attachments.some(a => a.name === 'Matilda action result.txt'), false);
  f.finish('turn-2'); await f.talk.idle();
  await f.talk.send({ text: 'play my favorite music', model: 'text' });
  assert.match(f.sent[2].attachments.find(a => a.name === 'Matilda action result.txt').text, /"ok":false/);
});

test('text-only Matilda never reads voice preferences or status and still delivers board replies', async t => {
  const f = await fixture(t, { audio: LOVE_SPOT_AUDIO });
  const preferences = path.join(f.directory, '.voice.json'), saved = '{legacy malformed voice preference';
  await fs.writeFile(preferences, saved);
  let preferenceReads = 0, statusReads = 0;
  f.store.voice = async () => { preferenceReads++; throw Error('Retired voice preferences must not be loaded'); };
  f.client.voiceStatus = async () => { statusReads++; throw Error('Retired voice status must not be queried'); };
  const unavailable = { enabled: false, available: false, reason: LOVE_SPOT_AUDIO.reason, error: '' };
  assert.deepEqual((await f.talk.read()).voice, unavailable);
  assert.deepEqual(await f.talk.voice(), unavailable);
  await f.talk.send({ text: 'Keep writing', model: 'text' });
  f.finish('turn-1', 'completed', 'The text reply still arrives.'); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.find(element => element.id === 'love-reply-turn-1').originalText, 'The text reply still arrives.');
  for (const action of [() => f.talk.setVoice({ enabled: true }), () => f.talk.speech(), () => f.talk.conversation('Be kind.')]) {
    await assert.rejects(action(), error => error.status === 403 && error.message === LOVE_SPOT_AUDIO.reason);
  }
  assert.deepEqual([preferenceReads, statusReads], [0, 0], 'startup, writing and refused audio actions never touch disabled audio');
  assert.deepEqual((await f.talk.read()).voice, unavailable);
  assert.equal(await fs.readFile(preferences, 'utf8'), saved, 'the fallback preserves saved preferences byte for byte');
});

test('Talk creates one persistent normal chat, attributes live notes by colour, includes PNG only for image models', async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note('masih', 'Apricot'), note('agent', 'Blue thought', '#1971c2'), note('love-reply-saved', 'Black reply', '#000000'), note('user-black', 'Black user note', '#000000'), note('gone', 'Do not include', '#e03131', { isDeleted: true })] });
  const { revision } = await f.store.read(); await f.store.picture({ revision, png: PNG });
  await f.talk.send({ text: 'Hello', model: 'luna', revision });
  assert.equal(f.created.length, 1); assert.equal(f.created[0].name, 'Love Spot'); assert.equal(f.created[0].cwd, f.directory);
  assert.equal(f.created[0].automatic, true, 'board replies use the automatic-agent default');
  assert.equal(f.sent[0].automatic, true, 'existing board conversations also use that default');
  const notes = f.sent[0].attachments.find(a => a.type === 'text').text;
  assert.match(notes, /Masih.*Apricot/s); assert.match(notes, /agent.*Blue thought/s); assert.doesNotMatch(notes, /Do not include/);
  const attributed = JSON.parse(notes.split('\n')[1]);
  assert.equal(attributed.find(n => n.text === 'Black reply').author, 'agent');
  assert.equal(attributed.find(n => n.text === 'Black user note').author, 'Masih');
  assert.equal(f.sent[0].attachments.find(a => a.type === 'image').dataUrl, `data:image/png;base64,${PNG}`);
  f.finish(); await f.talk.idle();
  const current = await f.store.read(); await f.store.picture({ revision: current.revision, png: PNG });
  await f.talk.send({ text: 'Again', model: 'text', revision: current.revision });
  assert.equal(f.created.length, 1); assert.equal(f.sent[1].attachments.some(a => a.type === 'image'), false);
  f.finish('turn-2'); await f.talk.idle();
  f.talk.close(); const second = createLoveSpotTalk({ client: f.client, store: f.store, audio: enabledAudio }); t.after(() => second.close());
  await second.read(); await second.send({ text: 'After restart', model: 'text' }); assert.equal(f.created.length, 1);
});
test('Talk is Matilda: who she is goes with every message, and only as text she can read', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'text', persona: 'Masih\'s partner.' });
  assert.match(f.created[0].instructions, /You are Matilda/); assert.match(f.created[0].instructions, /```excalidraw/);
  assert.deepEqual(f.sent[0].attachments.filter(a => a.name === 'Who you are.txt').map(a => [a.type, a.text]), [['text', 'Masih\'s partner.']]);
  f.finish(); await f.talk.idle();
  await f.talk.send({ text: 'Again', model: 'text', persona: 'A maths tutor.' });
  assert.equal(f.sent[1].attachments.find(a => a.name === 'Who you are.txt').text, 'A maths tutor.');
  assert.equal(f.sent[1].attachments[0].name, 'Love Spot notes.txt', 'the board notes stay first');
  f.finish('turn-2'); await f.talk.idle();
  await f.talk.send({ text: 'No persona sent', model: 'text' }); assert.equal(f.sent[2].attachments.some(a => a.name === 'Who you are.txt'), false);
  f.finish('turn-3'); await f.talk.idle();
  await assert.rejects(f.talk.send({ text: 'Hi', model: 'text', persona: 'x'.repeat(4001) }), /persona/i); assert.equal(f.sent.length, 3);
});
const flower = [{ type: 'ellipse', x: 20, y: 0, width: 24, height: 24, strokeColor: '#e03131', backgroundColor: '#ffc9c9' }, { type: 'line', points: [[32, 24], [32, 80]], strokeColor: '#2f9e44' }, { type: 'text', x: 0, y: 84, text: 'for you' }];
test('reopening a recorded painting repairs legacy arrow origins while preserving moved arrows and deletions', async t => {
  const f = await fixture(t, { audio: LOVE_SPOT_AUDIO });
  const source = shapes => '```excalidraw\n' + JSON.stringify(shapes) + '\n```';
  const rectangle = { type: 'rectangle', x: 10, y: 20, width: 200, height: 60 };
  const broken = splitPainting(source([rectangle, { type: 'arrow', points: [[0, 0], [0, 40]] }])).shapes;
  const recorded = source([rectangle, { type: 'arrow', x: 110, y: 80, points: [[0, 0], [0, 40]] }]);
  await f.store.chat(async () => 'chat');
  for (const turnId of ['legacy', 'moved', 'deleted']) {
    await f.store.reply(turnId, 'Drawing', () => true, undefined, broken);
    if (turnId === 'legacy') {
      f.entries.push({ turnId, item: { id: 'part-one', type: 'agentMessage', text: source([rectangle]) } }, { turnId, item: { id: 'part-two', type: 'agentMessage', text: source([{ type: 'arrow', x: 110, y: 80, points: [[0, 0], [0, 40]] }]) } });
    } else f.entries.push({ turnId, item: { id: 'reply-' + turnId, type: 'agentMessage', text: recorded } });
  }
  const drawing = await f.store.read();
  const moved = drawing.scene.elements.find(e => e.id === 'love-paint-moved-1');
  const deleted = drawing.scene.elements.find(e => e.id === 'love-paint-deleted-1');
  await f.store.save({ ...drawing.scene, elements: [{ ...moved, x: moved.x + 13, version: 2, versionNonce: 2 }, { ...deleted, isDeleted: true, version: 2, versionNonce: 2 }] });
  const before = await f.store.read();
  await f.talk.read();
  const after = await f.store.read(), rect = after.scene.elements.find(e => e.id === 'love-paint-legacy-0'), arrow = after.scene.elements.find(e => e.id === 'love-paint-legacy-1');
  assert.deepEqual([arrow.x - rect.x, arrow.y - rect.y], [100, 60]);
  for (const id of ['love-paint-moved-1', 'love-paint-deleted-1']) assert.deepEqual(after.scene.elements.find(e => e.id === id), before.scene.elements.find(e => e.id === id));
  await f.talk.read(); assert.deepEqual(await f.store.read(), after);
});
test('Matilda paints: a fenced excalidraw block is drawn beneath her note, checked, grouped, and kept out of the note and the panel', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'text' });
  const reply = `A flower for you.\n\n\`\`\`excalidraw\n${JSON.stringify([...flower, { type: 'rocket' }, { type: 'ellipse', strokeColor: 'red; drop table' }])}\n\`\`\``;
  f.finish('turn-1', 'completed', reply); await f.talk.idle();
  const scene = (await f.store.read()).scene, note = scene.elements.find(e => e.id === 'love-reply-turn-1');
  assert.equal(note.text, 'A flower for you.'); assert.doesNotMatch(note.originalText, /excalidraw|ellipse/);
  const painted = scene.elements.filter(e => e.id.startsWith('love-paint-turn-1-'));
  assert.deepEqual(painted.map(e => e.type), ['ellipse', 'line', 'text', 'ellipse'], 'an unknown shape type is skipped; a bad colour falls back');
  assert.equal(painted[3].strokeColor, '#e03131'); assert.equal(painted[0].strokeColor, '#e03131'); assert.equal(painted[0].backgroundColor, '#ffc9c9');
  assert.deepEqual(painted[1].points, [[0, 0], [0, 56]]); assert.ok(painted.every(e => e.groupIds[0] === 'love-paint-turn-1'), 'one group, so it moves as one');
  assert.ok(Math.min(...painted.map(e => e.y)) >= note.y + note.height, 'beneath the note');
  assert.doesNotMatch(JSON.stringify((await f.talk.read()).entries), /excalidraw/, 'the panel shows the note only');
});
test('a painting without a note is still drawn once; a broken or oversized block draws what it can and never breaks the reply', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Draw me something', model: 'text' });
  f.finish('turn-1', 'completed', `\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\``); f.finish('turn-1', 'completed', `\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\``); await f.talk.idle();
  let scene = (await f.store.read()).scene;
  assert.equal(scene.elements.filter(e => e.type === 'text' && e.id.startsWith('love-reply-')).length, 0, 'no empty note');
  assert.equal(scene.elements.filter(e => e.id.startsWith('love-paint-turn-1-')).length, 3, 'drawn once, though the turn finished twice');
  await f.talk.send({ text: 'Again', model: 'text' });
  f.finish('turn-2', 'completed', 'Still here.\n\n```excalidraw\n{not json'); await f.talk.idle();
  scene = (await f.store.read()).scene; assert.equal(scene.elements.find(e => e.id === 'love-reply-turn-2').text, 'Still here.');
  await f.talk.send({ text: 'Lots', model: 'text' });
  f.finish('turn-3', 'completed', `Many.\n\n\`\`\`excalidraw\n${JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ type: 'rectangle', x: i, y: i })))}\n\`\`\``); await f.talk.idle();
  scene = (await f.store.read()).scene; assert.equal(scene.elements.filter(e => e.id.startsWith('love-paint-turn-3-')).length, 60, 'at most 60 shapes');
});
test('her face sits beside every reply as one image of one file, moves with the note and the painting, and stays clear of the board', async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note('masih', 'Newest', '#e03131', { updated: 10 })] });
  await f.talk.send({ text: 'Hi', model: 'text' }); f.finish('turn-1', 'completed', `Here.\n\n\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\``); await f.talk.idle();
  await f.talk.send({ text: 'Again', model: 'text' }); f.finish('turn-2', 'completed', 'Still here.'); f.finish('turn-2', 'completed', 'Still here.'); await f.talk.idle();
  const { scene } = await f.store.read(), live = scene.elements.filter(e => !e.isDeleted);
  const faces = live.filter(e => e.type === 'image'), notes = ['turn-1', 'turn-2'].map(id => live.find(e => e.id === `love-reply-${id}`));
  assert.deepEqual(faces.map(e => e.id), ['love-face-turn-1', 'love-face-turn-2'], 'one face per reply, once, though the turn finished twice');
  assert.equal(Object.keys(scene.files).length, 1, 'one file for every face'); assert.equal(faces[0].fileId, faces[1].fileId);
  assert.match(scene.files[faces[0].fileId].dataURL, /^data:image\/svg\+xml;base64,/);
  faces.forEach((face, i) => {
    assert.ok(face.x + face.width <= notes[i].x, 'the face is to the left of her note'); assert.ok(Math.abs(face.y - notes[i].y) <= 8, 'level with the first line');
    assert.ok(face.groupIds.includes(`love-reply-group-turn-${i + 1}`) && notes[i].groupIds.includes(`love-reply-group-turn-${i + 1}`), 'face and note move as one');
  });
  assert.ok(live.filter(e => e.id.startsWith('love-paint-turn-1-')).every(e => e.groupIds.includes('love-reply-group-turn-1') && e.x >= notes[0].x), 'her painting joins the group, under the note');
  const unit = e => e.groupIds?.at(-1) ?? e.id;
  for (const a of live) for (const b of live) if (a.id < b.id && unit(a) !== unit(b)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} and ${b.id} overlap`);
  const painting = live.filter(e => e.id.startsWith('love-paint-')); await f.talk.send({ text: 'Third', model: 'text' }); f.finish('turn-3', 'completed', ''); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.filter(e => e.type === 'image').length, 2, 'an empty reply has no face'); assert.ok(painting.length);
});
test('replies are black with red hearts, unsigned, collision-free, idempotent and saved without a UI subscriber', async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note('masih', 'Newest', '#e03131', { updated: 10 }), note('block', 'Obstacle', '#e03131', { x: 20, y: 100, width: 500, height: 500 })] });
  await f.talk.send({ text: 'Hi', model: 'text' }); f.finish('turn-1', 'completed', 'Here with you. 💙'); f.finish(); await f.talk.idle();
  const scene = (await f.store.read()).scene, reply = scene.elements.find(e => e.text === 'Here with you. ❤️');
  assert.ok(reply); assert.equal(reply.strokeColor, '#000000'); assert.equal(scene.elements.filter(e => e.text === reply.text).length, 1);
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
  const next = createLoveSpotTalk({ client: f.client, store: f.store, audio: enabledAudio }); t.after(() => next.close());
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
  assert.deepEqual((await f.store.read()).scene.elements.filter(e => e.type === 'text').map(e => e.originalText), ['The answer']);
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

for (const message of [id => `thread not loaded: ${id}`, () => 'Elpis rejected the operation (-32600). No automatic retry was made.']) test(`after Masih deletes the Love Spot chat, she starts a new one instead of failing forever (${message('x').slice(0, 24)})`, async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'text' }); f.finish(); await f.talk.idle();
  f.talk.close();
  // Deleted from the sidebar and purged at quit: thread/read answers as the engine does for an unknown thread.
  f.client.readThread = async id => { throw new Error(message(id)); };
  const next = createLoveSpotTalk({ client: f.client, store: f.store, audio: enabledAudio }); t.after(() => next.close());
  assert.deepEqual((await next.read()).entries, []);
  await next.send({ text: 'Are you still there?', model: 'text' });
  assert.equal(f.created.length, 2);
  assert.equal(f.sent.at(-1).text, 'Are you still there?');
});

// Masih, 23 Oct: "set her thinking to low so it be faster, and set her to /fast as well".
test('Matilda thinks at low effort and her chat asks for Fast once; a model without Fast still answers', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'text' }); f.finish(); await f.talk.idle();
  await f.talk.send({ text: 'Again', model: 'text' });
  assert.deepEqual(f.sent.map(item => item.effort), ['low', 'low']);
  assert.deepEqual(f.speeds, [{ id: 'chat', enabled: true }], 'Fast is asked for once, not on every message');
  const g = await fixture(t, { refuseFast: true });
  await g.talk.send({ text: 'Hello', model: 'text' });
  assert.equal(g.sent.length, 1, 'a refused Fast does not stop the message');
});

// Masih, 23 Oct: "I can't change her model!" A model from another connection starts her a new chat instead of being refused.
test('a model from another connection starts Matilda a new chat; one from the same connection keeps hers', async t => {
  const f = await fixture(t);
  // Engine threads name their connection.
  f.client.createThread = async value => { f.created.push(value); return { thread: { id: 'chat', ...value, modelProvider: value.provider ?? 'openai' } }; };
  await f.talk.send({ text: 'Hello', model: 'text' }); f.finish(); await f.talk.idle();
  await f.talk.send({ text: 'Same connection', model: 'text', provider: 'openai' }); f.finish('turn-2'); await f.talk.idle();
  assert.equal(f.created.length, 1, 'the same connection keeps her chat');
  await f.talk.send({ text: 'Now on Claude', model: 'claude/sonnet', provider: 'anthropic' });
  assert.equal(f.created.length, 2);
  assert.equal(f.created[1].provider, 'anthropic');
  assert.deepEqual(f.sent.map(item => [item.text, item.model]), [['Hello', 'text'], ['Same connection', 'text'], ['Now on Claude', 'claude/sonnet']]);
});

const delta = (f, text, itemId = 'reply', method = 'item/agentMessage/delta') => f.client.emit('event', { type: 'message', data: { method, params: { threadId: 'chat', turnId: `turn-${f.sent.length}`, itemId, delta: text } } });
test('Matilda feeds speech and one growing board note before completion, excluding painting, commentary, tools and reasoning', async t => {
  const f = await fixture(t);
  await f.talk.send({ text: 'Hello', model: 'claude/sonnet', provider: 'anthropic' });
  const events = [], feed = await f.talk.speech(); feed.subscribe(event => events.push(event));
  f.client.emit('event', { type: 'message', data: { method: 'item/started', params: { threadId: 'chat', turnId: 'turn-1', item: { id: 'progress', type: 'agentMessage', phase: 'commentary' } } } });
  delta(f, 'PRIVATE. ', 'progress'); delta(f, 'REASON. ', 'hidden', 'item/reasoning/textDelta'); delta(f, 'TOOL. ', 'tool', 'item/commandExecution/outputDelta');
  for (const text of ['Hello. \n', '`', '``excalidraw\n[{"type":"ellipse"}]\n``', '`', '\nStill ', 'here. ', 'The tail']) delta(f, text);
  assert.match(events.filter(e => e.type === 'text').map(e => e.text).join(''), /Hello\.\s+Still here\./);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|REASON|TOOL|excalidraw|ellipse/);
  await new Promise(resolve => setTimeout(resolve, 350)); await f.talk.idle();
  assert.match((await f.store.read()).scene.elements.find(e => e.id === 'love-reply-turn-1')?.originalText ?? '', /Hello/);
  f.finish('turn-1', 'completed', 'Hello. \n```excalidraw\n[{"type":"ellipse"}]\n```\nStill here. The tail'); await f.talk.idle();
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join('').trim(), 'Hello. \n\nStill here. The tail');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  f.finish(); await f.talk.idle();
  const scene = (await f.store.read()).scene;
  assert.equal(scene.elements.filter(e => e.id === 'love-reply-turn-1').length, 1);
  assert.equal(scene.elements.find(e => e.id === 'love-reply-turn-1').originalText, 'Hello. \n\nStill here. The tail');
  assert.equal(scene.elements.filter(e => e.id.startsWith('love-paint-turn-1-')).length, 1);
});

test('Mute stops the feed while writing continues, persists on restart, and unmute never replays old text', async t => {
  const f = await fixture(t); await f.talk.send({ text: 'Hello', model: 'text' });
  const events = [], feed = await f.talk.speech(); feed.subscribe(event => events.push(event));
  delta(f, 'First. '); delta(f, 'Old half');
  await f.talk.setVoice({ enabled: false });
  const count = events.filter(e => e.type === 'text').length;
  delta(f, ' MUTED. ');
  assert.ok(events.some(e => e.type === 'stop'));
  assert.equal(events.filter(e => e.type === 'text').length, count);
  assert.match(JSON.stringify((await f.talk.read()).entries), /MUTED/);
  f.finish(); await f.talk.idle(); f.talk.close();
  const next = createLoveSpotTalk({ client: f.client, store: f.store, audio: enabledAudio }); t.after(() => next.close());
  assert.equal((await next.read()).voice.enabled, false);
  await next.send({ text: 'Again', model: 'text' });
  delta(f, 'Before unmute. ');
  await next.setVoice({ enabled: true });
  const fresh = []; (await next.speech()).subscribe(event => fresh.push(event));
  delta(f, 'New words. ');
  assert.equal(fresh.filter(e => e.type === 'text').map(e => e.text).join(''), 'New words. ');
});

test('speech failure and interrupted turns stop voice without losing the text; unavailable ChatGPT defaults off', async t => {
  const f = await fixture(t); f.client.voiceStatus = async () => ({ available: false });
  const state = await f.talk.read(); assert.equal(state.voice.enabled, false); assert.match(state.voice.reason, /ChatGPT/);
  await f.talk.send({ text: 'Hello', model: 'text' });
  delta(f, 'Still writing. ');
  await assert.rejects(f.talk.speech(), /ChatGPT/);
  f.client.voiceStatus = async () => ({ available: true }); await f.talk.setVoice({ enabled: true });
  const events = [], feed = await f.talk.speech(); feed.subscribe(event => events.push(event));
  delta(f, 'Heard. '); feed.fail('Speech disconnected; retry explicitly.'); delta(f, 'Not retried. ');
  assert.match((await f.talk.read()).voice.error, /disconnected/);
  assert.doesNotMatch(events.filter(e => e.type === 'text').map(e => e.text).join(''), /retried/);
  f.finish('turn-1', 'completed', 'Still writing. Heard. Not retried.'); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.find(e => e.id === 'love-reply-turn-1').originalText, 'Still writing. Heard. Not retried.');
  await f.talk.send({ text: 'Again', model: 'text' });
  const cancelled = []; (await f.talk.speech()).subscribe(event => cancelled.push(event));
  delta(f, 'DROP TAIL'); f.finish('turn-2', 'interrupted', 'DROP TAIL. A cancelled sentence. '); await f.talk.idle();
  assert.equal(cancelled.filter(e => e.type === 'text').length, 0); assert.ok(cancelled.some(e => e.type === 'stop'));
});

test('unreadable Voice preferences disable speech and report the reason without blocking Matilda writing', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, '.voice.json'), '{');
  await f.talk.send({ text: 'Hello', model: 'text' });
  const state = await f.talk.read(); assert.equal(state.voice.enabled, false); assert.match(state.voice.reason, /Voice settings/);
  f.finish(); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.find(e => e.id === 'love-reply-turn-1').originalText, 'Here with you.');
});

test('one speech queue preserves message order and bounds a backlog while the complete note still saves', async t => {
  const f = await fixture(t); await f.talk.send({ text: 'Hello', model: 'text' });
  const spoken = []; (await f.talk.speech()).subscribe(event => { if (event.type === 'text') spoken.push(event.text); });
  delta(f, 'First tail', 'first');
  f.client.emit('event', { type: 'message', data: { method: 'item/completed', params: { threadId: 'chat', turnId: 'turn-1', item: { id: 'first', type: 'agentMessage', text: 'First tail' } } } });
  delta(f, 'Second. ', 'second');
  assert.equal(spoken.join(''), 'First tail\n\nSecond. ');
  f.finish(); await f.talk.idle();
  await f.talk.send({ text: 'A long reply', model: 'text' });
  const long = 'A sentence. '.repeat(300);
  delta(f, long);
  assert.match((await f.talk.read()).voice.error, /fell behind/);
  f.finish('turn-2', 'completed', long); await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.find(e => e.id === 'love-reply-turn-2').originalText, long.trim());
});
