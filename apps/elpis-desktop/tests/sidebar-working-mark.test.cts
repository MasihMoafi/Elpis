import type { fixture as Fixture } from './parity-fixture.cts';
import type { Page } from 'playwright-core';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { fixture, CWD }: { fixture: typeof Fixture; CWD: string } = require('./parity-fixture.cts');
const path: typeof import('node:path') = require('node:path');
const sharp: typeof import('sharp') = require('sharp');

test('accented corners end at the diagonal without a tail on tabs or messages', async () => {
  const f = await fixture({ width: 1100, height: 800 });
  const page = f.page as unknown as Page;
  try {
    await f.open('chat-a');
    for (const [name, selector, side] of [
      ['chat-tab', '.task-tab.chat-tab.active', 'bottom'],
      ['message', '.message.user', 'right'],
    ] as const) {
      const element = page.locator(selector).last();
      await element.scrollIntoViewIfNeeded();
      const cut = await element.evaluate(node => {
        const style = getComputedStyle(node);
        return parseFloat(style.getPropertyValue('--edge-cut') || style.getPropertyValue('--cut'));
      });
      const png = await element.screenshot({ animations: 'disabled', ...(process.env.ELPIS_REVIEW_SHOTS
        ? { path: path.join(process.env.ELPIS_REVIEW_SHOTS, `corner-end-${name}.png`) } : {}) });
      const { data, info: { width, height, channels } } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [0, 1, 2].map(channel => data[(y * width + x) * channels + channel] ?? 0);
      const at = side === 'bottom'
        ? [width - 1, height - Math.ceil(cut) - 2] : [width - Math.ceil(cut) - 2, height - 1];
      const away = side === 'bottom'
        ? [at[0]!, at[1]! - 4] : [at[0]! - 4, at[1]!];
      const actual = pixel(at[0]!, at[1]!), adjacent = pixel(away[0]!, away[1]!);
      assert.ok(actual.every((value, index) => Math.abs(value - adjacent[index]!) <= 8),
        `${name}: the edge beyond the diagonal has no accent tail (${actual} vs ${adjacent})`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) {
  test(`running chats animate distinctly from finished and waiting chats (${colorScheme})`, async () => {
    const threads = [
      { id: 'chat-a', name: 'Running chat', status: { type: 'active' } },
      { id: 'chat-b', name: 'Finished chat', status: { type: 'idle' } },
      { id: 'chat-c', name: 'Waiting chat', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } },
    ].map(thread => ({ ...thread, cwd: CWD }));
    const staticDir = process.env.ELPIS_STATUS_STATIC_DIR;
    const f = await fixture({ colorScheme, threads, ...(staticDir ? { staticDir } : {}) });
    // The shared fixture exposes a minimal facade; its page is a real Playwright Page.
    const page = f.page as unknown as Page;
    try {
      await f.page.locator('[data-thread-id="chat-a"] .elpis-working-mark').waitFor({ timeout: 2000 });
      const working = page.locator('[data-thread-id="chat-a"] .thread-dot[data-state="working"]');
      assert.equal(await working.getAttribute('aria-label'), 'Working', 'the working state remains accessible');
      assert.equal(await working.getAttribute('title'), null, 'the working icon must not show a native tooltip over another row');
      assert.equal(await page.locator('[data-thread-id="chat-c"] .thread-dot').getAttribute('title'), 'Needs input', 'other status labels remain available');
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
      const geometry = await f.page.evaluate(() => {
        const mark = document.querySelector('[data-thread-id="chat-a"] .elpis-working-mark');
        return {
          polygons: mark?.querySelectorAll('polygon, line, circle').length,
          triangles: [...mark?.querySelectorAll('path') ?? []].map(path => ({ d: path.getAttribute('d'),
            width: getComputedStyle(path).strokeWidth, animation: getComputedStyle(path).animationName })),
        };
      });
      assert.equal(geometry.polygons, 0);
      assert.equal(geometry.triangles.length, 3);
      for (const triangle of geometry.triangles) {
        assert.match(triangle.d!, /^M[\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+Z$/);
        assert.equal(triangle.width, '2.5px');
        assert.equal(triangle.animation, 'none', 'the sidebar mark is static');
      }
      for (const id of ['chat-a', 'chat-b', 'chat-c']) {
        await f.open(id);
        await page.mouse.move(0, 0);
        const fills = await page.locator('aside.sidebar .thread-row').evaluateAll(rows =>
          rows.map(row => ({ id: row.getAttribute('data-thread-id'), fill: getComputedStyle(row).backgroundColor })));
        assert.ok(fills.every(row => row.fill === 'rgba(0, 0, 0, 0)'), `selected and running chats have no persistent fill: ${JSON.stringify(fills)}`);
        const selected = page.locator(`aside.sidebar .thread-row.active[data-thread-id="${id}"]`);
        const edge = await selected.evaluate(row => ({
          shadow: getComputedStyle(row, '::after').boxShadow,
          rowShadow: getComputedStyle(row).boxShadow,
          inset: getComputedStyle(row, '::before').inset,
          left: getComputedStyle(row, '::before').left,
          border: getComputedStyle(row, '::before').borderWidth,
          spansRow: Math.abs(parseFloat(getComputedStyle(row, '::before').width) - row.getBoundingClientRect().width) < 1,
          fill: getComputedStyle(row, '::before').backgroundColor,
          inheritsShape: getComputedStyle(row, '::before').getPropertyValue('corner-shape') ===
            getComputedStyle(row).getPropertyValue('corner-shape'),
          animation: getComputedStyle(row, '::before').animationName,
        }));
        assert.deepEqual(edge,
          { shadow: 'none', rowShadow: 'none', inset: '0px', left: '0px', border: '2px', inheritsShape: true,
            spansRow: true, fill: 'rgba(0, 0, 0, 0)',
            animation: id === 'chat-a' ? 'elpis-selection-pulse' : 'none' },
          `${id}: the angled outline pulses only while working, without a shadow`);
        const outlines = await page.locator('.thread-row.active, .task-tab.chat-tab.active').evaluateAll(rows => rows.map(row => {
          const line = getComputedStyle(row, '::before');
          return [line.borderWidth, line.borderColor, line.borderRadius, line.getPropertyValue('corner-shape')];
        }));
        assert.equal(outlines.length, 2);
        assert.deepEqual(outlines[0], outlines[1], 'the current chat uses the same outline in both places');
        if (id === 'chat-a' && process.env.ELPIS_REVIEW_SHOTS)
          await page.locator('aside.sidebar').screenshot({ path: path.join(process.env.ELPIS_REVIEW_SHOTS, `sidebar-outline-${colorScheme}.png`) });
      }
      await f.open('chat-a');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator('.thread-row.active').evaluate(row =>
        getComputedStyle(row, '::before').animationName), 'none', 'reduced motion keeps the selection outline steady');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      f.emit('message', { method: 'thread/status/changed', params: { threadId: 'chat-a', status: { type: 'idle' } } });
      await f.page.locator('[data-thread-id="chat-a"] .elpis-working-mark').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.thread-row.active').evaluate(row =>
        getComputedStyle(row, '::before').animationName), 'none', 'finishing the turn stops the outline pulse');
    } finally {
      await f.close();
    }
  });
}
