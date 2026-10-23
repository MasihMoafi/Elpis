const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

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
        addTrack() {} createDataChannel() {} async createOffer() { return { type: 'offer', sdp: 'v=0\r\ntest offer' }; }
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
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceTest.tracks.at(-1).enabled), false);
    await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceTest.tracks.at(-1).enabled), true);
    await page.getByRole('button', { name: 'End voice chat' }).click();
    await page.waitForFunction(() => window.voiceTest.tracks.every(track => track.readyState === 'ended') && window.voiceTest.peers.every(peer => peer.connectionState === 'closed'));
    await start.click(); await page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor();
    await f.open('chat-b');
    await page.waitForFunction(() => window.voiceTest.tracks.every(track => track.readyState === 'ended') && window.voiceTest.peers.every(peer => peer.connectionState === 'closed'));
    const deadline = Date.now() + 1500;
    while (streams.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(streams.size, 0, 'the native owner stream must close on End and navigation');
    assert.deepEqual(f.errors, []);
  } finally { for (const stream of streams) stream.end(); await f.close(); }
});
