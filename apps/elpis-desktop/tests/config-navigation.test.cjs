const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

const settings = () => ({ version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
  smartPrune: { enabled: false, explicitOverride: { available: false } }, memory: { enabled: false, generate: false, use: false, extractionModel: null, consolidationModel: null },
  options: { defaultPermissions: 'ask' }, write: { available: true, reason: '' } });

test('/config aliases open working pages; category labels never open link-only overviews', async () => {
  const f = await fixture({ routes: { '/api/settings': settings } });
  const { page, composer } = f;
  const run = async command => { await composer.fill(command); await composer.press('Enter'); };
  try {
    for (const [command, title] of [
      ['/config', 'Configuration'], ['/config models', 'Models & accounts'],
      ['/config PeRmIsSiOnS', 'Configuration'], ['/config context', 'Personalization'],
      ['/config connections', 'MCP servers'], ['/config app', 'General'],
      ['/config advanced', 'Configuration'], ['/config no-such-section', 'Configuration'],
    ]) {
      await run(command);
      await page.getByRole('tabpanel', { name: title, exact: true }).waitFor();
      const nav = page.getByRole('navigation', { name: 'Settings navigation' });
      const groups = await nav.locator('.settings-nav-group').evaluateAll(groups => groups.map(group => ({
        label: group.querySelector('.section-label').textContent,
        clickable: group.querySelector('.section-label').matches('button, a, [role="button"], [tabindex]'),
        pages: group.querySelectorAll('[role="tab"]').length,
      })));
      assert.deepEqual(groups.map(group => group.label), ['Personal', 'Integrations', 'Coding', 'Archived']);
      assert.ok(groups.every(group => group.pages > 0 && !group.clickable), JSON.stringify(groups));
      assert.equal(await page.getByRole('button', { name: /^Open (Models & accounts|Configuration|Personalization|General)$/ }).count(), 0);
      await page.getByRole('button', { name: 'Back to app' }).click();
    }
    await run('/config');
    const search = page.getByRole('textbox', { name: 'Search settings', exact: true });
    await search.fill('memories');
    const nav = page.getByRole('navigation', { name: 'Settings navigation' });
    assert.deepEqual(await nav.getByRole('tab').allTextContents(), ['Personalization']);
    await nav.getByRole('tab', { name: 'Personalization', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('tabpanel', { name: 'Personalization', exact: true }).waitFor();
    await search.fill('no-such-setting');
    await nav.getByText('No setting matches.', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('changing this chat’s permissions does not write the new-chats default', async () => {
  const f = await fixture({ routes: { '/api/settings': settings,
    '/api/threads/chat-a/permissions': () => ({ permissions: 'auto' }) } });
  const { page, composer } = f;
  try {
    await f.open('chat-a');
    await composer.fill('/config permissions'); await composer.press('Enter');
    await page.getByRole('button', { name: 'Change this chat permissions' }).click();
    await page.getByRole('menuitem', { name: /Approve for me/ }).waitFor();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/threads/chat-a/permissions'));
    await page.getByRole('menuitem', { name: /Approve for me/ }).click();
    await saved;
    assert.deepEqual(f.posts.filter(post => post.path === '/api/settings'), []);
    assert.deepEqual(f.posts.filter(post => post.path.endsWith('/permissions')).map(post => post.body), [{ permissions: 'auto' }]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a stale new-chats write reports the conflict and keeps the saved value', async () => {
  const current = settings();
  const f = await fixture({ routes: { '/api/settings': body => body
    ? { __http: 409, error: 'Settings changed in another client. Reload settings before saving again.' }
    : current } });
  const { page, composer } = f;
  try {
    await composer.fill('/config permissions'); await composer.press('Enter');
    const panel = page.getByRole('tabpanel', { name: 'Configuration' });
    await chooseOption(panel.getByLabel('Web search', { exact: true }), 'live');
    await panel.getByRole('alert').filter({ hasText: 'changed in another client' }).waitFor();
    assert.equal(current.options.webSearch, undefined);
    assert.deepEqual(f.posts.filter(post => post.path === '/api/settings').map(post => post.body), [{ version: 'v1', options: { webSearch: 'live' } }]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
