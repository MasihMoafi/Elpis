// 5 Nov, Masih: a voice chat started in Love Spot's chat stopped when he opened the board. The call now belongs to the app:
// it goes on across pages, her face in the title bar shows she speaks and offers Mute, Pause and Hang up, and any other
// chat's call still ends with its chat. Also: pinned Matilda's right-click Hide unpins her, and the Love Spot bar has no
// zoom switch (it raised "Unsupported workspace patch") and no Accounts icon.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

/** The realtime peer's side, made in the same page: it answers the offer and sends a silent tone back. */
async function answer(page, offer) {
  return page.evaluate(async offer => {
    const proof = window.voiceProof;
    const remote = new proof.NativePeer(); proof.remotes.push(remote);
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), sink = context.createMediaStreamDestination();
    gain.gain.value = 0; oscillator.connect(gain).connect(sink); oscillator.start(); await context.resume();
    remote.addTrack(sink.stream.getAudioTracks()[0], sink.stream);
    remote.ondatachannel = event => { proof.channel = event.channel; };
    await remote.setRemoteDescription({ type: 'offer', sdp: offer }); await remote.setLocalDescription(await remote.createAnswer());
    if (remote.iceGatheringState !== 'complete') await new Promise(resolve => remote.addEventListener('icegatheringstatechange', () => { if (remote.iceGatheringState === 'complete') resolve(); }));
    return remote.localDescription.sdp;
  }, offer);
}

