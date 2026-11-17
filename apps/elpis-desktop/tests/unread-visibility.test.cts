const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cts');
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
    const finish = (threadId: string, id: string) => f.emit('message', {
      method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [] } },
    });
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
