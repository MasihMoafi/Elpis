const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

// 4 Nov recording: windowed, scrolling the chat list to its end showed the last chat and then snapped back over it,
// because the end was not a whole-row snap position. At every list height the end must be one, so the last chat shows
// whole there and stays when a label changes the layout.
const thread = (id, name) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const threads = [thread('love', 'Love Spot'), ...Array.from({ length: 22 }, (_, i) => thread(`r${i}`, `Recent chat number ${i + 1}`))];
const STOPS = '.thread-row, .thread-more, .section-label-row, section > :first-child';

test('at every window height the end of the chat list is a whole-row position that shows the last chat', async () => {
  const f = await fixture({ width: 1100, height: 900, staticDir: process.env.ELPIS_RENDERER_OUT, threads, readyThreadId: 'r0' });
  const { page } = f, list = page.locator('.thread-list');
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    // From 554: the list heights the sweep began with at 520 before Observability's sidebar row (5 Nov) took 34 px.
    for (let height = 554; height <= 1000; height += 7) {
      await page.setViewportSize({ width: 1100, height });
      await page.waitForTimeout(120);
      const state = await list.evaluate(async (element, stops) => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        element.scrollTop = element.scrollHeight; await wait(250);
        const row = element.querySelector('.thread-row'); row.style.paddingBottom = '1px'; await wait(150); row.style.paddingBottom = ''; await wait(250);
        const end = element.scrollHeight - element.clientHeight, origin = element.getBoundingClientRect().top - element.scrollTop;
        const starts = [...element.querySelectorAll(stops)].map(stop => Math.round(stop.getBoundingClientRect().top - origin));
        const view = element.getBoundingClientRect(), last = [...element.querySelectorAll('.thread-row')].at(-1).getBoundingClientRect();
        return { end: Math.round(end), endIsRow: end <= 0 || starts.some(start => Math.abs(start - end) <= 1), top: Math.round(element.scrollTop), hidden: Math.round(last.bottom - view.bottom) };
      }, STOPS);
      assert.ok(state.endIsRow, `${height}px: the list's end is a whole-row position ${JSON.stringify(state)}`);
      assert.ok(state.hidden <= 0.5 && state.top >= state.end - 1, `${height}px: the last chat shows whole at the end ${JSON.stringify(state)}`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