test('a Love Spot voice call outlives the board, her face controls it, and other chats end theirs', async () => {
  const starts = [], stops = [], reports = [];
  let page;
  const chatId = n => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`, love = chatId(0);
  const f = await loveSpotFixture({ threadId: chatId, configureClient: client => {
    client.voiceStatus = async () => ({ available: true });
    client.startVoice = async (id, sdp) => {
      starts.push(id);
      const sdpAnswer = await answer(page, sdp);
      setTimeout(() => client.emit('event', { type: 'message', data: { method: 'thread/realtime/sdp', params: { threadId: id, sdp: sdpAnswer } } }), 0);
    };
    client.stopVoice = async id => { stops.push(id); };
  } });
  try {
    page = f.page;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/voice/report') reports.push(request.postData()); });
    await page.addInitScript(() => {
      window.voiceProof = { NativePeer: RTCPeerConnection, remotes: [] };
      // A silent microphone and a record of the call's speaker, so Pause and Mute can be read back.
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
        const context = new AudioContext(), sink = context.createMediaStreamDestination(); context.createOscillator().connect(sink);
        window.microphone = sink.stream; return sink.stream;
      } } });
      const NativeAudio = window.Audio; window.speakers = [];
      window.Audio = function (...args) { const audio = new NativeAudio(...args); window.speakers.push(audio); return audio; };
    });
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });

    // The bar: no zoom switch, no Accounts icon, and no workspace error.
    await f.open(page);
    assert.equal(await page.getByRole('switch', { name: 'Zoom to her replies' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Models & accounts', exact: true }).count(), 0);

    // Love Spot's chat comes from a note on the board that Matilda answers.
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.press('t');
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.type('Talk to me.'); await page.keyboard.press('Escape');
    await f.waitFor(scene => scene.elements.some(element => element.id === 'love-reply-turn-1' && !element.isDeleted), 'Matilda did not reply', 20000);
    await page.locator(`aside [data-thread-id="${love}"] .thread-link`).click();
    await page.getByRole('button', { name: 'Start voice chat' }).click();
    await page.getByRole('status').filter({ hasText: 'Listening' }).waitFor({ timeout: 20000 })
      .catch(async e => { throw new Error(`${e.message}; starts ${JSON.stringify(starts)}; voice row: ${await page.locator('.dictation-control').allInnerTexts()}; errors ${JSON.stringify(f.errors)}`); });
    assert.deepEqual(starts, [love]);
    const face = page.locator('.title-bar');
    for (const name of ['Pause talking with Matilda', 'End voice chat with Matilda']) await face.getByRole('button', { name }).waitFor();
    assert.equal(await face.getByRole('button', { name: 'Mute Matilda' }).count(), 0, 'one mute: Pause silences her during a call');

    // She speaks: rings around her face.
    await page.evaluate(() => window.voiceProof.channel.send(JSON.stringify({ type: 'output_transcript.added' })));
    await face.locator('.matilda-speaking-ring').waitFor();

    // He opens the board: the call goes on.
    await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).click();
    await page.locator('.excalidraw canvas').first().waitFor();
    await page.waitForTimeout(1500);
    assert.deepEqual(stops, [], 'opening the board does not end her call');
    assert.deepEqual(reports, [], 'no call report: the call has not ended');
    assert.equal(await page.evaluate(() => window.voiceProof.remotes[0].connectionState), 'connected');
    await face.getByRole('button', { name: 'Pause talking with Matilda' }).waitFor();

    // Pause holds his microphone and her voice; Resume gives both back.
    await face.getByRole('button', { name: 'Pause talking with Matilda' }).click();
    assert.deepEqual(await page.evaluate(() => [window.speakers.at(-1).muted, window.microphone.getAudioTracks()[0].enabled]), [true, false]);
    await face.getByRole('button', { name: 'Resume talking with Matilda' }).click();
    assert.deepEqual(await page.evaluate(() => [window.speakers.at(-1).muted, window.microphone.getAudioTracks()[0].enabled]), [false, true]);

    // Hang up from her face, on the board.
    await face.getByRole('button', { name: 'End voice chat with Matilda' }).click();
    await face.getByRole('button', { name: 'Pause talking with Matilda' }).waitFor({ state: 'detached' });
    await assert.doesNotReject(async () => { const end = Date.now() + 5000; while (!stops.includes(love)) { if (Date.now() > end) throw new Error('no stop'); await page.waitForTimeout(50); } });

    // Negative: an ordinary chat's call ends when he leaves it, and her face shows no controls for it.
    await page.getByRole('button', { name: 'New chat' }).first().click();
    await page.getByRole('textbox', { name: 'Message Elpis' }).fill('An ordinary chat.');
    await page.getByRole('textbox', { name: 'Message Elpis' }).press('Enter');
    await page.locator('.message.agent').filter({ hasText: 'I am here with you.' }).waitFor({ timeout: 20000 });
    const ordinary = starts.length;
    await page.getByRole('button', { name: 'Start voice chat' }).click();
    await page.getByRole('status').filter({ hasText: 'Listening' }).waitFor({ timeout: 20000 });
    const other = starts[ordinary];
    assert.notEqual(other, love);
    assert.equal(await face.getByRole('button', { name: 'Pause talking with Matilda' }).count(), 0);
    await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).click();
    await assert.doesNotReject(async () => { const end = Date.now() + 5000; while (!stops.includes(other)) { if (Date.now() > end) throw new Error('the ordinary call did not end'); await page.waitForTimeout(50); } });

    // Pinned Matilda: right-click, Hide = Unpin.
    await face.getByRole('button', { name: 'Pin Matilda' }).click();
    const pinned = page.locator('section[aria-label="Pinned Matilda"]');
    await pinned.waitFor();
    await pinned.locator('.matilda-face').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await pinned.waitFor({ state: 'detached' });
    await face.getByRole('button', { name: 'Pin Matilda' }).waitFor();

    assert.equal(await page.getByText('Unsupported workspace patch').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 5 Nov, Masih: "add that call button, the same call button that we use for hang up, this is just for calling her up."
test('Call Matilda beside her face starts her Love Spot call from any page; Hang up brings the Call button back', async () => {
  const starts = [], stops = [];
  let page;
  const chatId = n => `00000000-0000-4000-8000-${String(n + 101).padStart(12, '0')}`, love = chatId(0);
  const f = await loveSpotFixture({ threadId: chatId, configureClient: client => {
    client.voiceStatus = async () => ({ available: true });
    client.startVoice = async (id, sdp) => {
      starts.push(id);
      const sdpAnswer = await answer(page, sdp);
      setTimeout(() => client.emit('event', { type: 'message', data: { method: 'thread/realtime/sdp', params: { threadId: id, sdp: sdpAnswer } } }), 0);
    };
    client.stopVoice = async id => { stops.push(id); };
  } });
  try {
    page = f.page;
    await page.addInitScript(() => {
      window.voiceProof = { NativePeer: RTCPeerConnection, remotes: [] };
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
        const context = new AudioContext(), sink = context.createMediaStreamDestination(); context.createOscillator().connect(sink); return sink.stream;
      } } });
    });
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const face = page.locator('.title-bar'), callButton = face.getByRole('button', { name: 'Call Matilda' });
    // Negative: before she has a Love Spot chat there is nothing to call.
    await page.waitForTimeout(1000);
    assert.equal(await callButton.count(), 0, 'no Call button before her chat exists');

    await f.open(page);
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.press('t');
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.type('Talk to me.'); await page.keyboard.press('Escape');
    await f.waitFor(scene => scene.elements.some(element => element.id === 'love-reply-turn-1' && !element.isDeleted), 'Matilda did not reply', 20000);

    // From another page (a new chat), the phone beside her face calls her.
    await page.getByRole('button', { name: 'New chat' }).first().click();
    await callButton.waitFor({ timeout: 20000 });
    await callButton.click();
    await face.getByRole('button', { name: 'End voice chat with Matilda' }).waitFor({ timeout: 20000 });
    { const end = Date.now() + 10000; while (!starts.length && Date.now() < end) await page.waitForTimeout(100); }
    assert.deepEqual(starts, [love], 'the call is her Love Spot chat\'s');
    await page.getByRole('status').filter({ hasText: 'Listening' }).or(face.getByRole('button', { name: 'Pause talking with Matilda' })).first().waitFor({ timeout: 20000 });
    assert.equal(await callButton.count(), 0, 'no Call button during the call');

    // Pinned, her face follows the call: her words choose it, a thoughtful tilt while she works, listening while he talks.
    await face.getByRole('button', { name: 'Pin Matilda' }).click();
    const pinned = page.locator('section[aria-label="Pinned Matilda"]'); await pinned.waitFor();
    const send = event => page.evaluate(value => window.voiceProof.channel.send(JSON.stringify(value)), event);
    const moodIs = async (mood, why) => {
      const end = Date.now() + 5000; let seen;
      while (Date.now() < end) { seen = await pinned.evaluate(node => node.querySelector('.matilda-mood[data-shown="true"]')?.dataset.mood ?? null); if (seen === mood) return; await page.waitForTimeout(50); }
      assert.equal(seen, mood, why);
    };
    await send({ type: 'output_transcript.added', item: { text: 'I love you, ' } }); await send({ type: 'output_transcript.added', item: { text: 'darling.' } });
    await moodIs('kissSoft', 'affectionate words: a kiss');
    await send({ type: 'input_transcript.added', item: { text: 'Tell me a joke' } });
    await moodIs(null, 'he talks: her resting, listening face');
    await send({ type: 'delegation.created' });
    await moodIs('tiltSmile', 'she is thinking');
    await send({ type: 'output_transcript.added', item: { text: 'Haha, you are cheeky.' } });
    await moodIs('wink', 'a joke: a wink');
    // The face's label is the app's glass tooltip, not the system one.
    assert.equal(await pinned.locator('.matilda-face').getAttribute('title'), null);
    await pinned.locator('.matilda-face').hover();
    await page.locator('.hud-tooltip-glass').filter({ hasText: 'Chat with Matilda' }).waitFor();
    await page.mouse.move(5, 500);
    await pinned.locator('.matilda-face').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide', exact: true }).click(); await pinned.waitFor({ state: 'detached' });
    await face.getByRole('button', { name: 'End voice chat with Matilda' }).click();
    await callButton.waitFor();
    { const end = Date.now() + 5000; while (!stops.includes(love) && Date.now() < end) await page.waitForTimeout(50); }
    assert.ok(stops.includes(love), 'Hang up ends her call');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
