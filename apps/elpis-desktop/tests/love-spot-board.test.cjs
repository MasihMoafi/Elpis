// Love Spot's board is where Matilda answers (Masih, 23 Oct: "I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda."):
// what reaches her, where her reply lands, and the board's own microphone. Her face, her painting and who she is: tests/matilda.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

async function microphone(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      state = 'inactive';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['test sound']) }); this.onstop?.(); }
    };
  });
  let result = { text: 'A voice note from Masih' }, status = 200;
  await page.route('**/api/tools/transcription?*', route => route.fulfill({ status: route.request().method() === 'POST' ? status : 200, json: route.request().method() === 'POST' ? result : { available: true, backend: 'fixture', label: 'the test transcriber' } }));
  await page.reload();
  return (value, code = 200) => { result = value; status = code; };
}
async function record(control) { await control.getByRole('button', { name: 'Dictate message', exact: true }).click(); await control.getByRole('button', { name: 'Stop recording and transcribe' }).click(); }
async function note(f, text) {
  const bounds = await f.page.locator('.excalidraw').boundingBox();
  await f.page.mouse.click(bounds.x + 450, bounds.y + 300); await f.page.keyboard.press('t');
  await f.page.mouse.click(bounds.x + 450, bounds.y + 300); await f.page.keyboard.type(text); await f.page.keyboard.press('Escape');
  return f.waitFor(s => s.elements.some(e => e.text === text), 'typed note was not saved');
}

