const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture: startFixture } = require('./parity-fixture.cjs');
async function fixture(options) {
  const f = await startFixture(options);
  await f.page.getByRole('status', { name: 'Elpis is starting' }).waitFor({ state: 'detached', timeout: 10000 });
  return f;
}

const topics = ['One agent or many', 'Mother agent and Father agent', 'Writers and checks', 'Choose a pattern', 'Read a run'];
const guide = page => page.getByRole('region', { name: 'Guide to managing agents' });
async function command(page, name) {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search or start a chat' }).fill(name);
  await page.getByRole('option', { name: new RegExp('^' + name) }).click();
}

test('arrow keys do not advance guide topics; mouse selection still works', async () => {
  const f = await fixture(), { page } = f;
  try {
    await command(page, 'Guide');
    const current = guide(page).getByRole('button', { name: 'Choose a pattern', exact: true });
    await current.click();
    await guide(page).getByRole('heading', { name: 'Choose a pattern' }).waitFor();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Choose a pattern');
    assert.ok(await guide(page).getByText('Debate + judge', { exact: true }).isVisible());
    await guide(page).getByRole('button', { name: 'Read a run', exact: true }).click();
    await guide(page).getByRole('heading', { name: 'Read a run' }).waitFor();
  } finally { await f.close(); }
});
