// The user's name: asked once on launch (the packaged app seeds profileAsked: false), editable in Settings → General, shown in the
// sidebar's bottom row with its first letter in a circle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const asking = { 'elpis-preferences-v1': JSON.stringify({ profileAsked: false }) };
const row = page => page.locator('aside.sidebar .account-row');
const dialog = page => page.getByRole('alertdialog', { name: 'What should Elpis call you?' });

test('the first launch asks for a name, shows it in the sidebar and never asks again', async () => {
  const f = await fixture({ storage: asking });
  try {
    await dialog(f.page).waitFor();
    const save = dialog(f.page).getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isDisabled(), true, 'a name is needed to save');
    await dialog(f.page).getByRole('textbox', { name: 'Your name', exact: true }).fill('Masih');
    await save.click();
    await dialog(f.page).waitFor({ state: 'detached' });
    assert.equal(await row(f.page).locator('.account-name').innerText(), 'Masih');
    assert.equal(await row(f.page).locator('.account-avatar').innerText(), 'M', 'the first letter shows in the circle');
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await dialog(f.page).count(), 0, 'it asks once');
    assert.equal(await row(f.page).locator('.account-name').innerText(), 'Masih');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Not now keeps the account name and does not ask again', async () => {
  const f = await fixture({ storage: asking });
  try {
    await dialog(f.page).waitFor();
    await dialog(f.page).getByRole('button', { name: 'Not now', exact: true }).click();
    await dialog(f.page).waitFor({ state: 'detached' });
    assert.notEqual(await row(f.page).locator('.account-name').innerText(), 'Masih');
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await dialog(f.page).count(), 0);
  } finally { await f.close(); }
});

test('Settings → General changes the name', async () => {
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ profileName: 'Masih' }) } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await dialog(f.page).count(), 0, 'a saved name is not asked for again');
    await f.page.locator('aside.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    const name = f.page.getByRole('textbox', { name: 'Your name', exact: true });
    await name.fill('M. Moafi'); await name.blur();
    await f.page.getByRole('button', { name: 'Back to app', exact: true }).click();
    assert.equal(await row(f.page).locator('.account-name').innerText(), 'M. Moafi');
    assert.equal(await row(f.page).locator('.account-avatar').innerText(), 'M');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
