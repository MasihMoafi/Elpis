// Masih, 23 Oct (screenshot of the sidebar): "I should be able to collapse these as well"; then "When I say change one thing I want it to apply to all those similar elements in the UI." So: every section heading of the sidebar folds, and a new heading that does not breaks this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { chooseTheme, leaveSettings, openSettings } = require('./controls.cjs');

const chat = (id: string, name: string) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const threads = Array.from({ length: 16 }, (_, index) => chat(`chat-${String.fromCharCode(97 + index)}`, `${String.fromCharCode(65 + index)} chat`));
const routes: Record<string, (_body: unknown, url: URL) => object> = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? [] : threads, nextCursor: null }) };
for (const thread of threads) {
  routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
  routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
}

test('long sidebar lists keep every visible chat row whole at rest, through resize and at scroll ends', async () => {
  const makeChat = (id: string, name: string, extra: { parentThreadId?: string } = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
  const parent = makeChat('chat-a', 'Recover the longest customer conversation from last week and compare all follow-up notes');
  const projectChat = makeChat('project-chat', 'Write the implementation plan for the cross-service migration and its rollback');
  const loveChat = makeChat('love-chat', 'Love Spot · Review the approved designs and send the final update');
  const recent = Array.from({ length: 20 }, (_, i) => makeChat(`recent-${i}`, `A long recent conversation title ${i + 1}: inspect the saved context and keep the complete row visible`));
  const child = makeChat('agent-child', 'Nested agent with a deliberately long title', { parentThreadId: parent.id });
  const grandchild = makeChat('agent-grandchild', 'Third level review agent', { parentThreadId: child.id });
  const roots = [parent, projectChat, loveChat, ...recent];
  const descendants: Record<string, ReturnType<typeof makeChat>[]> = { [parent.id]: [child], [child.id]: [grandchild] };
  const routesWithChildren = { '/api/threads': (_body: unknown, url: URL) => ({
    data: url.searchParams.has('ancestorThreadId') ? descendants[url.searchParams.get('ancestorThreadId') ?? ''] ?? [] : roots,
    nextCursor: null,
  }) };
  const f = await fixture({ width: 820, height: 1185, staticDir: process.env.ELPIS_RENDERER_OUT, threads: roots, readyThreadId: parent.id, routes: routesWithChildren, storage: {
    'elpis-sidebar-width': '376',
    'elpis-preferences-v1': JSON.stringify({ interfaceSize: 'l' }),
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p1', name: 'Long running project name', cwd: CWD }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ [projectChat.id]: 'p1' }),
  } });
  try {
    const { page } = f, list = page.locator('.thread-list');
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const checkRows = async (label: string) => {
      const geometry = await list.evaluate((element: HTMLElement) => {
        const viewport = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll<HTMLElement>('.thread-row')].map(row => ({
          id: row.dataset.threadId || (row.textContent?.trim() ?? ''),
          top: row.getBoundingClientRect().top,
          bottom: row.getBoundingClientRect().bottom,
        }));
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: getComputedStyle(element).overflowX,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          viewportTop: viewport.top,
          viewportBottom: viewport.bottom,
          visible: rows.filter(row => row.bottom > viewport.top && row.top < viewport.bottom),
        };
      });
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${label}: no horizontal overflow (${geometry.scrollWidth}/${geometry.clientWidth}, ${geometry.overflowX})`);
      const partial = geometry.visible.filter((row: { top: number; bottom: number }) => row.top < geometry.viewportTop - .5 || row.bottom > geometry.viewportBottom + .5);
      assert.ok(partial.length === 0, `${label}: partial=${JSON.stringify(partial)}, viewport=${geometry.viewportTop}-${geometry.viewportBottom}, scroll=${geometry.scrollTop}/${geometry.scrollHeight - geometry.clientHeight}`);
      assert.ok(geometry.visible.some((row: { top: number; bottom: number }) => row.top >= geometry.viewportTop - .5 && row.bottom <= geometry.viewportBottom + .5), `${label}: at least one whole chat row fits`);
    };
    await checkRows('initial');
    await page.locator(`.thread-row[data-thread-id="${parent.id}"] .thread-link`).click();
    await page.locator(`.thread-row.active[data-thread-id="${parent.id}"]`).waitFor();
    await page.locator(`.thread-row[data-thread-id="${parent.id}"]`).getByRole('button', { name: /^Expand agents in/ }).click();
    await page.locator(`.thread-row[data-thread-id="${child.id}"]`).getByRole('button', { name: /^Expand agents in/ }).click();
    await page.locator(`.thread-row[data-thread-id="${grandchild.id}"]`).waitFor();
    for (const height of [674, 534]) {
      await page.setViewportSize({ width: 820, height });
      await page.waitForTimeout(350);
      if (height === 674 && process.env.SIDEBAR_FIT_SHOT) await page.screenshot({ path: process.env.SIDEBAR_FIT_SHOT });
      await checkRows(`expanded at ${height}px`);
      const maxScroll = await list.evaluate((element: HTMLElement) => Math.max(0, element.scrollHeight - element.clientHeight));
      for (const [position, scrollTop] of [['middle', Math.round(maxScroll / 2)], ['end', maxScroll]] as [string, number][]) {
        await list.evaluate((element: HTMLElement, top: number) => { element.scrollTop = top; }, scrollTop);
        await page.waitForTimeout(400);
        await checkRows(`${position} at ${height}px`);
      }
      if (height === 534) {
        await page.evaluate(() => {
          Reflect.set(window, '__keyboardChildGeometry', new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 1000);
            const onFocus = (event: FocusEvent) => {
              const row = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>('.thread-row');
              if (row?.dataset.threadId !== 'agent-child') return;
              document.removeEventListener('focusin', onFocus);
              clearTimeout(timeout);
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const box = row.getBoundingClientRect(), viewElement = document.querySelector('.thread-list');
                if (!viewElement) { resolve(null); return; }
                const view = viewElement.getBoundingClientRect();
                resolve({ active: document.activeElement === row.querySelector('.thread-link'), top: box.top, bottom: box.bottom, viewTop: view.top, viewBottom: view.bottom });
              }));
            };
            document.addEventListener('focusin', onFocus);
          }));
        });
        await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').focus();
        await page.keyboard.press('ArrowDown');
        const keyboardRow = await page.evaluate(() => Reflect.get(window, '__keyboardChildGeometry'));
        assert.ok(keyboardRow, 'ArrowDown must focus the boundary child chat');
        assert.ok(keyboardRow.active, 'the child chat link receives focus');
        assert.ok(keyboardRow.top >= keyboardRow.viewTop - .5 && keyboardRow.bottom <= keyboardRow.viewBottom + .5, `keyboard focus reveals the complete child row: ${JSON.stringify(keyboardRow)}`);
      }
      if (height === 674) {
        await openSettings(page);
        await leaveSettings(page);
        await page.waitForTimeout(350);
        await checkRows('after Settings roundtrip');
        await chooseTheme(page, 'dark');
        await page.waitForTimeout(350);
        await checkRows('after theme change');
      }
      const last = list.locator('.thread-row').last();
      await last.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      const lastGeometry = await last.evaluate((row: HTMLElement) => {
        const list = row.closest<HTMLElement>('.thread-list');
        if (!list) throw new Error('Thread list is missing');
        const rowBox = row.getBoundingClientRect(), listBox = list.getBoundingClientRect();
        return { visible: rowBox.top >= listBox.top - .5 && rowBox.bottom <= listBox.bottom + .5, height: rowBox.height, top: rowBox.top, bottom: rowBox.bottom, viewport: listBox.height, listTop: listBox.top, listBottom: listBox.bottom, scrollTop: list.scrollTop, maxScroll: list.scrollHeight - list.clientHeight };
      });
      assert.equal(lastGeometry.visible, true, `the final chat stays reachable as a complete ${lastGeometry.height}px row at ${height}px: ${JSON.stringify(lastGeometry)}`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
