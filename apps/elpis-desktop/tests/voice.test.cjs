const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { controlValue, openSettings } = require('./controls.cjs');
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

test('Voice refreshes account and MCP setup while preserving unsaved transcription fields', async () => {
  let version = 1, enabled = false, signedIn = false, catalogFailed = true, selectedVoice = 'cove';
  let releaseVoice, voiceStarted, releaseStatus;
  const voiceHeld = new Promise(resolve => { voiceStarted = resolve; }), voiceGate = new Promise(resolve => { releaseVoice = resolve; });
  let transcription = { backend: 'local', model: null };
  const config = () => ({ version: `m${version}`, write: { available: true }, servers: [{ name: 'whispertype', enabled, transport: 'stdio', command: 'whispertype-mcp', url: null, credentials: [], whispertype: transcription }] });
  const f = await fixture({ routes: {
    '/api/voice': () => ({ available: signedIn, voices: signedIn ? ['cove', 'arbor'] : [], voice: selectedVoice }),
    '/api/voice/choice': async body => { selectedVoice = body.voice; const result = { available: signedIn, voices: ['cove', 'arbor'], voice: selectedVoice }; voiceStarted(); await voiceGate; return result; },
    '/api/models': (_body, url) => url.searchParams.get('inputModality') === 'audio'
      ? catalogFailed ? { __http: 503, error: 'Audio catalog temporarily unavailable' } : { data: [{ id: 'catalog/audio', model: 'catalog/audio', displayName: 'Recovered audio model' }] }
      : { data: [{ id: 'sol', model: 'sol', displayName: 'GPT-6.1-Sol' }] },
    '/api/mcp': body => {
      if (body) {
        if (body.version !== `m${version}`) return { __http: 409, error: 'Configuration changed' };
        if (body.action === 'enable') enabled = body.enabled;
        if (body.action === 'whispertype') transcription = { backend: body.backend, model: body.model };
        version++;
      }
      return config();
    },
    '/api/tools/transcription': () => ({ available: enabled, reason: enabled ? '' : 'WhisperType is disabled.' }),
  } });
  try {
    const { page } = f;
    await openSettings(page, 'Voice');
    const panel = page.getByRole('tabpanel', { name: 'Voice', exact: true });
    const voice = panel.getByRole('combobox', { name: 'Voice chat voice', exact: true });
    await panel.getByText('WhisperType is disabled.', { exact: true }).waitFor();
    assert.equal(await voice.isDisabled(), true);
    await panel.getByText('Advanced: transcription', { exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'OpenRouter models unavailable: Audio catalog temporarily unavailable' }).waitFor();
    await panel.getByText('Advanced: custom model', { exact: true }).click();
    const model = panel.getByRole('textbox', { name: 'Custom OpenRouter transcription model', exact: true });
    await model.fill('my/unsaved-audio-model');
    signedIn = true; catalogFailed = false; f.emit('account', { method: 'account/updated' });
    await eventually(async () => assert.equal(await voice.isEnabled(), true, 'account changes refresh the visible Voice settings'));
    assert.equal(await model.inputValue(), 'my/unsaved-audio-model');
    await panel.getByRole('combobox', { name: 'OpenRouter transcription model', exact: true }).click();
    await page.getByRole('option', { name: 'Recovered audio model', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await voice.click(); await page.getByRole('option', { name: 'Arbor', exact: true }).waitFor(); await page.keyboard.press('Escape');
    await voice.focus();
    const typedChoice = page.waitForRequest(request => new URL(request.url()).pathname === '/api/voice/choice');
    await voice.press('a'); await typedChoice; await voiceHeld;
    signedIn = false; f.emit('account', { method: 'account/updated' });
    await voice.filter({ hasText: 'Unavailable' }).waitFor();
    releaseVoice();
    await panel.getByText('Voice saved.', { exact: true }).waitFor();
    assert.equal(await voice.isDisabled(), true, 'a delayed save cannot restore an obsolete signed-in snapshot');
    signedIn = true; f.emit('account', { method: 'account/updated' });
    await eventually(async () => assert.equal(await voice.isEnabled(), true));
    await page.getByRole('tab', { name: 'MCP servers', exact: true }).click();
    const mcp = page.getByRole('tabpanel', { name: 'MCP servers', exact: true });
    await mcp.getByRole('switch', { name: 'Enable whispertype', exact: true }).click();
    await eventually(async () => assert.equal(await mcp.getByRole('switch', { name: 'Enable whispertype', exact: true }).getAttribute('aria-checked'), 'true'));
    // A second config writer changes a clean field while this form's model remains unsaved.
    transcription = { backend: 'codex', model: 'another/saved-model' }; version++;
    await mcp.getByRole('button', { name: 'Open Voice settings', exact: true }).click();
    await panel.getByText('Configured', { exact: true }).waitFor();
    await eventually(async () => assert.equal(await controlValue(panel.getByRole('combobox', { name: 'Fallback transcription engine', exact: true })), 'codex'));
    assert.equal(await model.inputValue(), 'my/unsaved-audio-model', 'setup refresh keeps the edited field');
    const savedVersion = `m${version}`;
    await panel.getByRole('button', { name: 'Save transcription settings', exact: true }).click();
    await panel.getByText('Transcription settings saved.', { exact: true }).waitFor();
    assert.deepEqual(f.posts.filter(post => post.path === '/api/mcp').at(-1).body, { version: savedVersion, name: 'whispertype', action: 'whispertype', backend: 'codex', model: 'my/unsaved-audio-model' });
    transcription = { backend: 'local', model: 'latest/saved-model' }; version++;
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('tab', { name: 'Voice', exact: true }).click();
    await eventually(async () => assert.equal(await model.inputValue(), 'latest/saved-model', 'a clean field follows the refreshed config'));
    let holdStatus = false, statusStarted;
    const statusHeld = new Promise(resolve => { statusStarted = resolve; }), statusGate = new Promise(resolve => { releaseStatus = resolve; });
    await page.route('**/api/mcp', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().model === 'delayed/save-model') holdStatus = true;
      await route.fallback();
    });
    await page.route('**/api/tools/transcription', async route => {
      if (holdStatus) { holdStatus = false; statusStarted(); await statusGate; }
      await route.fallback();
    });
    await model.fill('delayed/save-model');
    const saveAcknowledged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mcp' && response.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Save transcription settings', exact: true }).click();
    const savedReply = await saveAcknowledged;
    assert.equal(savedReply.status(), 200, `the delayed save must be accepted before its status read: ${await savedReply.text()}`);
    await statusHeld;
    transcription = { backend: 'openrouter', model: 'newer/after-save' }; version++;
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('tab', { name: 'Voice', exact: true }).click();
    await eventually(async () => assert.equal(await controlValue(panel.getByRole('combobox', { name: 'Fallback transcription engine', exact: true })), 'openrouter'));
    releaseStatus();
    await panel.getByText('Transcription settings saved.', { exact: true }).waitFor().catch(async error => {
      throw new Error(`${error.message}\nVoice after releasing the saved status: ${await panel.innerText()}\nLatest MCP write: ${JSON.stringify(f.posts.filter(post => post.path === '/api/mcp').at(-1))}`);
    });
    assert.equal(await model.inputValue(), 'newer/after-save', 'a delayed save cannot replace a newer activation snapshot');
    await model.fill('saved/after-race');
    const currentVersion = `m${version}`;
    await panel.getByRole('button', { name: 'Save transcription settings', exact: true }).click();
    await panel.getByText('Transcription settings saved.', { exact: true }).waitFor();
    assert.equal(f.posts.filter(post => post.path === '/api/mcp').at(-1).body.version, currentVersion, 'the next save uses the newer config version');
    await model.evaluate(input => {
      const autofill = input.form.querySelector('input[aria-hidden="true"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(autofill, 'catalog/audio');
      autofill.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await eventually(async () => assert.equal(await model.inputValue(), 'catalog/audio', 'native autofill still edits the shared select'));
    assert.deepEqual(f.errors, []);
  } finally { releaseVoice?.(); releaseStatus?.(); await f.close(); }
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

test('Love Spot explains unavailable audio while ordinary replies still warm, read the displayed words and clear failures after navigation', async () => {
  const threads = [['chat-a', 'Love Spot'], ['chat-b', 'Other chat']].map(([id, name]) => ({ id, name, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } }));
  const f = await fixture({ threads, routes: { '/api/voice': () => ({ available: true }), '/api/threads/chat-b': () => ({ thread: threads[1], data: [{ turnId: 'other-turn', item: { id: 'other-answer', type: 'agentMessage', text: 'All green.' }, completedAtMs: Date.now() }], nextCursor: null }) } });
  try {
    await f.open('chat-a');
    const unavailable = f.page.getByRole('button', { name: 'Voice unavailable', exact: true });
    await unavailable.waitFor(); assert.equal(await unavailable.isDisabled(), true);
    await unavailable.focus(); await f.page.keyboard.press('Tab'); await f.page.keyboard.press('Shift+Tab');
    await f.page.getByRole('tooltip').filter({ hasText: 'Love Spot audio is temporarily unavailable.' }).waitFor();
    const matilda = f.page.locator('.message.agent').last();
    await matilda.hover(); assert.equal(await matilda.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0);
    assert.equal(f.posts.filter(row => /voice/.test(row.path)).length, 0, 'Love Spot does not warm or start a speaker');
    await f.open('chat-b');
    const reply = f.page.locator('.message.agent').last();
    await reply.hover(); await f.page.locator('aside').hover(); await reply.hover();
    // Showing a reply's actions makes the chat's speech thread ahead, once.
    await eventually(() => assert.deepEqual(f.posts.filter(row => row.path === '/api/voice/read-aloud/warm').map(row => row.body.threadId), ['chat-b']));
    const speak = reply.getByRole('button', { name: 'Read aloud', exact: true });
    await speak.waitFor(); await speak.click();
    await eventually(() => assert.ok(f.posts.some(row => row.path === '/api/voice/read-aloud' && row.body.threadId === 'chat-b')));
    const request = f.posts.find(row => row.path === '/api/voice/read-aloud' && row.body.threadId === 'chat-b');
    assert.equal(request.body.text, 'All green.');
    // The fixture returns no speech stream: a failed read belongs only to this visit to this chat.
    await reply.getByRole('alert').waitFor();
    await f.open('chat-a');
    assert.equal(await f.page.locator('.message.agent [role="alert"]').count(), 0, 'returning to a chat does not revive its previous speech failure');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Love Spot preserves typed messages and live replies without starting automatic audio, including a saved Voice-on preference', async () => {
  for (const enabled of [true, false]) {
    const f = await fixture({ threads: [{ id: 'chat-a', name: 'Love Spot', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } }], routes: {
      '/api/love-spot/talk': () => ({ thread: { id: 'chat-a' } }),
      '/api/voice': () => ({ available: true }),
      '/api/love-spot/voice/settings': () => ({ enabled, available: true }),
    } });
    try {
      const { page } = f; await f.open('chat-a');
      const unavailable = page.getByRole('button', { name: 'Voice unavailable', exact: true });
      await unavailable.waitFor(); assert.equal(await unavailable.isDisabled(), true);
      await unavailable.evaluate(button => button.click());
      await f.composer.fill('Please reply in text.'); await f.composer.press('Enter');
      await eventually(() => assert.ok(f.posts.some(row => row.path === '/api/threads/chat-a/turns' && row.body.text === 'Please reply in text.')));
      const requests = () => f.posts.filter(row => /voice/.test(row.path));
      assert.equal(requests().length, 0, 'history and the unavailable launch do not start audio');
      const emit = (method, params) => f.emit('message', { method, params: { threadId: 'chat-a', turnId: 't-new', ...params } });
      emit('turn/started', { turn: { id: 't-new' } });
      emit('item/started', { item: { id: 'thinking', type: 'agentMessage', phase: 'commentary', text: '' } });
      emit('item/agentMessage/delta', { itemId: 'thinking', delta: 'Checking things.' });
      await page.getByText('Checking things.', { exact: true }).waitFor(); assert.equal(requests().length, 0, 'commentary stays quiet');
      emit('item/started', { item: { id: 'live-reply', type: 'agentMessage', phase: 'final_answer', text: '' } });
      emit('item/agentMessage/delta', { itemId: 'live-reply', delta: 'Hello Masih. ' });
      const reply = page.locator('.message.agent').filter({ hasText: 'Hello Masih.' });
      await reply.waitFor();
      await reply.hover(); assert.equal(await reply.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0);
      emit('item/agentMessage/delta', { itemId: 'live-reply', delta: 'Still here.' });
      await page.getByText('Hello Masih. Still here.', { exact: true }).waitFor();
      emit('turn/completed', { turn: { id: 't-new', status: 'completed', items: [{ id: 'live-reply', type: 'agentMessage', phase: 'final_answer', text: 'Hello Masih. Still here.' }] } });
      await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(requests().length, 0, 'a saved Voice-on preference, deltas and completion cannot start unavailable audio');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('delayed Love Spot origin discovery blocks legacy chat audio and releases only ordinary chats after a valid scene', async () => {
  const threads = [['chat-a', 'Review'], ['chat-b', 'Other chat'], ['chat-c', 'Love Spot']].map(([id, name]) => ({ id, name, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } }));
  const f = await fixture({ threads, loveScene: null, routes: {
    '/api/voice': () => ({ available: true }),
    '/api/threads/chat-b': () => ({ thread: threads[1], data: [{ turnId: 'other-turn', item: { id: 'other-answer', type: 'agentMessage', text: 'Ordinary text to read.' }, completedAtMs: Date.now() }], nextCursor: null }),
  } });
  try {
    const { page } = f;
    await page.evaluate(() => {
      window.voiceLaunches = { microphone: 0, peers: 0 };
      const microphone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), Peer = RTCPeerConnection;
      navigator.mediaDevices.getUserMedia = (...args) => { window.voiceLaunches.microphone++; return microphone(...args); };
      window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.voiceLaunches.peers++; } };
    });
    await eventually(() => assert.equal(f.loveListening(), 1));
    for (const id of ['chat-a', 'chat-b', 'chat-c', 'chat-a']) {
      await f.open(id);
      const unavailable = page.getByRole('button', { name: 'Voice unavailable', exact: true });
      await unavailable.waitFor(); assert.equal(await unavailable.isDisabled(), true);
      assert.equal(await unavailable.getAttribute('title'), id === 'chat-c' ? 'Love Spot audio is temporarily unavailable.' : 'Audio is unavailable while chat information loads.');
      await unavailable.evaluate(button => button.click());
      const reply = page.locator('.message.agent').last();
      if (await reply.count()) { await reply.hover(); assert.equal(await reply.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0); }
    }
    assert.deepEqual(await page.evaluate(() => window.voiceLaunches), { microphone: 0, peers: 0 });
    assert.equal(f.posts.filter(row => /voice/.test(row.path)).length, 0, 'unknown origins cannot warm or launch audio');

    f.emitLove({ type: 'scene', scene: { elements: [{ id: 'review-card', customData: { loveAgent: { name: 'Review', threadId: 'chat-a' } } }] } });
    await page.getByRole('button', { name: 'Voice unavailable', exact: true }).and(page.locator('[title="Love Spot audio is temporarily unavailable."]')).waitFor();
    const legacyReply = page.locator('.message.agent').last();
    await legacyReply.hover(); assert.equal(await legacyReply.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0);
    assert.equal(f.posts.filter(row => /voice/.test(row.path)).length, 0, 'the resolved legacy Love Spot chat stays gated');

    await f.open('chat-b');
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).waitFor();
    const reply = page.locator('.message.agent').last();
    await reply.hover();
    await eventually(() => assert.deepEqual(f.posts.filter(row => row.path === '/api/voice/read-aloud/warm').map(row => row.body.threadId), ['chat-b']));
    await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await eventually(() => assert.ok(f.posts.some(row => row.path === '/api/voice/read-aloud' && row.body.threadId === 'chat-b' && row.body.text === 'Ordinary text to read.')));
    await reply.getByRole('alert').waitFor();

    f.emitLove({ type: 'error', message: 'The scene is unavailable.' });
    await page.getByRole('button', { name: 'Voice unavailable', exact: true }).and(page.locator('[title="Audio is unavailable while chat information loads."]')).waitFor();
    await reply.hover(); assert.equal(await reply.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0);
    f.emitLove({ type: 'scene', scene: { elements: [] } });
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.voiceLaunches.microphone), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
