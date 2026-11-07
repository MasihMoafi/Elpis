// S8, S12, S18: the packaged app ships Lab and Workflows hidden and (desktop/preferences.cjs); their code and tests stay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const workflowChat = { id: 'chat-w', name: 'Workflows · demo', preview: 'Workflows · demo', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
const nav = (page: { locator: (selector: string) => { getByRole: (role: string) => { allTextContents: () => Promise<string[]> } } }) => page.locator('aside.sidebar nav[aria-label="Workspace"]');

for (const hideMother of [false, true]) test(`hidden pages leave the sidebar, the command menu and the Workflows chat group; Mother ${hideMother ? 'hidden' : 'visible'}`, async () => {
  const storage = { 'elpis-preferences-v1': JSON.stringify({ hiddenPages: `experimentLab,canvas${hideMother ? ',mother' : ''}` }) };
  const f = await fixture({ storage, threads: [workflowChat, { ...workflowChat, id: 'chat-a', name: 'Fix the parser', preview: 'Fix the parser' }] });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.deepEqual(await nav(f.page).getByRole('button').allTextContents(), ['New chat', 'Love Spot', ...(hideMother ? [] : ['Mother']), 'Observability', 'Customize']);
    await f.page.keyboard.press('Control+k');
    const search = f.page.getByRole('combobox', { name: 'Search or start a chat' });
    for (const name of ['Lab', 'Workflows', 'Guide to managing agents', ...(hideMother ? ['Mother'] : [])]) {
      await search.fill(name);
      assert.equal(await f.page.getByRole('option', { name: new RegExp(`^${name}$`) }).count(), 0, `${name} is not in the command menu`);
    }
    if (!hideMother) {
      await search.fill('Mother');
      assert.equal(await f.page.getByRole('option', { name: 'Mother', exact: true }).count(), 1, 'visible Mother stays in the command menu');
    }
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.getByText('Agent chats', { exact: true }).count(), 0);
    assert.equal(await f.page.getByText('Session Manager', { exact: true }).count(), 0, 'the Session Manager is gone (Masih, 23 Oct: "either fix it; if you can\'t, delete it")');
    assert.equal(await f.page.locator('aside.sidebar').getByText('Workflows · demo').count(), 0, 'the Workflows chat is not listed');
    assert.equal(await f.page.locator('aside.sidebar').getByText('Fix the parser').count() > 0, true, 'ordinary chats stay');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('with hiddenPages empty, every page shows, as before', async () => {
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ hiddenPages: '' }) } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.deepEqual(await nav(f.page).getByRole('button').allTextContents(), ['New chat', 'Lab', 'Workflows', 'Love Spot', 'Mother', 'Observability', 'Customize']);
  } finally { await f.close(); }
});
