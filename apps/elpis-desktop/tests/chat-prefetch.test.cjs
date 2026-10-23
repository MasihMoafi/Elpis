// Masih, 23 Oct: "When I click on them it takes a second to load them." A chat's recent history is read while the
// pointer rests on its row, so the click shows it at once and the fresh read only refreshes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('a chat shows its history at once when clicked after the pointer rested on it', async () => {
  let reads = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  let listed;
  const f = await fixture({ routes: { '/api/threads/chat-b': async () => {
    reads += 1;
    if (reads > 1) await held;
    return { thread: listed, data: [{ turnId: 't1', item: { type: 'agentMessage', id: 'a1', text: 'The docs are written.' } }], nextCursor: null };
  } } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    listed = (await f.page.evaluate(() => fetch('/api/threads').then(response => response.json()))).data.find(thread => thread.id === 'chat-b');
    const row = f.page.locator('.thread-row[data-thread-id="chat-b"] .thread-link');
    await row.hover();
    for (const end = Date.now() + 3000; reads < 1 && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, 1, 'resting on the row reads the chat');
    await new Promise(resolve => setTimeout(resolve, 100));
    await row.click();
    await f.page.getByText('The docs are written.', { exact: true }).waitFor({ timeout: 1000 });
    assert.equal(reads, 2, 'the click still reads it fresh, and is held while the history shows');
    release();
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});
