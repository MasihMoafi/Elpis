// Matilda (A162), Masih 23 Oct: "bring that character in the excalidraw itself. in fact, remove the talk and matilda buttons. I want to type in
// the draw board, or draw something. and I EXPECT a reply from Matilda. Her face must show next to her replies." The board is the conversation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const persona = turn => turn.attachments.find(attachment => attachment.name === 'Who you are.txt')?.text;

for (const colorScheme of ['light', 'dark']) test(`Matilda's approved kiss portrait belongs to her reply in ${colorScheme} mode`, async t => {
  const f = await loveSpotFixture({ colorScheme, reply: '<!--matilda:kissPuckered--> A kiss for you.' });
  t.after(f.close);
  await f.open(f.page);
  await write(f, 'A kiss, please.');
  await answered(f, 1);
  const board = await f.scene();
  const face = board.elements.find(element => element.id === 'love-face-turn-1');
  assert.equal(face.fileId, 'matilda-face-kissPuckered');
  assert.equal(board.files[face.fileId].mimeType, 'image/webp', 'raster portraits keep their colours in dark mode');
  assert.equal(board.elements.find(element => element.id === 'love-reply-turn-1').originalText, 'A kiss for you.');
  if (process.env.ELPIS_THEME_SHOTS) {
    await require('node:fs/promises').mkdir(process.env.ELPIS_THEME_SHOTS, { recursive: true });
    await f.page.screenshot({ path: `${process.env.ELPIS_THEME_SHOTS}/portrait-${colorScheme}.png` });
  }
});
async function write(f, text, y = 300, close = true) {
  const bounds = await f.page.locator('.excalidraw').boundingBox();
  await f.page.mouse.click(bounds.x + 450, bounds.y + y); await f.page.keyboard.press('t');
  await f.page.mouse.click(bounds.x + 450, bounds.y + y); await f.page.keyboard.type(text); if (close) await f.page.keyboard.press('Escape');
}
const answered = (f, turn) => f.waitFor(s => s.elements.some(e => e.id === `love-reply-turn-${turn}` && !e.isDeleted), `Matilda did not answer turn ${turn}`, 20000);
const flower = [{ type: 'ellipse', x: 30, y: 0, width: 36, height: 36, strokeColor: '#e03131', backgroundColor: '#ffc9c9' }, { type: 'line', points: [[48, 36], [48, 110]], strokeColor: '#2f9e44' }, { type: 'text', x: 0, y: 116, text: 'for you' }];

