const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

async function loopback(page, offer) {
  return page.evaluate(async offer => {
    const proof = window.voiceProof;
    const remote = new proof.NativePeer(); proof.remotes.push(remote);
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), sink = context.createMediaStreamDestination();
    gain.gain.value = 0; oscillator.connect(gain).connect(sink); oscillator.start(); await context.resume();
    proof.outputs.push({ context, gain });
    remote.addTrack(sink.stream.getAudioTracks()[0], sink.stream);
    remote.ondatachannel = event => { proof.channel = event.channel; };
    await remote.setRemoteDescription({ type: 'offer', sdp: offer }); await remote.setLocalDescription(await remote.createAnswer());
    if (remote.iceGatheringState !== 'complete') await new Promise(resolve => remote.addEventListener('icegatheringstatechange', () => { if (remote.iceGatheringState === 'complete') resolve(); }));
    return remote.localDescription.sdp;
  }, offer);
}

for (const colorScheme of ['light', 'dark']) test(`Love Spot plays live microphone replies, shows blocked playback, and stops sound on End and Mute (${colorScheme})`, async () => {
  let enabled = true, f, activeStream;
  let scene = { elements: [], files: {}, appState: {}, page: { name: 'Current page', session: 'page-1' } };
  const streams = new Set();
  f = await fixture({ staticDir: process.env.LOVEVOICE_STATIC_DIR, desktop: true, width: 1440, height: 900, colorScheme,
    browserArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], routes: {
      '/api/settings': () => ({ main: { model: 'sol', provider: 'openai' }, providers: [], background: {}, smartPrune: {}, memory: {}, write: { available: false } }),
      '/api/voice': () => ({ available: true }),
      '/api/love-spot': body => { if (body) scene = { ...scene, ...body }; return { scene, revision: 'a'.repeat(64) }; },
      '/api/love-spot/pages': () => ({ pages: [{ name: 'Current page', modified: Date.now() }] }),
      '/api/love-spot/talk': () => ({ busy: false }),
      '/api/love-spot/voice/settings': body => { if (body) enabled = body.enabled; return { enabled, available: true }; },
      '/api/love-spot/voice/call': async (body, _url, response) => {
        assert.ok(body.persona.includes('Matilda'));
        // Real loopback WebRTC audio; no play(), audio element or media track is faked.
        const sdp = await loopback(f.page, body.sdp);
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(JSON.stringify({ type: 'sdp', sdp }) + '\n');
        activeStream = response;
        streams.add(response); response.on('close', () => streams.delete(response));
      },
    } });
  try {
    const { page } = f;
    await page.addInitScript(() => {
      const NativePeer = RTCPeerConnection;
      window.voiceProof = { NativePeer, peers: [], remotes: [], outputs: [], audio: [], denied: false };
      window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.voiceProof.peers.push(this); } };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(...args) { window.voiceProof.audio.push(this); return window.voiceProof.denied ? Promise.reject(new DOMException('Blocked', 'NotAllowedError')) : play.apply(this, args); };
    });
    await page.reload(); await page.getByRole('button', { name: 'Love Spot', exact: true }).click();
    await page.locator('.excalidraw canvas').first().waitFor();
    const start = page.getByRole('button', { name: 'Start voice chat', exact: true });
    await start.click(); await page.getByRole('status').filter({ hasText: 'Listening' }).waitFor();
    const began = Date.now();
    await page.evaluate(() => { window.voiceProof.outputs.at(-1).gain.gain.value = 0.1; });
    await page.waitForFunction(async () => {
      const proof = window.voiceProof, peer = proof.peers.at(-1);
      const rows = await peer.getStats();
      return proof.audio.some(audio => !audio.paused && audio.currentTime > 0) && [...rows.values()].some(row => row.type === 'inbound-rtp' && row.totalAudioEnergy > 0.00001);
    });
    assert.ok(Date.now() - began < 1500, 'client plays an available response within the 1.5 second budget');
    for (const event of [{ type: 'transcript', role: 'assistant', delta: 'Hello.' }, { type: 'transcript', role: 'user', text: 'Earlier input, finalized late.' }]) activeStream.write(JSON.stringify(event) + '\n');
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => window.voiceProof.audio.some(audio => !audio.muted && !audio.paused)), 'a delayed user transcript must not silence a reply already playing');
    await page.getByRole('button', { name: 'End voice chat' }).click();
    assert.equal(await page.evaluate(() => window.voiceProof.audio.every(audio => audio.paused && audio.srcObject === null)), true);
    await start.click(); await page.getByRole('status').filter({ hasText: 'Listening' }).waitFor();
    await page.getByRole('switch', { name: /^Voice/ }).click();
    await start.waitFor();
    assert.equal(await page.evaluate(() => window.voiceProof.audio.every(audio => audio.paused && audio.srcObject === null)), true, 'saved Mute stops the call and played audio');
    assert.equal(await start.isDisabled(), true);
    await page.getByText('Voice is off.', { exact: true }).waitFor();
    await page.getByRole('switch', { name: /^Voice/ }).click();
    await page.evaluate(() => { window.voiceProof.denied = true; }); await start.click();
    await page.getByRole('alert').filter({ hasText: 'Audio playback was blocked' }).waitFor();
    const shots = path.join(process.env.HOME, '.cache/elpis-shots'); await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `lovevoice-${colorScheme}.png`) });
    for (const width of [820, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `voice controls stay within ${width}px`);
      await page.screenshot({ path: path.join(shots, `lovevoice-${colorScheme}-${width}.png`) });
    }
    assert.deepEqual(f.errors, []);
  } catch (cause) {
    console.error('VOICE_UI_FAILURE', JSON.stringify({ errors: f.errors, page: (await f.page.locator('body').innerText()).slice(-1800) }));
    throw cause;
  } finally { for (const response of streams) response.end(); await f.close(); }
});

for (const sound of [true, false]) test(`Read aloud verifies actual sound before completion (sound=${sound})`, async () => {
  let f; const streams = new Set();
  f = await fixture({ routes: {
    '/api/voice/read-aloud': async (body, _url, response) => {
      const sdp = await loopback(f.page, body.sdp);
      await f.page.evaluate(sound => { window.voiceProof.outputs.at(-1).gain.gain.value = sound ? 0.1 : 0; }, sound);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const event of [{ type: 'session', id: 'audio-proof' }, { type: 'sdp', sdp }, { type: 'complete' }]) response.write(JSON.stringify(event) + '\n');
      streams.add(response); response.on('close', () => streams.delete(response));
    },
  } });
  try {
    const { page } = f;
    await page.evaluate(() => { window.voiceProof = { NativePeer: RTCPeerConnection, remotes: [], outputs: [] }; });
    await f.open('chat-a');
    if (!sound) await page.clock.install();
    const reply = page.locator('.message.agent').last();
    await reply.hover(); await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await page.waitForFunction(() => window.voiceProof.remotes.at(-1)?.connectionState === 'connected');
    if (sound) {
      await reply.getByRole('button', { name: 'Read aloud', exact: true }).waitFor({ timeout: 6000 });
      assert.equal(await reply.getByRole('alert').count(), 0);
    } else {
      await page.clock.fastForward(16000);
      await reply.getByRole('alert').filter({ hasText: 'no audible audio' }).waitFor();
    }
    assert.deepEqual(f.errors, []);
  } finally { for (const response of streams) response.end(); await f.close(); }
});
