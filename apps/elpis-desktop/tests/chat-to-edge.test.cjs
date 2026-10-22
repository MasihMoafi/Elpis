// Ctrl+[ and Ctrl+] send the open chat to the top or the bottom of its list; running chats stay on top of the list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`);
const recents = page => page.locator('aside.sidebar section[aria-label="Recents"]');
const ids = locator => locator.locator('.thread-row').evaluateAll(rows => rows.map(row => row.dataset.threadId));
async function eventually(check) {
  const end = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 30)); } }
}
const chat = (id, updatedAt, status = { type: 'idle' }) => ({ id, name: id, cwd: CWD, updatedAt, status });
const open = chats => fixture({ routes: {
  '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : chats, nextCursor: null }),
  ...Object.fromEntries(chats.map(thread => [`/api/threads/${thread.id}`, () => ({ thread, data: [], nextCursor: null })])),
} });

test('Ctrl+[ sends the open chat to the top of Recents and Ctrl+] to the bottom', async () => {
  const f = await open([chat('chat-a', 40), chat('chat-b', 30), chat('chat-c', 20), chat('chat-d', 10)]);
  try {
    await row(f.page, 'chat-c').locator('.thread-link').click();
    await f.page.mouse.move(700, 300);
    await f.page.keyboard.press('Control+BracketLeft');
    await eventually(async () => assert.deepEqual(await ids(recents(f.page)), ['chat-c', 'chat-a', 'chat-b', 'chat-d']));
    await f.page.keyboard.press('Control+BracketRight');
    await eventually(async () => assert.deepEqual(await ids(recents(f.page)), ['chat-a', 'chat-b', 'chat-d', 'chat-c']));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('running chats stay above the others, and the key moves the chat within its tier', async () => {
  const f = await open([chat('chat-a', 40), chat('chat-b', 30), chat('run-1', 20, { type: 'active' }), chat('run-2', 10, { type: 'active' })]);
  try {
    await eventually(async () => assert.deepEqual(await ids(recents(f.page)), ['run-1', 'run-2', 'chat-a', 'chat-b']));
    await row(f.page, 'chat-b').locator('.thread-link').click();
    await f.page.mouse.move(700, 300);
    await f.page.keyboard.press('Control+BracketLeft');
    await eventually(async () => assert.deepEqual(await ids(recents(f.page)), ['run-1', 'run-2', 'chat-b', 'chat-a']));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
