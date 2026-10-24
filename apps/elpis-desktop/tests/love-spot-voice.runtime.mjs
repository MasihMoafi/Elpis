// Opt-in subscription acceptance; no credentials are copied, and engine threads are ephemeral.
// ELPIS_PLAYWRIGHT_PACKAGE=... node tests/love-spot-voice.runtime.mjs [--call|--barge]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopClient } from '../bridge/client.mjs';
import { startDesktopServer } from '../bridge/server.mjs';
import { createLoveSpot } from '../bridge/love-spot-store.cjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');
const run = promisify(execFile), barge = process.argv.includes('--barge'), live = barge || process.argv.includes('--call');
const root = await fs.mkdtemp(path.join(process.env.HOME, '.cache/elpis-briefs/cc/lovevoice-live-'));
const directory = path.join(root, 'board'); await fs.mkdir(directory);
const wav = path.join(root, 'microphone.wav');
const question = barge ? 'Count from one to forty.' : live ? 'What is our secret phrase? Say just the phrase.' : 'Please say hello in one short sentence.';
const capture = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text=${question}:voice=slt`];
if (barge) capture.push('-f', 'lavfi', '-i', 'flite=text=Stop. Say our secret phrase instead.:voice=slt', '-filter_complex', '[0:a]adelay=10000,apad=pad_dur=3[first];[first][1:a]concat=n=2:v=0:a=1');
else if (live) capture.push('-af', 'adelay=10000');
await run('ffmpeg', [...capture, '-ar', '48000', '-ac', '1', wav]);
if (live) {
  const board = createLoveSpot({ directory, screenshots: path.join(root, 'screenshots') });
  await board.save({ elements: [{ id: 'secret-note', type: 'text', text: 'Our secret phrase is apricot lantern.', x: 0, y: 0, width: 300, height: 30, strokeColor: '#2f9e44', version: 1, versionNonce: 1 }] });
  await board.close();
}
let duration = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav])).stdout) * 1000;
const captureDuration = duration;
if (barge) {
  const first = path.join(root, 'first.wav');
  await run('ffmpeg', [...capture.slice(0, 7), '-ar', '48000', '-ac', '1', first]);
  duration = 10000 + Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', first])).stdout) * 1000;
}
const client = await DesktopClient.connect(), side = new Set();
const result = { live, barge, voice: (await client.voiceStatus()).voice, speechDurationMs: duration, firstTextDeltaMs: null, firstBoardTextMs: null, firstPlayedAudioMs: null, transcript: '', userTurns: 0, events: [], errors: [], requests: [], root };
let speechEnd = 0, app, browser, page;
const proxy = new Proxy(client, { get(target, key) {
  if (key === 'listThreads') return async () => ({ data: [], nextCursor: null });
  if (key === 'createThread') return async body => {
    const made = await client.sideRpc('thread/start', { model: 'gpt-6-luna', modelProvider: 'openai', cwd: directory, developerInstructions: body.instructions, approvalPolicy: 'never', sandbox: 'read-only' });
    side.add(made.thread.id); return made;
  };
  if (key === 'send') return async (id, body) => client.sideRpc('turn/start', { threadId: id, model: 'gpt-6-luna', effort: 'low', input: [{ type: 'text', text: [body.text, ...body.attachments.filter(a => a.type === 'text').map(a => a.text)].join('\n\n'), text_elements: [] }] });
  if (key === 'setServiceTier') return async () => ({});
  const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
} });
client.on('side', message => {
  if (/thread\/realtime\/transcript\//.test(message.method)) result.events.push({ method: message.method, role: message.params.role, delta: message.params.delta, text: message.params.text, ms: Date.now() - speechEnd });
  if (side.has(message.params?.threadId)) client.emit('event', { type: 'message', data: message });
  if ((message.method === 'item/agentMessage/delta' || message.method === 'thread/realtime/transcript/delta' && message.params.role === 'assistant') && result.firstTextDeltaMs === null && speechEnd) result.firstTextDeltaMs = Date.now() - speechEnd;
  if (message.method === 'thread/realtime/transcript/done' && message.params.role === 'assistant') result.transcript += message.params.text;
  if (message.method === 'thread/realtime/transcript/done' && message.params.role === 'user') result.userTurns++;
});
try {
  app = await startDesktopServer({ client: proxy, loveSpot: { directory, screenshots: path.join(root, 'screenshots') }, elpisHome: root, trashFile: path.join(root, 'trash.json') });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ELPIS_CHROMIUM || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(15000);
  await page.addInitScript(fakeDesktop);
  await page.addInitScript(() => {
    window.playbackProof = { audio: [], peers: [], contexts: [], playing: [], muted: [], micBegan: 0 };
    const Context = AudioContext;
    window.AudioContext = class extends Context { constructor(...args) { super(...args); window.playbackProof.contexts.push(this); } };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.playbackProof.peers.push(this); } };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      if (!window.playbackProof.audio.includes(this)) { window.playbackProof.audio.push(this); this.addEventListener('playing', () => window.playbackProof.playing.push(Date.now())); }
      return play.apply(this, args);
    };
    const mic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await mic(...args); window.playbackProof.micBegan = Date.now(); return stream; };
  });
  page.on('pageerror', cause => result.errors.push(cause.message));
  page.on('request', request => { const url = new URL(request.url()); if (request.method() === 'POST' && /voice|talk/.test(url.pathname)) result.requests.push(url.pathname); });
  await page.goto(app.url); await page.getByRole('button', { name: 'Love Spot', exact: true }).click();
  await page.locator('.excalidraw canvas').first().waitFor();
  if (live) await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
  else await page.getByRole('group', { name: 'Voice note', exact: true }).getByRole('button', { name: 'Dictate message', exact: true }).click();
  await page.waitForFunction(() => window.playbackProof.micBegan > 0);
  speechEnd = await page.evaluate(duration => window.playbackProof.micBegan + duration, duration);
  await page.waitForTimeout(Math.max(0, speechEnd - Date.now()) + 300);
  if (!live) await page.getByRole('button', { name: 'Stop recording and transcribe' }).click();
  for (const deadline = Date.now() + 45000; Date.now() < deadline;) {
    if (result.firstBoardTextMs === null) {
      const board = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8').catch(() => '{"elements":[]}'));
      if (board.elements.some(e => e.id.startsWith('love-reply-') && !e.isDeleted)) result.firstBoardTextMs = Date.now() - speechEnd;
    }
    const proof = await page.evaluate(async () => {
      const p = window.playbackProof;
      const stats = await Promise.all(p.peers.map(peer => peer.getStats().then(rows => [...rows.values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').map(row => row.totalAudioEnergy || 0)).catch(() => [])));
      return { energy: stats.flat().reduce((a, b) => a + b, 0), playing: p.playing, advancing: p.audio.some(audio => !audio.paused && audio.currentTime > 0) };
    });
    if (proof.energy > 0.00001 && proof.advancing && proof.playing.length) { result.firstPlayedAudioMs = Date.now() - speechEnd; result.playback = proof; break; }
    const alerts = (await page.getByRole('alert').allTextContents()).filter(text => text.trim());
    if (alerts.length) { result.errors.push(...alerts); break; }
    await page.waitForTimeout(50);
  }
  result.board = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8').catch(() => '{"elements":[]}')).elements.filter(e => e.type === 'text' && !e.isDeleted).map(e => ({ id: e.id, text: e.originalText || e.text }));
  assert.ok(result.firstPlayedAudioMs !== null, 'Matilda produced no verified played audio');
  if (live) {
    let energy = result.playback.energy;
    const secondSpeechEnd = speechEnd + captureDuration - duration;
    for (let n = 0; n < 250; n++) {
      if (result.firstBoardTextMs === null) {
        const board = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8'));
        if (board.elements.some(e => e.id.startsWith('love-reply-') && !e.isDeleted)) result.firstBoardTextMs = Date.now() - speechEnd;
      }
      if (barge) {
        const proof = await page.evaluate(async () => {
          const p = window.playbackProof, rows = await p.peers.at(-1).getStats();
          return { energy: [...rows.values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').reduce((sum, row) => sum + (row.totalAudioEnergy || 0), 0), advancing: p.audio.some(audio => !audio.paused && !audio.muted && audio.currentTime > 0) };
        });
        if (Date.now() >= secondSpeechEnd && proof.advancing && proof.energy > energy + 0.000001 && result.secondPlayedAudioMs === undefined) result.secondPlayedAudioMs = Date.now() - secondSpeechEnd;
        energy = proof.energy;
      }
      if (/apricot lantern/i.test(result.transcript) && (!barge || result.secondPlayedAudioMs !== undefined)) break;
      await page.waitForTimeout(100);
    }
    assert.match(result.transcript, /apricot lantern/i, 'the live subscription must know the board-only secret');
    if (barge) {
      assert.ok(result.userTurns >= 2, 'the subscription heard the interruption as another user turn');
      assert.doesNotMatch(result.transcript, /forty/i, 'the interrupted count must stop before forty');
      assert.ok(result.secondPlayedAudioMs !== undefined, 'the replacement reply must actually play too');
    }
    for (let n = 0; n < 50; n++) {
      result.board = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8')).elements.filter(e => e.type === 'text' && !e.isDeleted).map(e => ({ id: e.id, text: e.originalText || e.text }));
      if (result.board.some(e => e.id.startsWith('love-reply-') && /apricot lantern/i.test(e.text))) break;
      await page.waitForTimeout(100);
    }
    assert.equal(result.board.filter(e => e.id.startsWith('love-reply-') && /apricot lantern/i.test(e.text)).length, 1, 'spoken output becomes one board note');
    if (barge) assert.equal(result.board.filter(e => e.id.startsWith('love-reply-')).length, 2, 'the interrupted reply and the new reply each have one note');
    await page.getByRole('button', { name: 'End voice chat' }).click();
    assert.ok(await page.evaluate(() => window.playbackProof.audio.every(audio => audio.paused && audio.srcObject === null)), 'hang-up stops all played audio');
    await page.getByRole('switch', { name: /^Voice/ }).click();
    await page.getByText('Voice is off.', { exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Start voice chat', exact: true }).isDisabled(), 'saved Mute cannot start another call');
    assert.ok(result.firstPlayedAudioMs < 1500, `Speech took ${result.firstPlayedAudioMs} ms (budget 1500 ms)`);
  }
} catch (cause) { result.failure = cause.message; process.exitCode = 1; }
finally {
  if (page) { await page.screenshot({ path: path.join(root, 'screen.png') }); result.page = (await page.locator('body').innerText()).slice(-2500); }
  if (page) result.finalPlayback = await page.evaluate(() => ({ contexts: window.playbackProof.contexts.map(context => context.state), peers: window.playbackProof.peers.map(peer => peer.connectionState), audio: window.playbackProof.audio.map(audio => ({ paused: audio.paused, time: audio.currentTime })) }));
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  await browser?.close();
  for (const id of side) await client.sideRpc('thread/unsubscribe', { threadId: id }).catch(() => {});
  await app?.close(); client.close(); console.log(JSON.stringify(result));
}
