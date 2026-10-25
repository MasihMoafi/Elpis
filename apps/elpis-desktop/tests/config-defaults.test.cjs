const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { chooseOption, controlValue } = require('./controls.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

test('/config models edits the shared default reasoning effort and re-reads it', async () => {
  const saved = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
    smartPrune: { enabled: false, explicitOverride: { available: false } }, memory: {},
    options: { reasoningEffort: 'medium' }, write: { available: true } };
  const f = await fixture({ routes: { '/api/settings': body => {
    if (body) { assert.deepEqual(body, { version: saved.version, options: { reasoningEffort: 'high' } }); saved.options.reasoningEffort = 'high'; saved.version = 'v2'; }
    return saved;
  } } });
  try {
    await f.composer.fill('/config models'); await f.composer.press('Enter');
    await f.page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    if (process.env.A32_SHOTS) {
      await fs.mkdir(process.env.A32_SHOTS, { recursive: true });
      for (const dark of [false, true]) {
        await f.page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
        await f.page.screenshot({ path: path.join(process.env.A32_SHOTS, `baseline-${dark ? 'dark' : 'light'}.png`) });
      }
    }
    const effort = f.page.getByLabel('Default reasoning effort', { exact: true });
    await effort.waitFor({ timeout: 5000 });
    await chooseOption(effort, 'high');
    await f.page.getByRole('status').filter({ hasText: 'Default reasoning effort saved' }).waitFor();
    assert.equal(saved.options.reasoningEffort, 'high');
    assert.equal(f.posts.filter(post => post.path === '/api/settings').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('/config models opens this chat model control without changing defaults', async () => {
  const f = await fixture();
  try {
    await f.open('chat-a');
    await f.composer.fill('/config models'); await f.composer.press('Enter');
    await f.page.getByRole('button', { name: 'Change this chat model', exact: true }).click({ timeout: 5000 });
    await f.page.getByLabel('Search models', { exact: true }).waitFor();
    assert.deepEqual(f.posts.filter(post => post.path === '/api/settings'), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('reopening /config models re-reads a default saved by another client', async () => {
  const saved = { version: 'v1', main: { model: null, provider: 'openai' }, background: { model: null, provider: null },
    smartPrune: { enabled: false, explicitOverride: { available: false } }, memory: {}, options: {}, write: { available: true } };
  const f = await fixture({ routes: { '/api/settings': () => saved } });
  try {
    await f.composer.fill('/config models'); await f.composer.press('Enter');
    const model = f.page.getByRole('combobox', { name: 'Default model', exact: true });
    await model.waitFor();
    assert.equal(await controlValue(model), '', 'an unset default stays unset in the inline editor');
    await f.page.getByRole('button', { name: 'Back to app' }).click();
    saved.main.model = 'sol'; saved.version = 'v2';
    await f.composer.fill('/config models'); await f.composer.press('Enter');
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Default model"][role="combobox"]')?.getAttribute('data-value') === 'sol');
    assert.equal(await controlValue(model), 'sol', 'reopening reads the default saved by another client');
    assert.deepEqual(f.posts.filter(post => post.path === '/api/settings'), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
