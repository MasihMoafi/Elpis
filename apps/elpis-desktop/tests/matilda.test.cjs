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
    assert.equal(f.chats[0].name, 'Love Spot'); assert.match(f.chats[0].instructions, /You are Matilda/); assert.match(f.chats[0].instructions, /cannot draw on the board yourself yet/);

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
