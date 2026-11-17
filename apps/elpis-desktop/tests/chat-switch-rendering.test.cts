const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

test('returning to a running chat never replaces already received output with an older history page', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERING_STATIC, running: true });
  try {
    await f.open('chat-a');
    f.emit('message', { method: 'item/completed', params: {
      threadId: 'chat-a', turnId: 't4',
      item: { id: 'a-t4', type: 'agentMessage', text: 'The latest completed update must stay visible.' },
    } });
    f.emit('message', { method: 'item/completed', params: {
      threadId: 'chat-a', turnId: 't4',
      item: { id: 'new-update', type: 'agentMessage', text: 'More work arrived after the stored page.' },
    } });
    await f.page.getByText('More work arrived after the stored page.', { exact: true }).waitFor();
    await f.page.waitForTimeout(100);
    await f.open('chat-b');
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.page.waitForTimeout(500);
    assert.equal(await f.page.getByText('The latest completed update must stay visible.', { exact: true }).count(), 1);
    assert.equal(await f.page.getByText('More work arrived after the stored page.', { exact: true }).count(), 1);
    assert.equal(await f.page.getByText('All green.', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a long active turn returns to the bottom without an estimated blank turn', async () => {
  const reply = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ${'This sentence fills a transcript line. '.repeat(6)}`).join('\n\n');
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERING_STATIC, running: true, chat: [['t4', 'A long running task.', reply]], width: 1400, height: 900 });
  try {
    await f.open('chat-a');
    await f.page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      await f.open('chat-b');
      await f.open('chat-a');
      await f.page.waitForTimeout(150);
      const state = await f.page.locator('.chat-scroll').evaluate((s: HTMLElement) => {
        const turn = s.querySelector<HTMLElement>('.turn')!;
        const last = turn.querySelector('.message.agent p:last-child')!;
        return { gap: s.scrollHeight - s.scrollTop - s.clientHeight, lastBottom: last.getBoundingClientRect().bottom, viewBottom: s.getBoundingClientRect().bottom };
      });
      assert.ok(state.gap <= 2, JSON.stringify(state));
      assert.ok(Math.abs(state.lastBottom - state.viewBottom) < 100, 'the last paragraph is painted at the bottom instead of an estimated blank');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
