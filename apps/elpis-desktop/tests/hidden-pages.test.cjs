// S8, S12, S18: the packaged app ships Lab, Workflows and the Session Manager hidden (desktop/preferences.cjs); their code and tests stay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

const source = file => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
const shipped = { 'elpis-preferences-v1': JSON.stringify({ hiddenPages: 'experimentLab,canvas', sessionManager: false }) };
const workflowChat = { id: 'chat-w', name: 'Workflows · demo', preview: 'Workflows · demo', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
const nav = page => page.locator('aside.sidebar nav[aria-label="Workspace"]');

test('the shell ships Lab, Workflows and the Session Manager hidden; the renderer shows everything by default', () => {
  assert.match(source('../desktop/preferences.cjs'), /SHIPPED_DEFAULTS = \{ hiddenPages: 'experimentLab,canvas', sessionManager: false \}/);
  assert.match(source('../desktop/main.cjs'), /await seedShippedDefaults\(store\)/);
  assert.match(source('../lib/preferences.ts'), /hiddenPages: "", sessionManager: true/);
  assert.match(source('../desktop/state.cjs'), /hiddenPages: 'string', sessionManager: 'boolean'/);
});

test('hidden pages leave the sidebar, the command menu and the Workflows chat group', async () => {
  const f = await fixture({ storage: shipped, threads: [workflowChat, { ...workflowChat, id: 'chat-a', name: 'Fix the parser', preview: 'Fix the parser' }] });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.deepEqual(await nav(f.page).getByRole('button').allTextContents(), ['New chat', 'Love Spot', 'Ledger']);
    await f.page.keyboard.press('Control+k');
    const search = f.page.getByRole('combobox', { name: 'Search or start a chat' });
    for (const name of ['Lab', 'Workflows', 'Guide to managing agents']) {
      await search.fill(name);
      assert.equal(await f.page.getByRole('option', { name: new RegExp(`^${name}$`) }).count(), 0, `${name} is not in the command menu`);
    }
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.getByText('Agent chats', { exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('region', { name: 'Session Manager chat' }).count(), 0, 'the Session Manager row is hidden');
    assert.equal(await f.page.locator('aside.sidebar').getByText('Workflows · demo').count(), 0, 'the Workflows chat is not listed');
    assert.equal(await f.page.locator('aside.sidebar').getByText('Fix the parser').count() > 0, true, 'ordinary chats stay');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('with hiddenPages empty, every page shows, as before', async () => {
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ hiddenPages: '' }) } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.deepEqual(await nav(f.page).getByRole('button').allTextContents(), ['New chat', 'Lab', 'Workflows', 'Love Spot', 'Ledger']);
    assert.equal(await f.page.getByRole('region', { name: 'Session Manager chat' }).count(), 1, 'tests see the Session Manager row');
  } finally { await f.close(); }
});
