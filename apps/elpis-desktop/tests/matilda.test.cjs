// Matilda (A162), Masih 22 Oct: "Make her the default agent in the love-spot, like my lover ... it can be for others too in that they can
// prompt her to be whatever they like her to be." She is the one who talks in Love Spot; who she is is kept and goes with every message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const persona = turn => turn.attachments.find(attachment => attachment.name === 'Who you are.txt')?.text;

for (const colorScheme of ['light', 'dark']) test(`Matilda is the default agent of Love Spot: her portrait is in Talk, who she is is kept and goes with every message (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    const { page } = f;
    await f.open(page);
    assert.equal(await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Matilda', exact: true }).count(), 0, 'she has no page of her own');
    assert.equal(await page.getByRole('button', { name: 'Matilda', exact: true }).count(), 0, 'and no button of her own');
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Love Spot Talk' });
    await panel.getByRole('img', { name: /Matilda.s portrait/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('.love-spot-talk img')?.naturalWidth > 0);
    const dialog = page.getByRole('dialog', { name: 'Who Matilda is' });
    await panel.getByRole('button', { name: 'Who she is', exact: true }).click();
    const who = dialog.getByRole('textbox', { name: 'Who Matilda is' });
    assert.match(await who.inputValue(), /Masih's partner/, 'she starts as his partner');
    assert.equal(await dialog.getByRole('button', { name: 'Back to her usual self' }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Cancel' }).click(); await dialog.waitFor({ state: 'detached' });

    await panel.getByRole('textbox', { name: 'Message Matilda' }).fill('Hello, my love');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.love-spot-talk')?.textContent.includes('I am here with you.'));
    assert.match(persona(f.turns[0]), /Masih's partner/, 'who she is goes with the message');
    assert.equal(f.chats[0].name, 'Love Spot'); assert.match(f.chats[0].instructions, /You are Matilda/); assert.match(f.chats[0].instructions, /```excalidraw/, 'she knows she can paint');

    await panel.getByRole('button', { name: 'Who she is', exact: true }).click();
    await who.fill('A patient maths tutor for a ten-year-old.'); await dialog.getByRole('button', { name: 'Save' }).click(); await dialog.waitFor({ state: 'detached' });
    await panel.getByRole('textbox', { name: 'Message Matilda' }).fill('Explain fractions');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    for (let wait = 0; f.turns.length < 2 && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(persona(f.turns[1]), 'A patient maths tutor for a ten-year-old.', 'she becomes whatever he writes');

    await page.reload(); await f.open(page); await page.getByRole('button', { name: 'Talk', exact: true }).click();
    await panel.getByRole('button', { name: 'Who she is', exact: true }).click();
    assert.equal(await who.inputValue(), 'A patient maths tutor for a ten-year-old.', 'who she is is kept');
    await dialog.getByRole('button', { name: 'Back to her usual self' }).click();
    assert.match(await who.inputValue(), /Masih's partner/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 22 Oct: "She can! on the board ... it's excalidraw." She paints with a fenced excalidraw block in her reply.
const flower = [{ type: 'ellipse', x: 30, y: 0, width: 36, height: 36, strokeColor: '#e03131', backgroundColor: '#ffc9c9' }, { type: 'line', points: [[48, 36], [48, 110]], strokeColor: '#2f9e44' }, { type: 'text', x: 0, y: 116, text: 'for you' }];
for (const colorScheme of ['light', 'dark']) test(`Matilda paints on the board: her shapes land beside her note and the panel shows only the note (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme, reply: `A flower for you.\n\n\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\`` });
  try {
    const { page } = f;
    await f.open(page);
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Love Spot Talk' });
    await panel.getByRole('textbox', { name: 'Message Matilda' }).fill('Hello, my love');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    const scene = await f.waitFor(s => s.elements.filter(e => e.id.startsWith('love-paint-') && !e.isDeleted).length === 3, 'her painting did not land on the board');
    assert.deepEqual(scene.elements.filter(e => e.id.startsWith('love-paint-')).map(e => e.type), ['ellipse', 'line', 'text']);
    assert.equal(scene.elements.find(e => e.id.startsWith('love-reply-')).text, 'A flower for you.');
    await panel.getByText('A flower for you.', { exact: true }).waitFor();
    assert.doesNotMatch(await panel.innerText(), /excalidraw|ellipse/, 'the panel shows the note, not the block');
    await page.waitForTimeout(1500);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/matilda-paints-${colorScheme}.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
