// CI renderer + mock bridge: Settings keeps one standard order, its real model editor and its shortcuts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const { layout } = require('./settings-flexibility-check.cjs');
const { controlValue } = require('./controls.cjs');
const settings = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
  providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} },
  memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, write: { available: true } };
const routes = { '/api/settings': () => settings };

// Masih, 23 Oct: the section titles "wouldn't make sense if I could just change the order"; "Don't make users change them".
test('SETTINGS: one standard order that cannot be dragged or moved, and an order saved by an older version is ignored', async () => {
  const fresh = await fixture({ height: 1080, routes });
  let standard;
  try { await openSettings(fresh.page); standard = await layout(fresh.page); } finally { await fresh.close(); }
  // Masih, 27 Oct: Settings grouped as ChatGPT's (d79d50cbe): Personal, Integrations, Coding, Archived.
  assert.deepEqual(standard.map(item => item.name), ['Personal', 'Integrations', 'Coding', 'Archived']);
  assert.equal(new Set(standard.flatMap(item => item.pages)).size, standard.flatMap(item => item.pages).length);
  const f = await fixture({ height: 1080, routes, storage: { 'elpis-preferences-v1': JSON.stringify({
    settingsSectionOrder: 'advanced,app,models,permissions,context,connections', settingsPageOrder: 'about,general', settingsPageGroups: JSON.stringify({ general: 'advanced' }),
  }) } });
  try {
    await openSettings(f.page);
    assert.deepEqual(await layout(f.page), standard);
    const nav = f.page.getByRole('navigation', { name: 'Settings navigation' });
    assert.equal(await nav.locator('[draggable="true"]').count(), 0, 'nothing in Settings can be dragged');
    await nav.getByRole('tab', { name: 'General' }).focus(); await f.page.keyboard.press('Alt+ArrowUp');
    assert.deepEqual(await layout(f.page), standard, 'Alt+Up moves nothing');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('SETTINGS: Configuration owns model edits and preserves custom model drafts across pages', async () => {
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
    await f.page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    const control = f.page.getByLabel('Main model', { exact: true });
    await control.waitFor();
    const custom = f.page.getByRole('group', { name: 'Main model choices', exact: true });
    await custom.locator('summary').click();
    await custom.getByRole('textbox', { name: 'Custom Main model', exact: true }).fill('my-local-model');
    await f.page.getByRole('button', { name: 'Save main model', exact: true }).click();
    await f.page.getByRole('status').filter({ hasText: 'Main model saved' }).waitFor();
    assert.deepEqual(f.posts.find(post => post.path === '/api/settings').body, { version: 'v1', main: { model: 'my-local-model' } });
    await f.page.reload(); await openSettings(f.page);
    await f.page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    assert.equal(await controlValue(f.page.getByLabel('Main model', { exact: true })), 'my-local-model');
    reject = true;
    const choices = f.page.getByRole('group', { name: 'Main model choices', exact: true });
    await choices.locator('summary').click();
    const draft = choices.getByRole('textbox', { name: 'Custom Main model', exact: true });
    await draft.fill('keep-this-draft');
    await f.page.getByRole('tab', { name: 'General', exact: true }).click();
    await f.page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    assert.equal(await draft.inputValue(), 'keep-this-draft', 'switching Settings pages preserves the model draft');
    await f.page.getByRole('button', { name: 'Save main model', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: 'Settings changed elsewhere' }).waitFor();
    assert.equal(await draft.inputValue(), 'keep-this-draft', 'a rejected save preserves the custom model draft');
    assert.deepEqual(f.errors, []);
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
