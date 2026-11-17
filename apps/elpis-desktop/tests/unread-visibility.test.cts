const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cts');
const { apply } = require('../lib/attention-state.cts');
const visibility = (page: import('playwright-core').Page, visible: boolean, focused = visible) => page.evaluate((value: { visible: boolean; focused: boolean }) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: value.visible ? 'visible' : 'hidden' });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => value.focused });
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event(value.focused ? 'focus' : 'blur'));
}, { visible, focused });

test('background replies remain unread until their own visible chat regains focus', async () => {
  const f = await fixture(), { page } = f;
  try {
    await f.open('chat-a');
    await visibility(page, false);
    const finish = (threadId: string, id: string) => {
      f.emit('message', { method: 'item/completed', params: { threadId, turnId: id,
        item: { id: `reply-${id}`, type: 'agentMessage', text: `Reply ${id}` } } });
      f.emit('message', { method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [] } } });
    };
    finish('chat-a', 'hidden-a');
    finish('chat-b', 'hidden-b');
    const unread = () => page.evaluate(() => JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []);
    await page.waitForFunction(() => {
      const ids = JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || [];
      return ids.includes('chat-b');
    }, undefined, { timeout: 3000 });
    assert.ok((await unread()).includes('chat-a'), 'the selected chat completed while hidden and stays unread');
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-b', turn: { id: 'next', status: 'inProgress', items: [] } } });
    await page.waitForTimeout(100);
    assert.ok((await unread()).includes('chat-b'), 'starting another turn does not mark the earlier reply read');
    await visibility(page, true);
    await page.waitForFunction(() => {
      const ids = JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || [];
      return !ids.includes('chat-a') && ids.includes('chat-b');
    });
    assert.deepEqual(await unread(), ['chat-b']);
    await visibility(page, true, false);
    finish('chat-a', 'unfocused-a');
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-a'));
    await visibility(page, true, true);
    await page.waitForFunction(() => !(JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-a'));
    await page.locator('.thread-row[data-thread-id="chat-a"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Mark as unread/ }).click();
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-a'));
    await visibility(page, false);
    finish('chat-a', 'manual-unread');
    await page.waitForTimeout(100);
    await visibility(page, true);
    await page.waitForTimeout(100);
    assert.ok((await unread()).includes('chat-a'), 'manual unread is retained on refocus');
    await f.open('chat-b');
    await f.open('chat-a');
    await page.waitForFunction(() => !(JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-a'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a hidden Love Spot board retains its reply until the board is visible again', async () => {
  const matilda = { ...THREADS[0], id: 'matilda-chat', name: 'Love Spot', preview: 'Love Spot' };
  const f = await fixture({ threads: [...THREADS, matilda] }), { page } = f;
  try {
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Love Spot', exact: true }).click();
    await page.locator('section.love-spot').waitFor();
    await visibility(page, false);
    f.emit('message', { method: 'turn/completed', params: { threadId: 'matilda-chat', turn: { id: 'hidden-love', status: 'completed', items: [] } } });
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('matilda-chat'));
    await visibility(page, true);
    await page.waitForFunction(() => !(JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('matilda-chat'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('failed, slow and stale history loads retain unread until the matching reply is displayed', async () => {
  let mode: 'fail' | 'slow' = 'fail', turn = 'reply-one', release: (() => void) | undefined;
  let gate = Promise.resolve();
  const hold = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
  const initial = apply(null, { kind: 'unread', id: 'chat-b' });
  const f = await fixture({ storage: { 'elpis-chat-attention-v1': initial }, routes: {
    '/api/threads/chat-b': async () => {
      if (mode === 'fail') return { __http: 500, error: 'History unavailable' };
      const current = turn;
      await gate;
      return { thread: THREADS[1], data: [{ turnId: current,
        item: { id: `answer-${current}`, type: 'agentMessage', text: `Displayed ${current}` } }], nextCursor: null };
    },
  } }), { page } = f;
  const finish = (id: string) => f.emit('message', { method: 'turn/completed',
    params: { threadId: 'chat-b', turn: { id, status: 'completed', items: [] } } });
  const unread = () => page.evaluate(() => JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []);
  try {
    await f.open('chat-a');
    finish('reply-one');
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-b'));
    await f.open('chat-b');
    await page.getByText(/History unavailable/).waitFor();
    assert.ok((await unread()).includes('chat-b'), 'failed history did not mark the chat read');
    await f.open('chat-a');
    mode = 'slow'; hold();
    await f.open('chat-b');
    assert.ok((await unread()).includes('chat-b'), 'an unfinished load did not mark it read');
    release?.();
    await page.getByText('Displayed reply-one', { exact: true }).waitFor();
    await page.waitForFunction(() => !(JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-b'));

    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-b', turnId: 'reply-two',
      item: { id: 'progress-two', type: 'agentMessage', phase: 'commentary', text: 'Still working' } } });
    await page.getByText('Still working', { exact: true }).waitFor();
    await f.open('chat-a');
    turn = 'reply-two'; finish(turn); hold();
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}').unread || []).includes('chat-b'));
    await f.open('chat-b');
    await page.getByText('Displayed reply-one', { exact: true }).waitFor();
    assert.ok((await unread()).includes('chat-b'), 'older cached text cannot clear a newer reply');
    await f.open('chat-c');
    release?.();
    await page.waitForTimeout(150);
    assert.ok((await unread()).includes('chat-b'), 'a stale response after switching cannot mark it read');
    assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});

test('a newly created chat reads its first reply when that reply appears', async () => {
  const created = { ...THREADS[0], id: 'fresh-chat', name: 'Fresh chat' };
  let started = false;
  const f = await fixture({ routes: {
    '/api/threads': (body: unknown, url: URL) => body ? (started = true, { thread: created }) :
      { data: url.searchParams.has('ancestorThreadId') ? [] : [...THREADS, ...(started ? [created] : [])], nextCursor: null },
    '/api/threads/fresh-chat/turns': () => ({ turn: { id: 'fresh-turn' } }),
  } }), { page } = f;
  try {
    await f.composer.fill('Start a new chat');
    const sent = page.waitForResponse((response: { url(): string }) => response.url().endsWith('/fresh-chat/turns'));
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await sent;
    f.emit('message', { method: 'item/completed', params: { threadId: 'fresh-chat', turnId: 'fresh-turn',
      item: { id: 'fresh-answer', type: 'agentMessage', text: 'Fresh answer' } } });
    f.emit('message', { method: 'turn/completed', params: { threadId: 'fresh-chat',
      turn: { id: 'fresh-turn', status: 'completed', items: [] } } });
    await page.getByText('Fresh answer', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem('elpis-chat-attention-v1') || '{}');
      return value.chats?.['fresh-chat']?.replies?.['fresh-turn'] === true;
    });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
