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
    // A message's hover buttons hang below it (28px): the gap to the next line must hold them.
    const gaps = await f.page.evaluate(() => [...document.querySelectorAll('.love-spot-talk-messages .message, .love-spot-talk-messages .user-turn')].filter(el => el.querySelector('.message-actions')).map(el => ({ margin: parseFloat(getComputedStyle(el).marginBottom), buttons: el.querySelector('.message-actions')?.getBoundingClientRect().height ?? 0 })));
    assert.ok(gaps.length > 0 && gaps.every(gap => gap.margin >= gap.buttons), `a message's buttons fit in the gap below it: ${JSON.stringify(gaps)}`);
    const saved = await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'reply did not land on the board');
    const answer = saved.elements.find(e => e.text === 'I am here with you.'); assert.equal(answer.strokeColor, '#1971c2');
    assert.equal(f.chats.length, 1); assert.equal(f.chats[0].name, 'Love Spot'); assert.equal(f.chats[0].cwd, f.directory);
    await f.page.locator('aside [data-thread-id="love-chat"] .thread-title').filter({ hasText: 'Love Spot' }).waitFor();
    assert.deepEqual(await f.page.locator('aside [data-thread-id="love-chat"] .thread-link').allInnerTexts(), ['Love Spot'], 'the Love Spot group already names the origin: the chat says it once');
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
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'navigation lost the reply');
    await f.page.locator('.nav-list .love-unread').waitFor();
    assert.equal(f.turns[0].attachments.some(a => a.type === 'image'), false);
    assert.match(f.turns[0].attachments.find(a => a.type === 'text').text, /Still here when you return/);
    await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    await panel.getByText('I am here with you.', { exact: true }).waitFor(); assert.equal(f.chats.length, 1);
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
    await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Message Elpis' }).fill('What do you think?'); await f.page.getByRole('button', { name: 'Send', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.id.startsWith('love-reply-')), 'long reply missing');
    await f.page.evaluate(() => document.fonts.ready.then(() => document.fonts.load('20px Cascadia')));
    // A real nudge records the restored dimensions, rather than trusting the bridge's estimated bounds.
    const canvas = await f.page.locator('.excalidraw').boundingBox();
    await f.page.mouse.click(canvas.x + 80, canvas.y + 350); await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('ArrowRight');
    const saved = await f.waitFor(s => s.elements.some(e => e.id.startsWith('love-reply-') && e.version > 1), 'restored reply dimensions were not recorded');
    const answer = saved.elements.find(e => e.id.startsWith('love-reply-'));
    for (const e of saved.elements.filter(e => !e.isDeleted && e.id !== answer.id)) assert.ok(answer.x + answer.width <= e.x || e.x + e.width <= answer.x || answer.y + answer.height <= e.y || e.y + e.height <= answer.y, 'restored non-Latin reply overlaps another element');
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

