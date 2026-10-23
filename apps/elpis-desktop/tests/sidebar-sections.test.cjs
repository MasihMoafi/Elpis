// Masih, 23 Oct (screenshot of the sidebar): "I should be able to collapse these as well"; then "When I say change one thing I want it to apply to all those similar elements in the UI." So: every section heading of the sidebar folds, and a new heading that does not breaks this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const chat = (id, name) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const threads = [chat('chat-a', 'Alpha chat'), chat('chat-b', 'Beta chat'), chat('chat-c', 'Gamma chat')];
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
    assert.deepEqual(f.errors ?? [], []);
  } finally { await f.close(); }
});
