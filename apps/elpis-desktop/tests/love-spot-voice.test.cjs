const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

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

for (const colorScheme of ['light', 'dark']) test(`Love Spot hides unavailable audio and keeps board text, persona and chat replies working (${colorScheme})`, async () => {
  const posts = [], voiceSettingsReads = [];
  const f = await loveSpotFixture({ colorScheme, configureClient: client => { client.voiceStatus = async () => ({ available: true }); } });
  try {
    const { page } = f;
    page.on('request', request => {
      const route = new URL(request.url()).pathname;
      if (request.method() === 'POST') posts.push(route);
      if (request.method() === 'GET' && route === '/api/love-spot/voice/settings') voiceSettingsReads.push(route);
    });
    await page.route('**/api/love-spot/voice/settings', route => route.fulfill({ status: 503, json: { error: { message: 'Retired voice settings are unavailable.' } } }));
    await page.addInitScript(() => {
      window.voiceLaunches = { microphone: 0, peers: 0 };
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => { window.voiceLaunches.microphone++; throw new Error('Unavailable audio must not capture a microphone'); } } });
      window.RTCPeerConnection = class { constructor() { window.voiceLaunches.peers++; throw new Error('Unavailable audio must not start a peer'); } };
    });
    await page.reload();
    await f.open(page);
    assert.equal(await page.getByRole('group', { name: "Matilda's voice" }).count(), 0);
    assert.equal(await page.getByRole('switch', { name: 'Read replies aloud', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Voice unavailable', exact: true }).count(), 0);
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.press('t');
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.type('Keep our text conversation.'); await page.keyboard.press('Escape');
    const scene = await f.waitFor(scene => scene.elements.some(element => element.id === 'love-reply-turn-1' && !element.isDeleted), 'text-only Matilda did not reply', 20000);
    assert.ok(scene.elements.some(element => element.text === 'Keep our text conversation.'));
    assert.ok(scene.elements.some(element => element.text === 'I am here with you.'));
    assert.match(f.turns[0].attachments.find(item => item.name === 'Who you are.txt').text, /Matilda/);
    assert.deepEqual(voiceSettingsReads, [], 'disabled board audio does not load its settings');
    assert.equal(await page.getByRole('alert').filter({ hasText: 'Retired voice settings' }).count(), 0);
    await page.locator('aside [data-thread-id="love-chat"] .thread-link').click();
    const reply = page.locator('.message.agent').filter({ hasText: 'I am here with you.' });
    await reply.waitFor(); await reply.hover();
    assert.equal(await reply.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Voice unavailable', exact: true }).count(), 0, 'linked Love Spot chats hide unavailable Voice too');
    assert.equal(posts.filter(route => /\/voice(?:\/|$)/.test(route)).length, 0, 'the board, saved Voice-on preference and chat must not launch or warm audio');
    assert.deepEqual(await page.evaluate(() => window.voiceLaunches), { microphone: 0, peers: 0 });
    const shots = path.join(process.env.HOME, '.cache/elpis-shots'); await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `lovevoice-${colorScheme}.png`) });
    for (const width of [820, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `voice controls stay within ${width}px`);
      await page.screenshot({ path: path.join(shots, `lovevoice-${colorScheme}-${width}.png`) });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const sound of [true, false]) test(`Read aloud verifies actual sound before completion (sound=${sound})`, async t => {
  const { READ_ALOUD_AUDIO } = await import('../lib/love-spot-audio.mjs');
  if (!READ_ALOUD_AUDIO.available) return t.skip('Read aloud is unavailable until subscription speech is reliable.');
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