test('board microphone inserts one coloured note at the last click; empty and failed recognition add nothing', async () => {
  const f = await loveSpotFixture();
  try {
    const respond = await microphone(f.page); await f.open(f.page);
    await note(f, 'Remember this');
    // Pick an actual Excalidraw colour with the mouse, then choose the insertion point.
    await f.page.getByRole('button', { name: /^Stroke$/ }).click();
    await f.page.getByRole('button', { name: /#e03131/i }).first().click(); await f.page.keyboard.press('Escape');
    const box = await f.page.locator('.excalidraw').boundingBox(); await f.page.mouse.click(box.x + 650, box.y + 420);
    const mic = f.page.getByRole('group', { name: 'Voice note' });
    await record(mic);
    const saved = await f.waitFor(s => s.elements.some(e => e.text === 'A voice note from Masih'), 'transcription did not become a board note');
    const voice = saved.elements.find(e => e.text === 'A voice note from Masih');
    assert.equal(voice.strokeColor, '#e03131'); assert.equal(saved.elements.filter(e => e.text === voice.text).length, 1);
    const typed = saved.elements.find(e => e.text === 'Remember this');
    assert.ok(Math.abs(voice.x - typed.x - 200) < 5); assert.ok(Math.abs(voice.y - typed.y - 120) < 25);
    respond({ text: '  ' }); await record(mic); await mic.getByRole('status').filter({ hasText: 'No speech was recognized. Your draft is unchanged.' }).waitFor();
    respond({ error: 'Test transcription failed' }, 502); await record(mic); await mic.getByRole('status').filter({ hasText: 'Test transcription failed' }).waitFor();
    assert.equal((await f.scene()).elements.filter(e => !e.isDeleted && !e.id.startsWith('love-')).length, 2); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


const clear = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const unit = e => e.groupIds?.at(-1) ?? e.id;
test('what he writes reaches her with the board and its picture and the main model; her blue reply lands clear of everything; the sidebar chat is one and says its origin once', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await note(f, 'The secret is apricot');
    const saved = await f.waitFor(s => s.elements.some(e => e.id === 'love-reply-turn-1' && !e.isDeleted), 'reply did not land on the board', 20000);
    const answer = saved.elements.find(e => e.id === 'love-reply-turn-1'); assert.equal(answer.text, 'I am here with you.'); assert.equal(answer.strokeColor, '#1971c2');
    assert.equal(f.chats.length, 1); assert.equal(f.chats[0].name, 'Love Spot'); assert.equal(f.chats[0].cwd, f.directory);
    await f.page.locator('aside [data-thread-id="love-chat"] .thread-title').filter({ hasText: 'Love Spot' }).waitFor();
    assert.deepEqual(await f.page.locator('aside [data-thread-id="love-chat"] .thread-link').allInnerTexts(), ['Love Spot'], 'the Love Spot group already names the origin: the chat says it once');
    assert.equal(f.turns[0].model, 'sol', 'she answers with the main model'); assert.match(f.turns[0].attachments.find(a => a.type === 'text').text, /Masih.*The secret is apricot/s);
    assert.match(f.turns[0].attachments.find(a => a.type === 'image').dataUrl, /^data:image\/png;base64,/);
    for (const e of saved.elements.filter(e => !e.isDeleted && unit(e) !== unit(answer))) assert.ok(clear(answer, e), `her reply overlaps ${e.id}`);
    await f.page.reload(); await f.open(f.page); await note(f, 'Do you remember?');
    await f.waitFor(() => f.turns.length === 2, 'the second note was not answered', 20000);
    assert.equal(f.chats.length, 1); assert.match(f.turns[1].attachments.find(a => a.type === 'text').text, /agent.*I am here with you/s, 'the same chat, and she sees her own earlier reply');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a reply reaches the board after navigating away', async () => {
  const f = await loveSpotFixture({ replyDelay: 700 });
  try {
    await f.open(f.page); await note(f, 'Still here when you return');
    await f.page.waitForResponse(response => response.url().endsWith('/api/love-spot/talk') && response.request().method() === 'POST', { timeout: 20000 });
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'navigation lost the reply');
    await f.page.locator('.nav-list .love-unread').waitFor();
    assert.match(f.turns[0].attachments.find(a => a.type === 'text').text, /Still here when you return/);
    await f.open(f.page); assert.equal(f.chats.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a long non-Latin reply avoids obstacles after the editor restores its actual font dimensions', async () => {
  const f = await loveSpotFixture({ reply: '天地玄黄宇宙洪荒'.repeat(32) });
  try {
    await f.open(f.page); await note(f, 'A thought near an obstacle');
    const box = await f.page.locator('.excalidraw').boundingBox();
    await f.page.keyboard.press('r'); await f.page.mouse.move(box.x + 450, box.y + 624);
    await f.page.mouse.down(); await f.page.mouse.move(box.x + 550, box.y + 674, { steps: 5 }); await f.page.mouse.up(); await f.page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => e.type === 'rectangle'), 'obstacle was not saved');
    await f.waitFor(s => s.elements.some(e => e.id.startsWith('love-reply-')), 'long reply missing', 20000);
    await f.page.evaluate(() => document.fonts.ready.then(() => document.fonts.load('20px Cascadia')));
    // A real nudge records the restored dimensions, rather than trusting the bridge's estimated bounds.
    const canvas = await f.page.locator('.excalidraw').boundingBox();
    await f.page.mouse.click(canvas.x + 80, canvas.y + 350); await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('ArrowRight');
    const saved = await f.waitFor(s => s.elements.some(e => e.id.startsWith('love-reply-') && e.version > 1), 'restored reply dimensions were not recorded');
    const answer = saved.elements.find(e => e.id.startsWith('love-reply-'));
    for (const e of saved.elements.filter(e => !e.isDeleted && unit(e) !== unit(answer))) assert.ok(clear(answer, e), 'restored non-Latin reply overlaps another element');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the toolbar fits in light and dark at 1280 and 1440, with Matilda writing', async () => {
  const f = await loveSpotFixture({ replyDelay: 30000 });
  try {
    await f.open(f.page); await note(f, 'A quiet place to think together');
    await f.page.getByText('Matilda is writing…').waitFor({ timeout: 20000 });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await chooseTheme(f.page, theme);
      for (const width of [1280, 1440]) {
        await f.page.setViewportSize({ width, height: 960 });
        await assertUiFit(f.page.locator('.love-spot-tools'), `${theme} toolbar ${width}`);
      }
    }
  } finally { await f.close(); }
});
