const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
async function eventually(check, ms = 4000) { const end = Date.now() + ms; for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } } }

for (const colorScheme of ['light', 'dark']) test(`Settings → Voice saves a catalog choice and keeps handoffs private (${colorScheme})`, async () => {
  let voice = 'cove';
  const handoff = '<realtime_delegation><input>Internal voice request</input><transcript_delta>private handoff</transcript_delta></realtime_delegation>';
  const f = await fixture({ colorScheme, chat: [['voice', handoff, 'A normal reply.'], ['typed', 'Keep my typed message.', 'Another reply.']], routes: {
    '/api/voice': () => ({ available: true, voices: ['cove', 'arbor'], voice }),
    '/api/voice/choice': body => { voice = body.voice; return { available: true, voices: ['cove', 'arbor'], voice }; },
    '/api/mcp': () => ({ version: '1', write: { available: true }, servers: [{ name: 'whispertype', enabled: true, whispertype: { backend: 'local', model: null } }] }),
    '/api/tools/transcription': () => ({ available: true, label: 'Local WhisperType' }),
  } });
  try {
    const { page } = f;
    await f.open('chat-a');
    assert.equal(await page.locator('.message.user').count(), 1);
    await page.getByText('Keep my typed message.', { exact: true }).waitFor();
    await openSettings(page, 'Voice');
    const choice = page.getByRole('combobox', { name: 'Voice chat voice', exact: true });
    await choice.click(); await page.getByRole('option', { name: 'Arbor', exact: true }).click();
    await page.getByText('Voice saved.', { exact: true }).waitFor();
    assert.equal(f.posts.find(row => row.path === '/api/voice/choice').body.voice, 'arbor');
    await page.reload();
    await openSettings(page, 'Voice');
    await page.getByRole('combobox', { name: 'Voice chat voice' }).filter({ hasText: 'Arbor' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'OpenRouter transcription model', exact: true }).isVisible(), false);
    for (const width of [1262, 760]) {
      await page.setViewportSize({ width, height: 1000 });
      const bounds = await choice.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      if (process.env.ELPIS_VOICE_SHOTS) {
        await fs.mkdir(process.env.ELPIS_VOICE_SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ELPIS_VOICE_SHOTS, `voice-${colorScheme}-${width}.png`) });
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('voice controls release the microphone after denial, cancelled startup, mute, End and navigation', async () => {
  const streams = new Set();
  const f = await fixture({ routes: { '/api/voice': (input, _url, response) => {
    if (!input) return { available: true };
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'sdp', sdp: 'test answer' }) + '\n');
    streams.add(response); response.on('close', () => streams.delete(response));
  } } });
  try {
    const { page } = f; page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      window.voiceTest = { mode: 'deny', tracks: [], peers: [], resolve: null };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        const test = window.voiceTest;
        if (test.mode === 'deny') throw new DOMException('Denied', 'NotAllowedError');
        if (test.mode === 'pending') await new Promise(resolve => { test.resolve = resolve; });
        const context = new AudioContext(), stream = context.createMediaStreamDestination().stream;
        test.tracks.push(stream.getAudioTracks()[0]); return stream;
      } });
      window.RTCPeerConnection = class {
        iceGatheringState = 'complete'; connectionState = 'new'; localDescription = null;
        constructor() { window.voiceTest.peers.push(this); }
        addTrack() {} createDataChannel() { const channel = {}; window.voiceTest.channel = channel; return channel; } async createOffer() { return { type: 'offer', sdp: 'v=0\r\ntest offer' }; }
        async setLocalDescription(value) { this.localDescription = value; }
        async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
        close() { this.connectionState = 'closed'; }
      };
    });
    await page.reload(); await f.open('chat-a');
    const start = page.getByRole('button', { name: 'Start voice chat', exact: true });
    await start.click(); await page.getByRole('alert').filter({ hasText: 'Microphone access was denied' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'End voice chat' }).count(), 0);
    assert.equal(f.posts.filter(row => row.path === '/api/voice').length, 0, 'permission denial must not create a call');
    await page.evaluate(() => { window.voiceTest.mode = 'pending'; });
    await start.click(); await page.getByRole('button', { name: 'End voice chat' }).click();
    await page.evaluate(() => window.voiceTest.resolve());
    await page.waitForFunction(() => window.voiceTest.tracks.length === 1 && window.voiceTest.tracks[0].readyState === 'ended');
    assert.equal(f.posts.filter(row => row.path === '/api/voice').length, 0, 'late microphone access must not create a call');
    await page.evaluate(() => { window.voiceTest.mode = 'allow'; });
    await start.click();
    const status = page.getByRole('status').filter({ hasText: /Listening|Hearing you|Working on it|Speaking|Muted/ });
    await status.filter({ hasText: 'Listening' }).waitFor();
    const said = type => page.evaluate(type => window.voiceTest.channel.onmessage({ data: JSON.stringify({ type }) }), type);
    await said('input_transcript.added'); await status.filter({ hasText: 'Hearing you' }).waitFor();
    await said('delegation.created'); await status.filter({ hasText: 'Working on it' }).waitFor();
    await said('output_transcript.added'); await status.filter({ hasText: 'Speaking' }).waitFor();
    await status.filter({ hasText: 'Listening' }).waitFor({ timeout: 4000 });
    // An error the call itself reports is read out to the person, not swallowed behind "Listening".
    await page.evaluate(() => window.voiceTest.channel.onmessage({ data: JSON.stringify({ type: 'error', error: { message: 'Voice limit reached for now.' } }) }));
    await page.getByRole('alert').filter({ hasText: 'Voice limit reached for now.' }).waitFor();
    // Masih, 23 Oct: icons "shouldn't misconfigure ... with size": the call's buttons are the size of dictation's and share its row.
    const sizes = await page.evaluate(() => ['Mute microphone', 'End voice chat'].map(name => { const b = document.querySelector(`button[aria-label="${name}"]`).getBoundingClientRect(), d = document.querySelector('button[aria-label^="Dictate"], button[aria-label*="ictat"]')?.getBoundingClientRect(); return { name, w: b.width, h: b.height, dw: d?.width, dh: d?.height, top: b.top, dtop: d?.top }; }));
    for (const s of sizes) { assert.ok(s.dw, 'dictation button found'); assert.equal(Math.round(s.w), Math.round(s.dw), `${s.name} has the width of dictation's button`); assert.equal(Math.round(s.h), Math.round(s.dh), `${s.name} has its height`); assert.ok(Math.abs(s.top - s.dtop) <= 2, `${s.name} sits on dictation's row`); }
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceTest.tracks.at(-1).enabled), false);
    await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceTest.tracks.at(-1).enabled), true);
    await page.getByRole('button', { name: 'End voice chat' }).click();
    await page.waitForFunction(() => window.voiceTest.tracks.every(track => track.readyState === 'ended') && window.voiceTest.peers.every(peer => peer.connectionState === 'closed'));
    // Ending leaves one report of what the call heard and sent, with kinds and counts only.
    await eventually(() => { const sent = f.posts.filter(row => row.path === '/api/voice/report'); assert.ok(sent.length >= 1, 'the call reported itself'); assert.equal(sent.at(-1).body.listened, true); assert.equal(sent.at(-1).body.events['input_transcript.added'], 1); assert.equal(sent.at(-1).body.events['output_transcript.added'], 1); assert.deepEqual(Object.keys(sent.at(-1).body).sort(), ['error', 'events', 'inboundBytes', 'inboundEnergy', 'inboundPackets', 'listened', 'micEnergy', 'seconds']); });
    await start.click(); await page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor();
    await f.open('chat-b');
    await page.waitForFunction(() => window.voiceTest.tracks.every(track => track.readyState === 'ended') && window.voiceTest.peers.every(peer => peer.connectionState === 'closed'));
    const deadline = Date.now() + 1500;
    while (streams.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(streams.size, 0, 'the native owner stream must close on End and navigation');
    assert.deepEqual(f.errors, []);
  } finally { for (const stream of streams) stream.end(); await f.close(); }
});
