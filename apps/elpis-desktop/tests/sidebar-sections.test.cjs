// Masih, 23 Oct (screenshot of the sidebar): "I should be able to collapse these as well"; then "When I say change one thing I want it to apply to all those similar elements in the UI." So: every section heading of the sidebar folds, and a new heading that does not breaks this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

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
