// The user's name and avatar: asked once on launch (the packaged app seeds profileAsked: false), editable in Settings → General,
// shown in the sidebar's bottom row. The avatars are small files and only the chosen one loads at startup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const asking = { 'elpis-preferences-v1': JSON.stringify({ profileAsked: false }) };
const row = page => page.locator('aside.sidebar .account-row');
const dialog = page => page.getByRole('alertdialog', { name: 'What should Elpis call you?' });

test('the first launch asks for a name and an avatar, shows them in the sidebar and never asks again', async () => {
  const f = await fixture({ storage: asking }), avatars = [];
  f.page.on('request', request => { if (request.url().includes('/avatars/')) avatars.push(path.basename(request.url())); });
  try {
    await dialog(f.page).waitFor();
    const save = dialog(f.page).getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isDisabled(), true, 'a name is needed to save');
    await dialog(f.page).getByRole('textbox', { name: 'Your name', exact: true }).fill('Masih');
    await dialog(f.page).getByRole('radio', { name: 'Lucky', exact: true }).click();
    await save.click();
    await dialog(f.page).waitFor({ state: 'detached' });
    assert.equal(await row(f.page).locator('.account-name').innerText(), 'Masih');
    assert.equal(await row(f.page).locator('img.account-avatar').getAttribute('src'), '/avatars/lucky.webp');
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await dialog(f.page).count(), 0, 'it asks once');
    assert.equal(await row(f.page).locator('.account-name').innerText(), 'Masih');
    const loaded = new Set(avatars.slice(avatars.lastIndexOf('lucky.webp')));
    assert.deepEqual([...loaded], ['lucky.webp'], 'startup loads only the chosen avatar');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Not now keeps the account name and the letter, and does not ask again', async () => {
  const f = await fixture({ storage: asking });
  try {
    await dialog(f.page).waitFor();
    await dialog(f.page).getByRole('button', { name: 'Not now', exact: true }).click();
    await dialog(f.page).waitFor({ state: 'detached' });
    assert.notEqual(await row(f.page).locator('.account-name').innerText(), 'Masih');
    assert.equal(await row(f.page).locator('img.account-avatar').count(), 0);
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await dialog(f.page).count(), 0);
  } finally { await f.close(); }
});

test('Settings → General changes the name and the avatar, and choosing the avatar again clears it', async () => {
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ profileName: 'Masih', profileAvatar: 'lucky' }) } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await dialog(f.page).count(), 0, 'a saved profile is not asked for again');
    await f.page.locator('aside.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    const name = f.page.getByRole('textbox', { name: 'Your name', exact: true });
    await name.fill('M. Moafi'); await name.blur();
    await f.page.getByRole('radio', { name: 'Kingpin', exact: true }).click();
    await f.page.getByRole('button', { name: 'Back to app', exact: true }).click();
    assert.equal(await row(f.page).locator('.account-name').innerText(), 'M. Moafi');
    assert.equal(await row(f.page).locator('img.account-avatar').getAttribute('src'), '/avatars/kingpin.webp');
    await f.page.locator('aside.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await f.page.getByRole('radio', { name: 'Kingpin', exact: true }).click();
    await f.page.getByRole('button', { name: 'Back to app', exact: true }).click();
    assert.equal(await row(f.page).locator('img.account-avatar').count(), 0, 'no avatar: the first letter shows');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('each avatar is a small file', () => {
  const directory = path.resolve(__dirname, '../public/avatars'), files = fs.readdirSync(directory);
  assert.equal(files.length, 6);
  for (const file of files) assert.ok(fs.statSync(path.join(directory, file)).size < 8192, `${file} stays under 8 KB`);
});