for (const colorScheme of ['light', 'dark']) test(`what Masih writes or draws on the board is answered on the board, beside her face, with a flower she painted (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme, replyDelay: 700, reply: `A flower for you.\n\n\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\`` });
  try {
    const { page } = f;
    await f.open(page);
    for (const name of ['Talk', 'Matilda']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `there is no ${name} button`);
    assert.equal(await page.getByRole('region', { name: 'Love Spot Talk' }).count(), 0, 'and no Talk panel');

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const pasted = 'Good morning, my love.\nHere is the copied block: سلام — café.';
    await write(f, '', 300, false);
    await page.evaluate(text => navigator.clipboard.writeText(text), pasted);
    await page.keyboard.press('ControlOrMeta+v');
    const editing = page.locator('textarea.excalidraw-wysiwyg');
    assert.equal(await editing.inputValue(), pasted);
    await page.waitForTimeout(5500);
    assert.equal(f.turns.length, 0, 'a pause in a pasted note is not a finished message');
    assert.equal(await editing.evaluate(el => document.activeElement === el), true, 'the person keeps editing focus');
    const completed = pasted + '\nAnd this is the rest of my message.';
    await page.keyboard.type('\nAnd this is the rest of my message.');
    await page.waitForTimeout(5500);
    assert.equal(f.turns.length, 0, 'continued typing and another pause still do not send the open editor');
    assert.equal(await editing.inputValue(), completed);
    await page.keyboard.press('Escape');
    await page.getByText('Matilda is writing…').waitFor({ timeout: 15000 });
    const scene = await answered(f, 1), live = scene.elements.filter(e => !e.isDeleted);
    await editing.waitFor({ state: 'hidden' });
    // The bridge writes the scene before its event reaches this editor. Wait for
    // the actual board clipboard, rather than treating the disk acknowledgement as UI admission.
    let copied;
    for (let attempt = 0; attempt < 60; attempt++) {
      await page.keyboard.press('ControlOrMeta+a'); await page.evaluate(() => navigator.clipboard.writeText('')); await page.keyboard.press('ControlOrMeta+c');
      const text = await page.evaluate(() => navigator.clipboard.readText());
      try { copied = JSON.parse(text); } catch { copied = null; }
      if (copied?.elements?.some(e => e.id === 'love-reply-turn-1')) break;
      await page.waitForTimeout(50);
    }
    assert.ok(copied?.elements?.some(e => e.id === 'love-reply-turn-1'), 'her reply is on the board he is looking at');
    assert.equal(f.turns[0].text, completed, 'only the complete pasted and typed message is sent');
    assert.match(persona(f.turns[0]), /senior product designer/, 'the protocol she works by goes with it');
    assert.equal(f.chats[0].name, 'Love Spot'); assert.match(f.chats[0].instructions, /You are Matilda/); assert.match(f.chats[0].instructions, /no chat box/, 'she knows the board is where she talks');
    const note = live.find(e => e.id === 'love-reply-turn-1'), face = live.find(e => e.id === 'love-face-turn-1');
    assert.equal(note.text, 'A flower for you.'); assert.equal(face.type, 'image'); assert.ok(scene.files[face.fileId], 'her face is in the drawing');
    assert.ok(face.x + face.width <= note.x && Math.abs(face.y - note.y) <= 8, 'her face is next to her note');
    assert.deepEqual(live.filter(e => e.id.startsWith('love-paint-turn-1-')).map(e => e.type), ['ellipse', 'line', 'text'], 'her painting lands under the note');
    await page.getByText('Matilda is writing…').waitFor({ state: 'detached' });
    await page.waitForTimeout(1500);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/matilda-board-${colorScheme}.png` });
    if (colorScheme === 'dark') return assert.deepEqual(f.errors, []);

    await f.draw(page);
    await answered(f, 2);
    assert.equal(f.turns[1].text, 'I drew something on the board.', 'a drawing is answered too');
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.mouse.move(bounds.x + 500, bounds.y + 260); await page.mouse.down(); await page.mouse.move(bounds.x + 640, bounds.y + 300, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(5500);
    assert.equal(f.turns.length, 2, 'moving a shape, and her own reply, are not answered');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('who Matilda is: in the board menu, kept, and sent with what he writes', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    await f.open(page);
    const dialog = page.getByRole('dialog', { name: 'Who Matilda is' }), who = dialog.getByRole('textbox', { name: 'Who Matilda is' });
    const openWho = async () => { await page.locator('.love-spot-editor .main-menu-trigger').click(); await page.locator('.dropdown-menu').getByText('Who Matilda is…').click(); await dialog.waitFor(); };
    await openWho();
    assert.match(await who.inputValue(), /senior product designer/, 'she starts with the design protocol, not a character');
    // Her model is on the Love Spot bar, in plain sight, not inside this dialog (Masih, 23 Oct: "I can't change her model!").
    assert.equal(await dialog.getByRole('combobox').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Back to her usual way' }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Cancel' }).click(); await dialog.waitFor({ state: 'detached' });
    const model = page.getByRole('group', { name: "Matilda's model" }).getByRole('combobox');
    assert.equal(await model.getAttribute('data-value'), 'sol', 'she runs on the main model until he chooses another');

    await model.click(); await page.getByRole('option', { name: /GPT-6-Luna/ }).click();
    await openWho(); await who.fill('A patient maths tutor for a ten-year-old.'); await dialog.getByRole('button', { name: 'Save' }).click(); await dialog.waitFor({ state: 'detached' });
    await write(f, 'Explain fractions');
    for (let wait = 0; f.turns.length < 1 && wait < 400; wait++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(persona(f.turns[0]), 'A patient maths tutor for a ten-year-old.', 'she follows whatever protocol he writes');
    assert.equal(f.turns[0].model, 'luna', 'and runs on the model he chose');

    await page.reload(); await f.open(page);
    assert.equal(await model.getAttribute('data-value'), 'luna', 'her model is kept');
    await openWho();
    assert.equal(await who.inputValue(), 'A patient maths tutor for a ten-year-old.', 'and so is who she is');
    await dialog.getByRole('button', { name: 'Back to her usual way' }).click();
    assert.match(await who.inputValue(), /senior product designer/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a reply that fails is said on the board, with no face and no note', async () => {
  const f = await loveSpotFixture({ reply: '' });
  try {
    await f.open(f.page);
    await write(f, 'Are you there?');
    await f.page.getByRole('alert').filter({ hasText: 'Test provider failed' }).waitFor({ timeout: 15000 });
    assert.equal((await f.scene()).elements.filter(e => e.id.startsWith('love-')).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('a late reply preserves the active text editor and waits for its complete next note', async () => {
  const f = await loveSpotFixture({ replyDelay: 3000 });
  try {
    const { page } = f; await f.open(page);
    await write(f, 'Please answer my first note.');
    await page.getByText('Matilda is writing…').waitFor({ timeout: 15000 });
    await write(f, 'I am still writing my next note', 500, false);
    const editing = page.locator('textarea.excalidraw-wysiwyg');
    await answered(f, 1);
    await page.getByText('Matilda is writing…').waitFor({ state: 'detached' });
    assert.equal(await editing.isVisible(), true, 'an arriving reply cannot close unfinished input');
    assert.equal(await editing.evaluate(el => document.activeElement === el), true, 'an arriving reply cannot steal focus');
    await page.keyboard.type(' — now complete.');
    await page.waitForTimeout(5500);
    assert.equal(f.turns.length, 1, 'the next note stays unsent while its editor is open');
    assert.equal(await editing.inputValue(), 'I am still writing my next note — now complete.');
    await page.keyboard.press('Escape'); await answered(f, 2);
    assert.equal(f.turns[1].text, 'I am still writing my next note — now complete.');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('resuming a note while its picture is queued cancels dispatch and keeps the complete pending notes', async () => {
  const f = await loveSpotFixture();
  let release;
  try {
    const { page } = f; await f.open(page);
    await write(f, 'The first part of my message.');
    await page.getByRole('status', { name: 'Drawing save status' }).filter({ hasText: 'Saved' }).waitFor();
    await page.waitForTimeout(1800);
    const queued = page.waitForRequest(request => new URL(request.url()).pathname === '/api/love-spot/picture', { timeout: 15000 });
    const blocked = new Promise(resolve => { release = resolve; });
    await page.route('**/api/love-spot/picture', async route => { await blocked; await route.continue(); });
    await queued;
    await write(f, 'And the next part, still being written', 500, false);
    release();
    await page.waitForTimeout(5500);
    assert.equal(f.turns.length, 0, 'queued picture completion cannot send an unfinished note');
    await page.keyboard.type(' — finished.'); await page.keyboard.press('Escape');
    await answered(f, 1);
    assert.match(f.turns[0].text, /The first part of my message\./);
    assert.match(f.turns[0].text, /And the next part, still being written — finished\./);
    assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});
