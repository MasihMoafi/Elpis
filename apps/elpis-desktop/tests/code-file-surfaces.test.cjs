const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const file = '/tmp/code-open-outside/config.toml';
async function open(routes = {}) {
  const f = await fixture({ width: 1280, height: 850, routes: {
    '/api/file': () => ({ content: 'setting = true\n', size: 15, mtimeMs: 1 }),
    '/api/files/dir': () => ({ data: [] }),
    '/api/settings': () => ({ version: '1', main: { model: null, provider: null }, background: { model: null, provider: null }, smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, options: {}, write: { available: false, reason: 'Fixture' } }), ...routes,
  } });
  await f.open('chat-a'); return f;
}
const contents = page => page.getByRole('textbox', { name: `Contents of ${file}`, exact: true });

test('an approval file path opens Files by Enter without answering or dismissing the approval', async () => {
  const f = await open();
  try {
    f.emit('approval', { id: 'file-request', ownerThreadId: 'chat-a', method: 'item/fileChange/requestApproval', params: { threadId: 'chat-a', changes: { [file]: { type: 'update' } }, reason: 'Edit the config' } });
    const card = f.page.locator('.approval');
    const ref = card.getByRole('button', { name: file, exact: true });
    await ref.focus(); await f.page.keyboard.press('Enter');
    await contents(f.page).waitFor();
    assert.equal(await card.isVisible(), true);
    assert.equal(f.posts.filter(post => post.path.includes('approval')).length, 0);
  } finally { await f.close(); }
});

test('Observability diagnostic paths open Files', async () => {
  const f = await open({ '/api/observability': () => ({ __http: 500, error: `Could not read ${file}` }) });
  try {
    await f.page.getByRole('button', { name: 'Observability', exact: true }).click();
    await f.page.locator('.observability').getByRole('button', { name: file, exact: true }).click();
    await contents(f.page).waitFor();
  } finally { await f.close(); }
});

test('Settings config file opens the visible Files pane', async () => {
  const f = await open({ '/api/mcp': () => ({ configPath: file }) });
  try {
    await openSettings(f.page);
    await f.page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    await f.page.getByRole('button', { name: file, exact: true }).click();
    await contents(f.page).waitFor();
    assert.equal(await f.page.getByRole('region', { name: 'Side panel', exact: true }).isVisible(), true);
  } finally { await f.close(); }
});

test('Settings hook source opens in Files', async () => {
  const f = await open({ '/api/hooks': () => ({ version: '1', write: { available: true }, hooks: [{ key: 'hook', event: 'preToolUse', handler: 'command', command: 'echo checked', sourcePath: file, enabled: true, managed: false, trust: 'trusted' }], warnings: [], errors: [] }) });
  try {
    await openSettings(f.page);
    await f.page.getByRole('tab', { name: 'Hooks', exact: true }).click();
    await f.page.getByRole('button', { name: file, exact: true }).click();
    await contents(f.page).waitFor();
  } finally { await f.close(); }
});
