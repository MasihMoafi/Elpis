// Matilda (A162), Masih 22 Oct: "Matilda is an agent inside of Love Spot or workflows; not her own page ... it can be for others too in that
// they can prompt her to be whatever they like her to be. For me she'd be the marketer."
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`Matilda is an agent inside Love Spot: a task goes to a chat of hers, she is the marketer until rewritten, two helpers are a switch (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    const { page } = f;
    await f.open(page);
    const nav = page.locator('aside.sidebar nav[aria-label="Workspace"]');
    assert.equal(await nav.getByRole('button', { name: 'Matilda', exact: true }).count(), 0, 'she has no page of her own');
    await page.getByRole('button', { name: 'Matilda', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Matilda', exact: true });
    await panel.getByRole('img', { name: /Matilda.s portrait/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('.matilda-portrait')?.naturalWidth > 0);
    const give = panel.getByRole('button', { name: 'Give Matilda the task', exact: true });
    assert.equal(await give.isDisabled(), true, 'nothing to give yet');
    await panel.getByRole('textbox', { name: 'Task for Matilda' }).fill('Draft a launch post for Rustidian\nKeep it short.');
    await give.click();
    await page.locator('.thread-row.active[data-thread-id="love-chat"]').waitFor();
    assert.equal(f.chats[0].name, 'Matilda · Draft a launch post for Rustidian');
    assert.equal(f.chats[0].agents, undefined, 'alone by default'); assert.equal(f.chats[0].maxAgents, undefined);
    assert.match(f.chats[0].instructions, /You are Matilda\. Masih's marketing expert/); assert.match(f.chats[0].instructions, /without helper agents/);
    assert.equal(f.turns[0].text, 'Draft a launch post for Rustidian\nKeep it short.', 'the task is her first message');

    // For anyone else she is whatever they write: who she is is kept, and the two-helpers switch sends the cap with the chat.
    await f.open(page);
    await page.getByRole('button', { name: 'Matilda', exact: true }).click();
    await panel.getByText('Who she is', { exact: true }).click();
    const persona = panel.getByRole('textbox', { name: 'Who Matilda is' });
    assert.match(await persona.inputValue(), /marketing expert/, 'she starts as the marketer');
    await persona.fill('A patient maths tutor for a ten-year-old.'); await panel.getByRole('textbox', { name: 'Task for Matilda' }).click();
    await panel.getByRole('switch', { name: 'Let Matilda use two helpers' }).click();
    await panel.getByRole('textbox', { name: 'Task for Matilda' }).fill('Explain fractions');
    await panel.getByRole('button', { name: 'Give Matilda the task', exact: true }).click();
    await page.locator('.thread-row.active[data-thread-id="love-chat-2"]').waitFor();
    assert.equal(f.chats[1].agents, true); assert.equal(f.chats[1].maxAgents, 2);
    assert.match(f.chats[1].instructions, /You are Matilda\. A patient maths tutor/); assert.doesNotMatch(f.chats[1].instructions, /marketing expert/);
    assert.match(f.chats[1].instructions, /at most 2 helper agents/);

    await page.reload(); await f.open(page);
    await page.getByRole('button', { name: 'Matilda', exact: true }).click();
    await panel.getByText('Who she is', { exact: true }).click();
    assert.equal(await persona.inputValue(), 'A patient maths tutor for a ten-year-old.', 'who she is is kept');
    await panel.getByRole('button', { name: 'Back to the marketer' }).click();
    assert.match(await persona.inputValue(), /marketing expert/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
