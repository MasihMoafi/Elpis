// Matilda (A162), Masih 23 Oct: "bring that character in the excalidraw itself. in fact, remove the talk and matilda buttons. I want to type in
// the draw board, or draw something. and I EXPECT a reply from Matilda. Her face must show next to her replies." The board is the conversation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const persona = turn => turn.attachments.find(attachment => attachment.name === 'Who you are.txt')?.text;
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

    await write(f, 'Good morning, my love', 300, false); // he types and waits: the box is still open, and she still answers
    await page.getByText('Matilda is writing…').waitFor({ timeout: 15000 });
    const scene = await answered(f, 1), live = scene.elements.filter(e => !e.isDeleted);
    // He typed and left the box open: her reply closes it, so it shows on the board without his next click.
    await page.waitForFunction(() => !document.querySelector('textarea.excalidraw-wysiwyg'), null, { timeout: 5000 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('ControlOrMeta+a'); await page.evaluate(() => navigator.clipboard.writeText('')); await page.keyboard.press('ControlOrMeta+c');
    assert.ok(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).elements.some(e => e.id === 'love-reply-turn-1'), 'her reply is on the board he is looking at');
    assert.equal(f.turns[0].text, 'Good morning, my love', 'what he wrote is what she is told');
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
