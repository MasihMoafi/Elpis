const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`a pinned Love Spot chat shows its name once (${colorScheme})`, async t => {
  const threads = THREADS.map(thread => thread.id === 'chat-a' ? { ...thread, name: 'Love Spot' } : thread);
  const f = await fixture({ colorScheme, threads, storage: { 'elpis-pinned-chats-v1': '["chat-a"]' } });
  t.after(() => f.close());
  const row = f.page.locator('.thread-row[data-thread-id="chat-a"]');
  await row.locator('.thread-title').waitFor();
  assert.equal(await row.locator('.thread-title').innerText(), 'Love Spot');
  assert.equal(await row.locator('.thread-origin').count(), 0, 'The origin must not repeat the title');
  await f.open('chat-a');
  assert.equal(await f.page.locator('.workspace-header .thread-origin').count(), 0, 'The selected chat header follows the same rule');
});
