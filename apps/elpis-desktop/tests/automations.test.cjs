// Automations (7 Nov): the page creates a task through the app's service, Run now sends its instruction, and its run
// opens the chat it ran in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

test('a new automation is listed with its schedule; Run now sends it and its run opens the chat', async () => {
  const f = await loveSpotFixture({ automations: true, reply: 'All builds are green.' });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Automations', exact: true }).click();
    await page.getByText('No automations yet').waitFor();
    await page.getByRole('button', { name: 'New automation', exact: true }).click();
    await page.getByLabel('Automation name', { exact: true }).fill('Morning check');
    await page.getByLabel('Automation instruction', { exact: true }).fill('Check last night\'s builds');
    await page.getByLabel('Time', { exact: true }).fill('09:00');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const row = page.locator('.automation').filter({ hasText: 'Morning check' });
    await row.getByText(/Every day at 09:00 · next/).waitFor();
    assert.equal(f.turns.length, 0, 'nothing is sent before its time');

    await row.getByRole('button', { name: 'Run now', exact: true }).click();
    await row.getByRole('button', { name: 'Open chat', exact: true }).waitFor();
    assert.deepEqual(f.turns.map(turn => [turn.text, turn.automatic]), [['Check last night\'s builds', true]]);
    assert.equal(f.chats.at(-1).name, 'Morning check', 'its chat is named after it');

    await row.getByRole('button', { name: 'Open chat', exact: true }).click();
    await page.locator('.message').filter({ hasText: 'All builds are green.' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
