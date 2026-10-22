// A chat another chat made with create_thread is an ordinary chat that the bridge reports under its maker (bridge/spawn-links.mjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const chat = (id, name, parentThreadId) => ({ id, name, cwd: CWD, source: 'vscode', status: { type: 'idle' }, ...(parentThreadId ? { parentThreadId } : {}), desktopAccess: { writable: true, mode: 'direct', reason: null } });
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();

test('chats made by a chat fold under it in the sidebar and open from there, still writable', async () => {
  const threads = [chat('chat-a', 'Rust notes'), chat('made-1', 'Rustidian — emoji', 'chat-a'), chat('made-2', 'Rustidian — launch copy', 'chat-a'), chat('loose', 'Hermes — setup')];
  const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? threads.filter(thread => thread.parentThreadId === url.searchParams.get('ancestorThreadId')) : threads, nextCursor: null }) };
  for (const thread of threads) {
    routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
    routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
  }
  const f = await fixture({ routes });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await row(f.page, 'chat-a').count(), 1);
    assert.equal(await row(f.page, 'loose').count(), 1);
    assert.equal(await row(f.page, 'made-1').count() + await row(f.page, 'made-2').count(), 0, 'the made chats are not listed beside their maker');
    await f.page.getByRole('button', { name: 'Expand agents in Rust notes', exact: true }).click();
    assert.equal(await row(f.page, 'made-1').count() + await row(f.page, 'made-2').count(), 2, 'they sit under it');
    await row(f.page, 'made-1').locator('.thread-link').click();
    assert.equal(await f.page.getByRole('button', { name: 'Send message', exact: true }).count() + await f.page.locator('textarea, [contenteditable="true"]').count() > 0, true, 'the made chat is not read-only');
  } finally { await f.close(); }
});
