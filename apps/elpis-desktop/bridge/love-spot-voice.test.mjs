import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLoveSpot } from './love-spot-store.cjs';
import { createLoveSpotTalk } from './love-spot-talk.mjs';
import { startDesktopServer } from './server.mjs';

test('live Matilda carries board/persona context and saves growing speech once; mute and hang-up reject later output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lovevoice-unit-'));
  const store = createLoveSpot({ directory, screenshots: path.join(directory, 'shots') });
  const client = new EventEmitter(); client.voiceStatus = async () => ({ available: true });
  const talk = createLoveSpotTalk({ client, store });
  t.after(async () => { talk.close(); await talk.idle(); await store.close(); });
  await store.save({ elements: [{ id: 'user-note', type: 'text', text: 'Our secret is apricot lantern.', strokeColor: '#2f9e44', version: 1, versionNonce: 1, x: 20, y: 20, width: 240, height: 40 }] });
  const call = await talk.conversation('Be brief and friendly.');
  assert.match(call.context, /apricot lantern/); assert.match(call.context, /Be brief and friendly/);
  const contexts = [], stop = await call.watch(context => contexts.push(context), assert.fail);
  const before = await store.read();
  await store.save({ elements: before.scene.elements.map(element => ({ ...element, text: 'Our secret is orange blossom.', version: 2 })) });
  for (let n = 0; !contexts.length && n < 40; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(contexts[0], /orange blossom/);
  call.transcript({ role: 'assistant', delta: 'Hello ' });
  await new Promise(resolve => setTimeout(resolve, 350)); await talk.idle();
  let scene = (await store.read()).scene;
  assert.equal(scene.elements.find(e => e.id.startsWith('love-reply-'))?.originalText, 'Hello');
  // V3 interleaves the user's delayed final/last words with the assistant's already-started answer.
  call.transcript({ role: 'user', text: 'Hello there.' });
  call.transcript({ role: 'assistant', delta: 'Masih.' });
  call.transcript({ role: 'user', delta: ' there.' });
  call.transcript({ role: 'assistant', text: 'Hello Masih.' });
  await talk.idle();
  scene = (await store.read()).scene;
  assert.deepEqual(scene.elements.filter(e => e.id.startsWith('love-reply-')).map(e => e.originalText), ['Hello Masih.']);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(contexts.length, 1, 'her speech is not fed back as another board edit');
  call.close(); call.transcript({ role: 'assistant', text: 'Late audio must not appear.' }); await talk.idle();
  stop();
  assert.equal((await store.read()).scene.elements.filter(e => e.id.startsWith('love-reply-')).length, 1);
  await talk.setVoice({ enabled: false });
  await assert.rejects(talk.conversation('Be brief.'), /off|muted/i);
  assert.equal((await store.read()).scene.elements.filter(e => e.id.startsWith('love-reply-')).length, 1);
});

test('the live microphone endpoint starts the saved subscription voice with context and refuses muted/invalid requests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lovevoice-http-'));
  const client = new EventEmitter(), starts = [];
  Object.assign(client, { connected: true, pendingApprovals: [], close() {}, voiceStatus: async () => ({ available: true }),
    createSpeechThread: async () => ({ id: 'speech', voice: 'juniper' }),
    startSpeechThread: async (...args) => { starts.push(args); client.emit('side', { method: 'thread/realtime/sdp', params: { threadId: 'speech', sdp: 'v=0\r\nanswer' } }); },
    closeSpeechThread: async () => {},
  });
  const app = await startDesktopServer({ client, elpisHome: root, trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'board'), screenshots: path.join(root, 'shots') } });
  t.after(() => app.close());
  const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(new URL('/api/session', url), { method: 'POST', headers: { origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const headers = { origin: url.origin, cookie: auth.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(new URL(`/api/${route}`, url), { method: 'POST', headers, body: JSON.stringify(body) });
  const reply = await post('love-spot/voice/call', { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n', persona: 'Be kind and brief.' });
  assert.equal(reply.status, 200);
  const reader = reply.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /sdp/);
  assert.equal(starts[0][0].voice, 'juniper');
  assert.match(starts[0][2].conversation, /Be kind and brief/);
  await reader.cancel();
  assert.equal((await post('love-spot/voice/call', { sdp: 'invalid', persona: 42 })).status, 400);
  assert.equal((await post('love-spot/voice/settings', { enabled: false })).status, 200);
  assert.equal((await post('love-spot/voice/call', { sdp: 'v=0\r\n', persona: 'Be brief.' })).status, 409);
  assert.equal(starts.length, 1, 'refused requests must not start another subscription session');
});
