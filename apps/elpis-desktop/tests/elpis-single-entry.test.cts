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

// 11 Nov, Masih: "the elpis chat should have a different more attractive look I think so it's different from the rest".
// The Elpis chat is the assistant's own place: a band says what his chats are doing, the page carries a wash of the
// accent, and the message box invites what Elpis is for. An ordinary chat has none of it.
test('the Elpis chat has its own look: a band on what his chats are doing and its own invitation to write', async () => {
  const f = await fixture({
    threads: [
      chat('elpis', 'Elpis', { motherAgent: true }),
      chat('chat-a', 'Fix the parser', { status: { type: 'active', activeFlags: [] } }),
      chat('chat-b', 'Deploy site', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
      chat('chat-c', 'Old notes'),
    ],
    readyThreadId: 'chat-c',
  });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const band = page.getByRole('status', { name: 'Your chats', exact: true });
    await page.locator('aside.sidebar .thread-row').filter({ hasText: 'Old notes' }).click();
    await page.getByRole('tab', { name: 'Old notes', exact: true }).waitFor();
    assert.equal(await band.count(), 0, 'an ordinary chat has no band');
    assert.equal(await page.locator('main.workspace.elpis-chat').count(), 0);
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).click();
    await band.waitFor();
    assert.equal((await band.innerText()).replace(/\s+/g, ' ').trim(), 'Elpis 1 needs you · 1 working · 3 chats');
    await page.locator('main.workspace.elpis-chat').waitFor();
    assert.equal(await page.locator('main textarea').first().getAttribute('placeholder'), 'Ask Elpis about your chats, or hand it a job');
    const wash = await page.locator('main.workspace.elpis-chat .chat-view').evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage);
    assert.match(wash, /gradient/, 'the page carries a wash of the accent');
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/elpis-chat.png` });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
