const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

test('returning after the latest page advances never puts an old follow-up below new replies', async () => {
  let advanced = false;
  const f = await fixture({ running: true, chat: [['t4', 'Task', 'Before switch']], routes: {
    '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Chat A', cwd: '/tmp/parity-fixture' }, data: advanced ? [
      { turnId: 't4', item: { id: 'latest', type: 'agentMessage', text: 'Latest reply after the new page.' } },
      { turnId: 't4', item: { id: 'new-page', type: 'agentMessage', text: 'The saved page advanced while hidden.' } },
    ] : [
      { turnId: 't4', item: { id: 'a-t4', type: 'agentMessage', text: 'Before switch' } },
      { turnId: 't4', item: { id: 'u-t4', type: 'userMessage', content: [{ type: 'text', text: 'Task' }] } },
    ], nextCursor: null }),
  } });
  try {
    await f.open('chat-a');
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't4',
      item: { id: 'follow-up', type: 'userMessage', content: [{ type: 'text', text: 'When do I go?' }] },
    } });
    await f.page.getByText('When do I go?', { exact: true }).waitFor();
    await f.open('chat-b');
    advanced = true;
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.page.getByText('Latest reply after the new page.', { exact: true }).waitFor();
    const text = await f.page.locator('.chat-content').innerText();
    assert.ok(text.indexOf('When do I go?') < text.indexOf('Latest reply after the new page.'), text);
    assert.equal(await f.page.getByText('When do I go?', { exact: true }).count(), 1);
    await f.page.waitForFunction(() => {
      const s = document.querySelector('.chat-scroll')!;
      return s.scrollHeight - s.scrollTop - s.clientHeight <= 2;
    });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('numbered, boundary and return-from-settings navigation preserve the visible live chat', async () => {
  const f = await fixture({ running: true });
  try {
    await f.open('chat-a');
    f.emit('message', { method: 'item/completed', params: {
      threadId: 'chat-a', turnId: 't4',
      item: { id: 'a-t4', type: 'agentMessage', text: 'New output that is not in the saved page.' },
    } });
    const latest = f.page.getByText('New output that is not in the saved page.', { exact: true });
    await latest.waitFor();
    await f.composer.fill('Keep my unsent draft');
    const reads = () => f.requests.filter((request: { method: string; path: string }) =>
      request.method === 'GET' && request.path === '/api/threads/chat-a').length;
    const before = reads();
    const position = await f.page.locator('.thread-row[data-depth="0"]').evaluateAll((rows: Element[]) =>
      rows.findIndex(row => row.getAttribute('data-thread-id') === 'chat-a') + 1);
    assert.equal(position, 1, 'the working chat is first for the boundary shortcut');
    for (const action of ['numbered', 'boundary', 'settings']) {
      if (action === 'settings') {
        await f.page.keyboard.press('Control+,');
        await f.page.getByRole('heading', { name: 'General', exact: true }).waitFor();
      }
      await f.page.keyboard.press(action === 'boundary' ? 'Control+PageUp' : `Alt+${position}`);
      await latest.waitFor();
      await f.page.waitForTimeout(100);
      assert.equal(reads(), before, `${action}: navigation must not reread an already visible chat`);
      assert.equal(await latest.count(), 1, `${action}: latest output stays`);
      assert.equal(await f.composer.inputValue(), 'Keep my unsent draft', `${action}: draft stays`);
    }
    await f.page.keyboard.press('Control+PageDown');
    await f.page.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.equal(await latest.count(), 0, 'a different chat gets its own transcript');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const oversized of [false, true]) test(`reconnection keeps live output and accepts newer history (${oversized ? 'uncached large chat' : 'cached chat'})`, async () => {
  let savedReply = 'All green.';
  const f = await fixture({ running: true, chat: [['t4', 'Check the result', savedReply]], routes: {
    '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Chat A', cwd: '/tmp/parity-fixture' }, data: [
      { turnId: 't4', item: { id: 'a-t4', type: 'agentMessage', text: savedReply } },
      ...(oversized ? [{ turnId: 't4', item: {
        id: 'large-output', type: 'commandExecution', command: 'large log', status: 'completed',
        aggregatedOutput: 'x'.repeat(3 * 1024 * 1024),
      } }] : []),
      { turnId: 't4', item: { id: 'u-t4', type: 'userMessage', content: [{ type: 'text', text: 'Check the result' }] } },
    ], nextCursor: null }),
  } });
  const reconnect = async () => {
    f.emit('connection', { connected: false });
    await f.page.locator('.status-dot.connected').waitFor({ state: 'detached' });
    const read = f.page.waitForResponse((response: import('playwright-core').Response) =>
      new URL(response.url()).pathname === '/api/threads/chat-a');
    f.emit('connection', { connected: true });
    await (await read).finished();
    await f.page.waitForTimeout(150);
  };
  try {
    await f.open('chat-a');
    for (const [id, text] of [['a-t4', 'All green. Updated stream.'], ['new-update', 'A newly received message.']]) {
      f.emit('message', { method: 'item/completed', params: {
        threadId: 'chat-a', turnId: 't4', item: { id, type: 'agentMessage', text },
      } });
    }
    await f.page.getByText('A newly received message.', { exact: true }).waitFor();
    await reconnect();
    assert.equal(await f.page.getByText('All green. Updated stream.', { exact: true }).count(), 1);
    assert.equal(await f.page.getByText('A newly received message.', { exact: true }).count(), 1);
    savedReply = 'All green. Updated stream. A later saved continuation.';
    await reconnect();
    assert.equal(await f.page.getByText(savedReply, { exact: true }).count(), 1);
    await f.open('chat-b');
    assert.equal(await f.page.getByText(savedReply, { exact: true }).count(), 0);
    assert.equal(await f.page.getByText('A newly received message.', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

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
