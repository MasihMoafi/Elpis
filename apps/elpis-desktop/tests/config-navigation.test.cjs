const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

const sections = ['Models & accounts', 'Permissions & behavior', 'Context & maintenance', 'Connections & coding', 'App & terminal', 'Advanced'];
const settings = () => ({ version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
  smartPrune: { enabled: false, explicitOverride: { available: false } }, memory: { enabled: false, generate: false, use: false, extractionModel: null, consolidationModel: null },
  options: { defaultPermissions: 'ask' }, write: { available: true, reason: '' } });

test('/config opens six sections; a named section ignores case; an unknown name shows the list', async () => {
  const f = await fixture({ routes: { '/api/settings': settings } });
  const { page, composer } = f;
  const run = async command => { await composer.fill(command); await composer.press('Enter'); };
  try {
    await run('/config');
    await page.getByRole('heading', { name: 'Settings', exact: true, level: 2 }).waitFor();
    assert.deepEqual(await page.getByRole('heading', { level: 3 }).allTextContents(), sections);
    await page.getByRole('button', { name: 'Back to app' }).click();
    await run('/config PeRmIsSiOnS');
    await page.getByRole('heading', { name: 'Permissions & behavior', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to app' }).click();
    await run('/config no-such-section');
    assert.deepEqual(await page.getByRole('heading', { level: 3 }).allTextContents(), sections);
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
    await page.getByRole('button', { name: 'Open Configuration' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Configuration' });
    await chooseOption(panel.getByLabel('Web search', { exact: true }), 'live');
    await panel.getByRole('alert').filter({ hasText: 'changed in another client' }).waitFor();
    assert.equal(current.options.webSearch, undefined);
    assert.deepEqual(f.posts.filter(post => post.path === '/api/settings').map(post => post.body), [{ version: 'v1', options: { webSearch: 'live' } }]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
