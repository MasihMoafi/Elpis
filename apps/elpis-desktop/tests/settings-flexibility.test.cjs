// CI renderer + mock bridge: regression checks; acceptance uses settings-flexibility.runtime.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const { crossGroup, layout, group } = require('./settings-flexibility-check.cjs');
const { controlValue } = require('./controls.cjs');
const settings = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
  providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} },
  memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, write: { available: true } };
const routes = { '/api/settings': () => settings };

for (const theme of ['light', 'dark']) test(`SETTINGS: cross-group drag, empty group, cancel and reload (${theme})`, async () => {
  const f = await fixture({ height: 1080, routes, storage: { 'elpis-theme': theme } });
  try {
    await crossGroup(f.page, { theme, shots: process.env.ELPIS_SETTINGS_SHOTS });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const [name, settingsPageGroups] of [
  ['valid move mixed with unknown pages, unknown groups and missing ids', JSON.stringify({ general: 'context', obsolete: 'app', voice: 'removed-group' })],
  ['malformed membership', '{broken'],
  ['wrong membership type', JSON.stringify(['app'])],
]) test(`SETTINGS: saved layout loads with ${name}`, async () => {
  const valid = name.startsWith('valid');
  const f = await fixture({ height: 1080, routes, storage: { 'elpis-preferences-v1': JSON.stringify({
    settingsSectionOrder: 'unknown,context,context', settingsPageOrder: 'obsolete,general,general', settingsPageGroups,
  }) } });
  try {
    await openSettings(f.page);
    const actual = await layout(f.page), ids = actual.flatMap(item => item.pages);
    assert.equal(actual[0].name, 'Context & maintenance');
    assert.equal(actual.length, 6);
    assert.equal(ids.length, 15);
    assert.equal(new Set(ids).size, 15);
    assert.ok(!(ids.some(id => id.includes('obsolete'))));
    const destination = group(f.page, valid ? 'Context & maintenance' : 'App & terminal');
    assert.ok((await destination.getByRole('tab').allTextContents()).includes('General'), 'known page membership loads; invalid data falls back');
    await f.page.reload(); await openSettings(f.page);
    assert.deepEqual(await layout(f.page), actual);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('SETTINGS: failed cross-group persistence preserves membership and explains why', async () => {
  const f = await fixture({ height: 1080, routes });
  try {
    await openSettings(f.page);
    const before = await layout(f.page);
    await f.page.evaluate(() => { window.elpisDesktop.storage.setItem = () => { throw Error('SETTINGS storage refused'); }; });
    const { drag } = require('./settings-reorder-check.cjs');
    const { pageRow } = require('./settings-flexibility-check.cjs');
    await drag(f.page, pageRow(f.page, 'Personalization'), pageRow(f.page, 'General'));
    await f.page.getByRole('alert').filter({ hasText: 'Could not save Settings order: SETTINGS storage refused' }).waitFor();
    assert.deepEqual(await layout(f.page), before);
  } finally { await f.close(); }
});

test('SETTINGS: overview model edits in place and catalog-backed models allow a custom id', async () => {
  let reject = false;
  let settings = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
    providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} },
    memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, write: { available: true } };
  const f = await fixture({ height: 1080, routes: { '/api/settings': body => {
    if (body && reject) return { __http: 409, error: 'Settings changed elsewhere. Reload before saving.' };
    if (body) settings = { ...settings, version: 'v2', main: { ...settings.main, ...body.main } };
    return settings;
  } } });
  try {
    await openSettings(f.page);
    await f.page.locator('.settings-nav [data-slot="section-link"]').filter({ hasText: 'Models & accounts' }).click();
    const control = f.page.getByLabel('Default model', { exact: true });
    await control.waitFor();
    const custom = f.page.getByRole('group', { name: 'Default model choices', exact: true });
    await custom.locator('summary').click();
    await custom.getByRole('textbox', { name: 'Custom Default model', exact: true }).fill('my-local-model');
    await f.page.getByRole('button', { name: 'Save main model', exact: true }).click();
    await f.page.getByRole('status').filter({ hasText: 'Main model saved' }).waitFor();
    assert.deepEqual(f.posts.find(post => post.path === '/api/settings').body, { version: 'v1', main: { model: 'my-local-model' } });
    await f.page.reload(); await openSettings(f.page);
    await f.page.locator('.settings-nav [data-slot="section-link"]').filter({ hasText: 'Models & accounts' }).click();
    assert.equal(await controlValue(f.page.getByLabel('Default model', { exact: true })), 'my-local-model');
    reject = true;
    const choices = f.page.getByRole('group', { name: 'Default model choices', exact: true });
    await choices.locator('summary').click();
    const draft = choices.getByRole('textbox', { name: 'Custom Default model', exact: true });
    await draft.fill('keep-this-draft');
    await f.page.getByRole('tab', { name: 'General', exact: true }).click();
    await f.page.locator('.settings-nav [data-slot="section-link"]').filter({ hasText: 'Models & accounts' }).click();
    assert.equal(await draft.inputValue(), 'keep-this-draft', 'switching Settings pages preserves the overview draft');
    await f.page.getByRole('button', { name: 'Save main model', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: 'Settings changed elsewhere' }).waitFor();
    assert.equal(await draft.inputValue(), 'keep-this-draft', 'a rejected save preserves the custom model draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('SETTINGS: keyboard movement crosses groups, keeps focus and survives reload', async () => {
  const f = await fixture({ height: 1080, routes });
  try {
    await openSettings(f.page);
    const { pageRow } = require('./settings-flexibility-check.cjs');
    const firstAppPage = pageRow(f.page, 'General');
    await firstAppPage.focus(); await f.page.keyboard.press('Alt+ArrowUp');
    assert.deepEqual((await group(f.page, 'Connections & coding').getByRole('tab').allTextContents()).slice(-2), ['General', 'Hooks']);
    await f.page.waitForFunction(() => document.activeElement?.id === 'settings-tab-general');
    await pageRow(f.page, 'About').focus(); await f.page.keyboard.press('Alt+ArrowDown');
    assert.deepEqual(await group(f.page, 'Advanced').getByRole('tab').allTextContents(), ['About'], 'keyboard movement also reaches an empty group');
    const expected = await layout(f.page);
    await f.page.reload(); await openSettings(f.page);
    assert.deepEqual(await layout(f.page), expected);
  } finally { await f.close(); }
});

test('SETTINGS: app shortcuts change in place, reject conflicts, persist, and reset', async () => {
  const f = await fixture({ height: 1080, routes });
  try {
    await openSettings(f.page);
    await f.page.getByRole('tab', { name: 'Keyboard shortcuts', exact: true }).click();
    const recorder = f.page.getByRole('button', { name: 'Shortcut for Settings', exact: true });
    await recorder.press('Control+n');
    await f.page.getByRole('alert').filter({ hasText: 'already used by New chat' }).waitFor();
    await recorder.press('Control+Alt+y');
    await f.page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await f.page.keyboard.press('Control+,');
    assert.equal(await f.page.locator('.settings-nav').isVisible(), false, 'the replaced binding is inactive');
    await f.page.keyboard.press('Control+Alt+y');
    await f.page.locator('.settings-nav').waitFor();
    await f.page.reload(); await openSettings(f.page);
    await f.page.getByRole('tab', { name: 'Keyboard shortcuts', exact: true }).click();
    assert.match(await recorder.textContent(), /Y/);
    await f.page.getByRole('button', { name: 'Reset shortcut for Settings', exact: true }).click();
    await f.page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await f.page.keyboard.press('Control+,');
    await f.page.locator('.settings-nav').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
