// Matilda's page (A162): her portrait and role, a task box, the two-helpers switch, and the task given to a chat of her own.
// Local bridge fixture (tests/parity-fixture.cjs); the chat creation and its first turn are answered here and recorded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`Matilda: a task goes to a chat named for it, alone by default and with a cap of two helpers when allowed (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, storage: { 'elpis-preferences-v1': JSON.stringify({ hiddenPages: 'experimentLab,canvas' }) } });
  const created = [], turns = [];
  try {
    const { page } = f;
    // The new chat is the fixture's chat-b, so the app can open it.
    await page.route(url => url.pathname === '/api/threads', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      created.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { thread: { id: 'chat-b', name: created.at(-1).name, cwd: '/tmp/parity-fixture', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } } } });
    });
    await page.route(url => url.pathname === '/api/threads/chat-b/turns', async route => { turns.push(route.request().postDataJSON()); await route.fulfill({ status: 200, json: { turn: { id: 't-matilda' } } }); });
    const nav = page.locator('aside.sidebar nav[aria-label="Workspace"]');
    assert.ok((await nav.getByRole('button').allTextContents()).includes('Matilda'), 'Matilda has a page in the sidebar');
    await nav.getByRole('button', { name: 'Matilda', exact: true }).click();
    const view = page.locator('.matilda');
    await view.getByRole('heading', { name: 'Matilda', exact: true }).waitFor();
    await view.getByText('Marketing: gets your work seen').waitFor();
    const portrait = view.getByRole('img', { name: /Matilda.s portrait/ });
    await page.waitForFunction(() => document.querySelector('.matilda-portrait')?.naturalWidth > 0);
    assert.equal(await portrait.count(), 1);
    const give = view.getByRole('button', { name: 'Give Matilda the task', exact: true });
    assert.equal(await give.isDisabled(), true, 'nothing to give yet');
    const box = view.getByRole('textbox', { name: 'Task for Matilda', exact: true });
    await box.fill('Draft a launch post for Rustidian\nKeep it short.');
    await give.click();
    await page.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.deepEqual(created.map(({ name, agents, maxAgents }) => ({ name, agents, maxAgents })), [{ name: 'Matilda · Draft a launch post for Rustidian', agents: undefined, maxAgents: undefined }], 'alone by default');
    assert.match(created[0].instructions, /You are Matilda/); assert.match(created[0].instructions, /without helper agents/);
    assert.deepEqual(turns, [{ text: 'Draft a launch post for Rustidian\nKeep it short.' }], 'the task is her first message');
    // Back on her page the switch lets her use two helpers, and the cap goes with the chat.
    await nav.getByRole('button', { name: 'Matilda', exact: true }).click();
    await view.getByRole('switch', { name: 'Let Matilda use two helpers', exact: true }).click();
    await view.getByRole('textbox', { name: 'Task for Matilda', exact: true }).fill('Plan where to share Elpis');
    await view.getByRole('button', { name: 'Give Matilda the task', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.thread-row.active[data-thread-id="chat-b"]') && !document.querySelector('.matilda'));
    assert.equal(created.length, 2);
    assert.equal(created[1].agents, true); assert.equal(created[1].maxAgents, 2); assert.match(created[1].instructions, /at most 2 helper agents/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
