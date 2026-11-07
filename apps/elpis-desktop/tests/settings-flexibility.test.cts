// CI renderer + mock bridge: Settings keeps one standard order, its real model editor and its shortcuts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cts');
const { controlValue } = require('./controls.cts');
const settings = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
  providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} },
  memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, write: { available: true } };
const routes = { '/api/settings': () => settings };

// Masih, 23 Oct: the section titles "wouldn't make sense if I could just change the order"; "Don't make users change them".
test('SETTINGS: Configuration owns model edits and preserves custom model drafts across pages', async () => {
  let reject = false;
  let settings = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
    providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} },
    memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, write: { available: true } };
  const f = await fixture({ height: 1080, routes: { '/api/settings': (body?: { main: { model?: string; provider?: string } }) => {
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
    assert.deepEqual(f.posts.find((post: { path: string }) => post.path === '/api/settings').body, { version: 'v1', main: { model: 'my-local-model' } });
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
