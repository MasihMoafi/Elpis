const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
    assert.equal((await f.scene()).elements.filter(e => !e.isDeleted).length, 2); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Talk sends the board and picture with the chosen model, reuses a sidebar chat, quotes notes and dictates', async () => {
  const f = await loveSpotFixture();
  try {
    await microphone(f.page); await f.open(f.page); await note(f, 'The secret is apricot');
    const panel = f.page.getByRole('region', { name: 'Love Spot Talk', exact: true }); assert.equal(await panel.isVisible(), false);
    await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    const draft = panel.getByRole('textbox', { name: 'Message Elpis' }); await draft.fill('What is our secret?');
    await panel.getByRole('combobox').click(); await f.page.getByRole('option', { name: /GPT-6-Luna/ }).click();
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await panel.getByText('I am here with you.', { exact: true }).waitFor();
    const saved = await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'reply did not land on the board');
    const answer = saved.elements.find(e => e.text === 'I am here with you.'); assert.equal(answer.strokeColor, '#1971c2');
    assert.equal(f.chats.length, 1); assert.equal(f.chats[0].name, 'Love Spot'); assert.equal(f.chats[0].cwd, f.directory);
    await f.page.locator('aside [data-thread-id="love-chat"] .thread-title').filter({ hasText: 'Love Spot' }).waitFor();
    assert.equal(f.turns[0].model, 'luna'); assert.match(f.turns[0].attachments.find(a => a.type === 'text').text, /Masih.*The secret is apricot/s);
    assert.match(f.turns[0].attachments.find(a => a.type === 'image').dataUrl, /^data:image\/png;base64,/);
    for (const e of saved.elements.filter(e => !e.isDeleted && e.id !== answer.id)) assert.ok(answer.x + answer.width <= e.x || e.x + e.width <= answer.x || answer.y + answer.height <= e.y || e.y + e.height <= answer.y, 'reply overlaps another element');
    await record(panel); await f.page.waitForFunction(() => document.querySelector('.love-spot-talk textarea')?.value === 'A voice note from Masih');
    assert.equal(await draft.inputValue(), 'A voice note from Masih');
    await draft.fill(''); await f.page.getByRole('button', { name: 'Fold Talk' }).click();
    await f.page.reload(); await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    await panel.getByText('I am here with you.', { exact: true }).waitFor();
    await draft.fill('Again'); await draft.press('Enter'); await f.page.waitForTimeout(400);
    assert.equal(f.chats.length, 1); assert.equal(f.turns.length, 2); assert.match(f.turns[1].attachments.find(a => a.type === 'text').text, /agent.*I am here with you/s);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('right-clicking a Masih note quotes it in Talk without sending', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await note(f, 'Please ask about this');
    const box = await f.page.locator('.excalidraw').boundingBox();
    await f.page.mouse.click(box.x + 460, box.y + 310, { button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Ask about this note' }).click();
    const draft = f.page.getByRole('textbox', { name: 'Message Elpis' });
    assert.match(await draft.inputValue(), /> Please ask about this/); assert.equal(f.turns.length, 0);
    await draft.press('Enter'); await f.waitFor(s => s.elements.some(e => e.strokeColor === '#1971c2'), 'quoted question reply missing');
  } finally { await f.close(); }
});

test('a failed Talk turn shows its error and adds no agent note', async () => {
  const f = await loveSpotFixture({ reply: '' });
  try {
    await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Message Elpis' }).fill('Hello'); await f.page.getByRole('button', { name: 'Send', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: 'Test provider failed' }).waitFor();
    assert.equal((await f.scene()).elements.filter(e => !e.isDeleted).length, 0);
  } finally { await f.close(); }
});

test('Talk waits for Settings and its model list before sending with the main model', async () => {
  const f = await loveSpotFixture();
  let release; const ready = new Promise(resolve => { release = resolve; });
  try {
    await f.page.route('**/api/models*', async route => { await ready; await route.continue(); });
    await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    const panel = f.page.getByRole('region', { name: 'Love Spot Talk', exact: true });
    await panel.getByRole('textbox', { name: 'Message Elpis' }).fill('Use our main model');
    const send = panel.getByRole('button', { name: 'Send', exact: true });
    assert.equal(await send.isDisabled(), true, 'sending before the model loads must be blocked'); assert.equal(f.turns.length, 0);
    release(); await send.click();
    await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'default model reply missing');
    assert.equal(f.turns[0].model, 'sol'); assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});

test('a reply reaches the board after navigating away; text-only models receive every note without a picture', async () => {
  const f = await loveSpotFixture({ replyDelay: 700 });
  try {
    await f.open(f.page); await note(f, 'Still here when you return');
    await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    const panel = f.page.getByRole('region', { name: 'Love Spot Talk', exact: true });
    await panel.getByRole('combobox').click(); await f.page.getByRole('option', { name: /Text only/ }).click();
    await panel.getByRole('textbox', { name: 'Message Elpis' }).fill('Stay with this thought');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await f.page.waitForResponse(response => response.url().endsWith('/api/love-spot/talk') && response.request().method() === 'POST');
    await f.page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'navigation lost the reply');
    assert.equal(f.turns[0].attachments.some(a => a.type === 'image'), false);
    assert.match(f.turns[0].attachments.find(a => a.type === 'text').text, /Still here when you return/);
    await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    await panel.getByText('I am here with you.', { exact: true }).waitFor(); assert.equal(f.chats.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Talk fits in light and dark at 1280 and 1440', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await note(f, 'A quiet place to think together');
    await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Message Elpis' }).fill('Hello from our board'); await f.page.getByRole('button', { name: 'Send', exact: true }).click();
    await f.page.getByText('I am here with you.', { exact: true }).waitFor();
    await fs.mkdir('/tmp/love-spot-talk-shots', { recursive: true });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await chooseTheme(f.page, theme);
      for (const width of [1280, 1440]) {
        await f.page.setViewportSize({ width, height: 960 });
        await assertUiFit(f.page.locator('.love-spot-tools'), `${theme} toolbar ${width}`);
        await assertUiFit(f.page.getByRole('region', { name: 'Love Spot Talk' }), `${theme} Talk ${width}`);
        await f.page.screenshot({ path: `/tmp/love-spot-talk-shots/${theme}-${width}.png` });
      }
    }
  } finally { await f.close(); }
});
