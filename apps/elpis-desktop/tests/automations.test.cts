// Automations (6 Nov): the page creates a task through the app's service, Run now sends its instruction, and its run
// opens the chat it ran in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cts');

test('a new automation is listed with its schedule; Run now sends it and its run opens the chat', async () => {
  const f = await loveSpotFixture({ automations: true, reply: 'All builds are green.' });
  try {
    const { page } = f;
    // Automations live in Workflows, as its Scheduled view (6 Nov).
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.getByRole('radio', { name: 'Scheduled', exact: true }).click();
    assert.equal(await page.locator('.nav-list').getByRole('button', { name: 'Automations', exact: true }).count(), 0, 'no separate Automations page');
    await page.getByText('No automations yet').waitFor();
    await page.getByRole('button', { name: 'New automation', exact: true }).click();
    await page.getByLabel('Automation name', { exact: true }).fill('Morning check');
    await page.getByLabel('Automation instruction', { exact: true }).fill('Check last night\'s builds');
    // DeepSeek's form: Repeat, then the clock picker's hour and minute columns.
    await page.getByRole('combobox', { name: 'Repeat', exact: true }).click();
    await page.getByRole('option', { name: 'Every day', exact: true }).click();
    await page.getByRole('button', { name: 'Time', exact: true }).click();
    await page.getByRole('listbox', { name: 'Hour' }).getByRole('option', { name: '09', exact: true }).click();
    await page.getByRole('listbox', { name: 'Minute' }).getByRole('option', { name: '00', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Time', exact: true }).innerText(), '09:00');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const row = page.locator('.automation').filter({ hasText: 'Morning check' });
    await row.getByText(/Every day at 09:00 \(.+\) · next/).waitFor();
    assert.equal(f.turns.length, 0, 'nothing is sent before its time');

    await row.getByRole('button', { name: 'Run now', exact: true }).click();
    await row.getByRole('button', { name: 'Open chat', exact: true }).waitFor();
    assert.deepEqual(f.turns.map((turn: { text: string; automatic: boolean }) => [turn.text, turn.automatic]), [['Check last night\'s builds', true]]);
    assert.equal(f.chats.at(-1).name, 'Morning check', 'its chat is named after it');

    await row.getByRole('button', { name: 'Open chat', exact: true }).click();
    await page.locator('.message').filter({ hasText: 'All builds are green.' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Schedule on the Workflows board opens the form with that workflow, and the list marks it', async () => {
  const f = await loveSpotFixture({ automations: true });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    const schedule = page.getByRole('button', { name: 'Schedule', exact: true });
    assert.equal(await schedule.isDisabled(), true, 'nothing to schedule before the workflow says what to do');
    await page.getByLabel('Workflow request', { exact: true }).fill('Review yesterday\'s pull requests');
    await schedule.click();
    const form = page.getByRole('region', { name: /^Schedule the workflow/ });
    await form.waitFor();
    assert.equal(await page.getByLabel('Automation instruction', { exact: true }).inputValue(), 'Review yesterday\'s pull requests');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const row = page.locator('.automation').first();
    await row.getByText('Workflow', { exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Scheduled', exact: true }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Run now on a scheduled workflow replays its saved board in the window, out of sight, and leaves the draft alone', async () => {
  const f = await loveSpotFixture({ automations: true });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.getByLabel('Workflow request', { exact: true }).fill('Summarise the open issues');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    // The draft changes after scheduling; the replay must use the saved board, and must not touch the draft.
    await page.getByRole('radio', { name: 'Board', exact: true }).click();
    await page.getByLabel('Workflow request', { exact: true }).fill('A different draft');
    await page.getByRole('radio', { name: 'Scheduled', exact: true }).click();
    const row = page.locator('.automation').first();
    await row.locator('.automation-summary').click();
    await row.getByRole('button', { name: 'Run now', exact: true }).click();
    const run = row.locator('.automation-runs li').first();
    await run.waitFor({ timeout: 30000 });
    const text = await run.innerText();
    assert.match(text, /Open chat/, `the window claimed the run and reported its chat: ${text}`);
    assert.equal(f.chats.length, 1, 'one run, one chat');
    assert.notEqual(f.chats[0].name, 'A different draft', "the run is the saved board's, not the draft's");
    await page.getByRole('radio', { name: 'Board', exact: true }).click();
    assert.equal(await page.getByLabel('Workflow request', { exact: true }).inputValue(), 'A different draft', 'the draft is untouched');
  } finally { await f.close(); }
});
