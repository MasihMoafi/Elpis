// Masih, 23 Oct (screenshot of the sidebar): "I should be able to collapse these as well"; then "When I say change one thing I want it to apply to all those similar elements in the UI." So: every section heading of the sidebar folds, and a new heading that does not breaks this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { chooseTheme, leaveSettings, openSettings } = require('./controls.cjs');

const chat = (id, name) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const threads = Array.from({ length: 16 }, (_, index) => chat(`chat-${String.fromCharCode(97 + index)}`, `${String.fromCharCode(65 + index)} chat`));
const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? [] : threads, nextCursor: null }) };
for (const thread of threads) {
  routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
  routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
}

test('Projects, Pinned and Recents each fold their list and open it again', async () => {
  const f = await fixture({ routes, staticDir: process.env.ELPIS_RENDERER_OUT, storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'one', name: 'First project', cwd: CWD }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ 'chat-a': 'one' }),
    'elpis-pinned-chats-v1': JSON.stringify(['chat-c']) } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const side = page.locator('aside.sidebar');
    await side.locator('section[aria-label="Recents"] .thread-row').first().waitFor();
    const headings = await side.locator('.section-label').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent.trim(), folds: !!node.querySelector('button[aria-expanded]') })));
    assert.ok(headings.length >= 3, `the sidebar shows its headings: ${JSON.stringify(headings)}`);
    for (const heading of headings) assert.equal(heading.folds, true, `${heading.text} is a sidebar heading like the others, so it folds`);
    for (const [name, content] of [['Projects', side.getByRole('group', { name: 'First project' })], ['Pinned', side.locator('section[aria-label="Pinned"] .thread-row')], ['Recents', side.locator('section[aria-label="Recents"] .thread-row')]]) {
      const heading = side.getByRole('button', { name, exact: true });
      await content.first().waitFor();
      assert.equal(await heading.getAttribute('aria-expanded'), 'true', `${name} starts open`);
      await heading.click();
      await content.first().waitFor({ state: 'detached' });
      assert.equal(await heading.getAttribute('aria-expanded'), 'false', `${name} folds`);
      await heading.click();
      await content.first().waitFor();
    }
    // Masih, 23 Oct: "the light orange shadow behind the elpis shouldn't show to the user": the mark is not a row, so hovering it tints nothing.
    const mark = side.getByRole('button', { name: 'Elpis home' });
    await mark.hover();
    assert.equal(await mark.evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)', 'no box appears behind the Elpis mark');
    assert.deepEqual(f.errors ?? [], []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`every sidebar section scrolls by whole chat rows (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, height: 500, routes, staticDir: process.env.ELPIS_RENDERER_OUT, storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'one', name: 'First project', cwd: CWD }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ 'chat-a': 'one' }),
    'elpis-pinned-chats-v1': JSON.stringify(['chat-p']) } });
  try {
    const { page } = f, list = page.locator('.thread-list');
    await list.locator('section[aria-label="Recents"] .thread-row').first().waitFor();
    assert.equal(await list.evaluate(element => getComputedStyle(element).scrollSnapType), 'y mandatory');
    assert.deepEqual(await list.locator(':is(.thread-row, .section-label-row)').evaluateAll(rows => [...new Set(rows.map(row => getComputedStyle(row).scrollSnapAlign))]), ['start']);
    await list.hover(); await page.mouse.wheel(0, 51); await page.waitForTimeout(400);
    const partial = await list.evaluate(element => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll('.thread-row')].filter(row => {
        const box = row.getBoundingClientRect(), visible = box.bottom > viewport.top && box.top < viewport.bottom;
        return visible && (box.top < viewport.top - .5 || box.bottom > viewport.bottom + .5);
      }).map(row => row.getAttribute('data-thread-id') || row.textContent.trim());
    });
    assert.deepEqual(partial, [], `all sections share the whole-row scroll boundary: ${partial.join(', ')}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('long sidebar lists keep every visible chat row whole at rest, through resize and at scroll ends', async () => {
  const makeChat = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
  const parent = makeChat('chat-a', 'Recover the longest customer conversation from last week and compare all follow-up notes');
  const projectChat = makeChat('project-chat', 'Write the implementation plan for the cross-service migration and its rollback');
  const loveChat = makeChat('love-chat', 'Love Spot · Review the approved designs and send the final update');
  const recent = Array.from({ length: 20 }, (_, i) => makeChat(`recent-${i}`, `A long recent conversation title ${i + 1}: inspect the saved context and keep the complete row visible`));
  const child = makeChat('agent-child', 'Nested agent with a deliberately long title', { parentThreadId: parent.id });
  const grandchild = makeChat('agent-grandchild', 'Third level review agent', { parentThreadId: child.id });
  const roots = [parent, projectChat, loveChat, ...recent];
  const descendants = { [parent.id]: [child], [child.id]: [grandchild] };
  const routesWithChildren = { '/api/threads': (_body, url) => ({
    data: url.searchParams.has('ancestorThreadId') ? descendants[url.searchParams.get('ancestorThreadId')] ?? [] : roots,
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
    const checkRows = async label => {
      const geometry = await list.evaluate(element => {
        const viewport = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll('.thread-row')].map(row => ({
          id: row.dataset.threadId || row.textContent.trim(),
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
      const partial = geometry.visible.filter(row => row.top < geometry.viewportTop - .5 || row.bottom > geometry.viewportBottom + .5);
      assert.ok(partial.length === 0, `${label}: partial=${JSON.stringify(partial)}, viewport=${geometry.viewportTop}-${geometry.viewportBottom}, scroll=${geometry.scrollTop}/${geometry.scrollHeight - geometry.clientHeight}`);
      assert.ok(geometry.visible.some(row => row.top >= geometry.viewportTop - .5 && row.bottom <= geometry.viewportBottom + .5), `${label}: at least one whole chat row fits`);
    };
    await checkRows('initial');
    await page.locator(`.thread-row[data-thread-id="${parent.id}"] .thread-link`).click();
    await page.locator(`.thread-row.active[data-thread-id="${parent.id}"]`).waitFor();
    await page.locator(`.thread-row[data-thread-id="${parent.id}"]`).getByRole('button', { name: /^Expand agents in/ }).click();
    await page.locator(`.thread-row[data-thread-id="${child.id}"]`).getByRole('button', { name: /^Expand agents in/ }).click();
    await page.locator(`.thread-row[data-thread-id="${grandchild.id}"]`).waitFor();
    for (const height of [1185, 640, 633, 500, 672, 760]) {
      await page.setViewportSize({ width: 820, height });
      await page.waitForTimeout(350);
      if (height === 640 && process.env.SIDEBAR_FIT_SHOT) await page.screenshot({ path: process.env.SIDEBAR_FIT_SHOT });
      await checkRows(`expanded at ${height}px`);
      const maxScroll = await list.evaluate(element => Math.max(0, element.scrollHeight - element.clientHeight));
      for (const [position, scrollTop] of [['middle', Math.round(maxScroll / 2)], ['end', maxScroll]]) {
        await list.evaluate((element, top) => { element.scrollTop = top; }, scrollTop);
        await page.waitForTimeout(400);
        await checkRows(`${position} at ${height}px`);
      }
      if (height === 500) {
        await page.evaluate(() => {
          window.__keyboardChildGeometry = new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 1000);
            const onFocus = event => {
              const row = event.target.closest?.('.thread-row');
              if (row?.dataset.threadId !== 'agent-child') return;
              document.removeEventListener('focusin', onFocus);
              clearTimeout(timeout);
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const box = row.getBoundingClientRect(), view = document.querySelector('.thread-list').getBoundingClientRect();
                resolve({ active: document.activeElement === row.querySelector('.thread-link'), top: box.top, bottom: box.bottom, viewTop: view.top, viewBottom: view.bottom });
              }));
            };
            document.addEventListener('focusin', onFocus);
          });
        });
        await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').focus();
        await page.keyboard.press('ArrowDown');
        const keyboardRow = await page.evaluate(() => window.__keyboardChildGeometry);
        assert.ok(keyboardRow, 'ArrowDown must focus the boundary child chat');
        assert.ok(keyboardRow.active, 'the child chat link receives focus');
        assert.ok(keyboardRow.top >= keyboardRow.viewTop - .5 && keyboardRow.bottom <= keyboardRow.viewBottom + .5, `keyboard focus reveals the complete child row: ${JSON.stringify(keyboardRow)}`);
      }
      if (height === 640) {
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
      const lastGeometry = await last.evaluate(row => {
        const rowBox = row.getBoundingClientRect(), listBox = row.closest('.thread-list').getBoundingClientRect();
        return { visible: rowBox.top >= listBox.top - .5 && rowBox.bottom <= listBox.bottom + .5, height: rowBox.height, viewport: listBox.height };
      });
      assert.equal(lastGeometry.visible, true, `the final chat stays reachable as a complete ${lastGeometry.height}px row in the ${lastGeometry.viewport}px list`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