test('the tool bar slides sideways by its grip so Talk never leaves tools out of reach, and the place is kept', async () => {
  const f = await loveSpotFixture({ colorScheme: 'dark' });
  try {
    await f.page.setViewportSize({ width: 1000, height: 760 });
    await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    const bar = f.page.locator('.love-spot-editor .App-toolbar').first(), area = f.page.locator('.love-spot-editor'), grip = f.page.getByRole('button', { name: 'Move tools' });
    const spill = async () => { const [b, a] = await Promise.all([bar.boundingBox(), area.boundingBox()]); return { left: Math.round(b.x - a.x), right: Math.round(a.x + a.width - (b.x + b.width)) }; };
    await grip.waitFor();
    const [gripBox, barBox] = await Promise.all([grip.boundingBox(), bar.boundingBox()]); assert.ok(gripBox.y + gripBox.height <= barBox.y + 1, 'the grip sits above the bar, not on a tool');
    const middle = await spill(); assert.ok(middle.left < 0 || middle.right < 0, `with Talk open the bar spills past the board: ${JSON.stringify(middle)}`);
    await grip.focus();
    await f.page.keyboard.press('ArrowDown'); // the bar sits on the other controls in a narrow board; a stroke down takes it to the first free place
    for (let i = 0; i < 40; i++) await f.page.keyboard.press('ArrowRight');
    let now = await spill(); assert.ok(now.left >= 7 && now.left <= 9, `its first tool can be brought in and the slide stops there: ${JSON.stringify(now)}`);
    for (let i = 0; i < 40; i++) await f.page.keyboard.press('ArrowLeft');
    now = await spill(); assert.ok(now.right >= 7 && now.right <= 9, `its last tool can be brought in too: ${JSON.stringify(now)}`);
    const box = await grip.boundingBox(), before = await spill();
    await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await f.page.mouse.down();
    await f.page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 }); await f.page.mouse.up();
    const dragged = await spill(); assert.ok(dragged.left - before.left >= 25, `the mouse moves the bar: ${JSON.stringify({ before, dragged })}`);
    await f.page.reload(); await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click(); await grip.waitFor();
    const kept = await spill(); assert.ok(Math.abs(kept.left - dragged.left) <= 2, `the place is kept: ${JSON.stringify({ dragged, kept })}`);
    await grip.dblclick();
    const home = await spill(); assert.ok(Math.abs(home.left - middle.left) <= 2, `double-click puts the bar back in the middle: ${JSON.stringify({ middle, home })}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 22 Oct: "I wanted to be able to move it anywhere not just horizontally. And it shouldn't interfere with the other ones either."
const touches = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
test('the tool bar moves anywhere in the board, stops against the other controls instead of covering them, and the place is kept', async () => {
  const f = await loveSpotFixture({ colorScheme: 'light' });
  try {
    await f.page.setViewportSize({ width: 1280, height: 800 });
    await f.open(f.page);
    const bar = f.page.locator('.love-spot-editor .App-toolbar').first(), area = f.page.locator('.love-spot-editor'), grip = f.page.getByRole('button', { name: 'Move tools' });
    const others = f.page.locator('.love-spot-editor').locator('.main-menu-trigger, .layer-ui__wrapper__top-right, .layer-ui__wrapper__footer-left, .layer-ui__wrapper__footer-right');
    const covers = async () => { const box = await bar.boundingBox(); const hit = []; for (const other of await others.all()) { const o = await other.boundingBox(); if (o && touches(box, o)) hit.push(await other.getAttribute('class')); } return hit; };
    const dragTo = async (x, y) => { const g = await grip.boundingBox(); await f.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await f.page.mouse.down(); await f.page.mouse.move(x, y, { steps: 12 }); await f.page.mouse.up(); };
    await grip.waitFor();
    const start = await bar.boundingBox(), board = await area.boundingBox();
    assert.deepEqual(await covers(), [], 'at the start the bar covers nothing');
    await dragTo(board.x + board.width / 2 - 150, board.y + board.height / 2 + 120);
    const moved = await bar.boundingBox();
    assert.ok(moved.y - start.y >= 150, `the bar goes down, not only sideways: ${JSON.stringify({ start, moved })}`);
    assert.ok(start.x - moved.x >= 100, 'and to the left at the same time');
    assert.deepEqual(await covers(), [], 'in the middle of the board it covers nothing');
    for (const [x, y] of [[board.x + 20, board.y + 8], [board.x + board.width - 20, board.y + 8], [board.x + 20, board.y + board.height - 8], [board.x + board.width - 20, board.y + board.height - 8]]) {
      await dragTo(x, y);
      assert.deepEqual(await covers(), [], `dragged into the corner ${Math.round(x)},${Math.round(y)} it stops against the other controls`);
      const box = await bar.boundingBox();
      assert.ok(box.x >= board.x && box.y >= board.y && box.x + box.width <= board.x + board.width + 1 && box.y + box.height <= board.y + board.height + 1 || box.width > board.width, 'and stays in the board');
    }
    await grip.focus();
    for (let i = 0; i < 12; i++) await f.page.keyboard.press('ArrowUp');
    assert.deepEqual(await covers(), [], 'arrow keys stop against the controls too');
    await dragTo(board.x + board.width / 2, board.y + board.height / 2);
    const kept = await bar.boundingBox();
    await f.page.reload(); await f.open(f.page); await grip.waitFor();
    const after = await bar.boundingBox(); assert.ok(Math.abs(after.x - kept.x) <= 2 && Math.abs(after.y - kept.y) <= 2, `the place is kept in both directions: ${JSON.stringify({ kept, after })}`);
    await grip.dblclick();
    const home = await bar.boundingBox(); assert.ok(Math.abs(home.x - start.x) <= 2 && Math.abs(home.y - start.y) <= 2, `double-click puts it back: ${JSON.stringify({ start, home })}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 22 Oct: "when I have one function somewhere I want the exact same function elsewhere": every floating bar has the one handle.
test('every bar has the same handle: lock and hand and the zoom and undo bar move on their own, and no bar covers another', async () => {
  const f = await loveSpotFixture({ colorScheme: 'dark' });
  try {
    await f.page.setViewportSize({ width: 1000, height: 760 });
    await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click();
    const handle = name => f.page.getByRole('button', { name, exact: true });
    for (const name of ['Move tools', 'Move lock and hand', 'Move zoom and undo']) await handle(name).waitFor();
    const bars = { tools: f.page.locator('.love-spot-editor section:has(.App-toolbar)').first(), extras: f.page.locator('.love-spot-editor .mobile-misc-tools-container'), bottom: f.page.locator('.love-spot-editor .App-bottom-bar > .Island') };
    const rects = async () => Object.fromEntries(await Promise.all(Object.entries(bars).map(async ([name, bar]) => [name, await bar.boundingBox()])));
    const drag = async (name, x, y) => { const g = await handle(name).boundingBox(); await f.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await f.page.mouse.down(); await f.page.mouse.move(x, y, { steps: 12 }); await f.page.mouse.up(); };
    const apart = async note => { const r = await rects(); for (const [a, b] of [['tools', 'extras'], ['tools', 'bottom'], ['extras', 'bottom']]) assert.equal(touches(r[a], r[b]), false, `${note}: ${a} and ${b} touch ${JSON.stringify(r)}`); return r; };
    const board = await f.page.locator('.love-spot-editor').boundingBox();
    const before = await apart('at the start');
    await drag('Move lock and hand', board.x + 120, board.y + board.height / 2);
    let after = await apart('lock and hand moved');
    assert.ok(Math.abs(after.extras.x - before.extras.x) > 100 && after.extras.y - before.extras.y > 100, `lock and hand move by their own handle: ${JSON.stringify({ before: before.extras, after: after.extras })}`);
    assert.deepEqual([after.tools.x, after.tools.y, after.bottom.x, after.bottom.y].map(Math.round), [before.tools.x, before.tools.y, before.bottom.x, before.bottom.y].map(Math.round), 'and nothing else moves with them');
    await drag('Move zoom and undo', board.x + 200, board.y + board.height / 2);
    after = await apart('zoom and undo moved');
    assert.ok(before.bottom.y - after.bottom.y > 40 || Math.abs(before.bottom.x - after.bottom.x) > 40, 'the bottom bar moves by its own handle');
    const middle = after.extras;
    await drag('Move tools', middle.x + middle.width / 2, middle.y + middle.height / 2);
    await apart('the tool bar dragged onto lock and hand');
    await f.page.reload(); await f.open(f.page); await f.page.getByRole('button', { name: 'Talk', exact: true }).click(); await handle('Move lock and hand').waitFor();
    const kept = await rects();
    assert.ok(Math.abs(kept.extras.x - after.extras.x) <= 2 && Math.abs(kept.extras.y - after.extras.y) <= 2, `each bar's place is kept: ${JSON.stringify({ was: after.extras, now: kept.extras })}`);
    await handle('Move lock and hand').dblclick();
    const home = await rects(); assert.ok(Math.abs(home.extras.y - before.extras.y) <= 2, 'double-click puts lock and hand back');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
