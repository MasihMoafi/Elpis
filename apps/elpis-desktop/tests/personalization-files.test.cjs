// S4, R40: a file that does not exist reads "Not created yet", and a file that exists can be previewed rendered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const { settingsBody } = require('./settings-fixture.cjs');

const home = '/home/person/.elpis-next';
const routes = {
  '/api/settings': () => settingsBody(),
  '/api/settings/files/instructions': () => ({ path: `${home}/AGENTS.md`, content: '', version: 'missing' }),
  '/api/settings/files/memory': () => ({ path: `${home}/memories/MEMORY.md`, content: '# Saved memory\n\n- Prefers short replies', version: 'v1' }),
};

test('a missing instructions file says so and a memory file previews rendered', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await openSettings(page); await page.getByRole('tab', { name: 'Personalization', exact: true }).click();
    const instructions = page.getByRole('region', { name: 'Global instructions', exact: true });
    await instructions.getByText(`${home}/AGENTS.md · not created yet`).waitFor();
    assert.match(await instructions.getByRole('textbox', { name: 'Global instructions', exact: true }).getAttribute('placeholder'), /Not created yet/);
    await instructions.getByRole('radio', { name: 'Preview', exact: true }).click();
    await instructions.getByText(/Not created yet\. Switch to Edit and save to create it\./).waitFor();

    const memory = page.getByRole('region', { name: 'Memory file', exact: true });
    await memory.getByText(`${home}/memories/MEMORY.md`, { exact: true }).waitFor();
    assert.match(await memory.getByRole('textbox', { name: 'Memory file', exact: true }).inputValue(), /^# Saved memory/);
    await memory.getByRole('radio', { name: 'Preview', exact: true }).click();
    await memory.getByRole('heading', { name: 'Saved memory', exact: true }).waitFor();
    assert.equal(await memory.getByRole('listitem').filter({ hasText: 'Prefers short replies' }).count(), 1);
    assert.equal(await memory.getByRole('textbox').count(), 0, 'the preview replaces the editor');
    await memory.getByRole('radio', { name: 'Edit', exact: true }).click();
    assert.equal(await memory.getByRole('textbox', { name: 'Memory file', exact: true }).isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
