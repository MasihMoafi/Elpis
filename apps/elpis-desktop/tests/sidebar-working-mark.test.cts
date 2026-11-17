import type { fixture as Fixture } from './parity-fixture.cts';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { fixture, CWD }: { fixture: typeof Fixture; CWD: string } = require('./parity-fixture.cts');

for (const colorScheme of ['light', 'dark']) {
  test(`running chats animate distinctly from finished and waiting chats (${colorScheme})`, async () => {
    const threads = [
      { id: 'chat-a', name: 'Running chat', status: { type: 'active' } },
      { id: 'chat-b', name: 'Finished chat', status: { type: 'idle' } },
      { id: 'chat-c', name: 'Waiting chat', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } },
    ].map(thread => ({ ...thread, cwd: CWD }));
    const staticDir = process.env.ELPIS_STATUS_STATIC_DIR;
    const f = await fixture({ colorScheme, threads, ...(staticDir ? { staticDir } : {}) });
    try {
      await f.page.locator('[data-thread-id="chat-a"] .elpis-working-mark').waitFor({ timeout: 2000 });
      const states = await f.page.evaluate(() =>
        [...document.querySelectorAll('aside.sidebar .thread-row')].map(row => ({
          id: row.getAttribute('data-thread-id'),
          state: row.querySelector('.thread-dot')?.getAttribute('data-state'),
          animated: !!row.querySelector('.elpis-working-mark'),
        })),
      );
      assert.deepEqual(states.find(row => row.id === 'chat-a'), { id: 'chat-a', state: 'working', animated: true });
      assert.deepEqual(states.find(row => row.id === 'chat-b'), { id: 'chat-b', state: 'idle', animated: false });
      assert.deepEqual(states.find(row => row.id === 'chat-c'), { id: 'chat-c', state: 'waiting', animated: false });
      const animation = await f.page.evaluate(() => {
        const mark = document.querySelector('[data-thread-id="chat-a"] .elpis-working-mark');
        const rotor = mark?.querySelector('.elpis-working-rotor');
        const dot = mark?.querySelector('.elpis-working-dot');
        return {
          rotation: rotor && getComputedStyle(rotor).animationDuration,
          blink: dot && getComputedStyle(dot).animationDuration,
          masks: mark?.querySelectorAll('mask').length,
        };
      });
      assert.deepEqual(animation, { rotation: '4s', blink: '2s', masks: 0 });
      f.emit('message', { method: 'thread/status/changed', params: { threadId: 'chat-a', status: { type: 'idle' } } });
      await f.page.locator('[data-thread-id="chat-a"] .elpis-working-mark').waitFor({ state: 'detached' });
    } finally {
      await f.close();
    }
  });
}
