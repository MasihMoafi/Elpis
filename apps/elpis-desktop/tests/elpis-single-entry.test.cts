// SPEC item 87: Elpis has one entry in the sidebar, the navigation's; the router's chat is never a second row among the chats.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const chat = (id: string, name: string, extra: object = {}) => ({
  id, name, preview: name, cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' },
  desktopAccess: { writable: true, mode: 'direct' }, ...extra,
});

test('the router chat opens from the Elpis entry and is not a row among the chats', async () => {
  const f = await fixture({
    threads: [chat('elpis', 'Elpis', { motherAgent: true }), chat('chat-a', 'Fix the parser')], readyThreadId: 'chat-a',
  });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const rows = page.locator('aside.sidebar .thread-row');
    await rows.filter({ hasText: 'Fix the parser' }).waitFor();
    assert.equal(await rows.filter({ hasText: /^Elpis$/ }).count(), 0, 'no Elpis row among the chats');
    assert.equal(await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).count(), 1);
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).click();
    await page.getByRole('tab', { name: 'Elpis', exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
