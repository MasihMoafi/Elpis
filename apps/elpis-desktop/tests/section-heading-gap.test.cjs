// Masih, 31 Oct (arrow at the Love Spot heading): "you don't see how these are too close? how many times have I
// emphasized a coherent structure in the UI?" One gap from a heading's name to its first row, on every sidebar section
// (Projects, Pinned, Love Spot, Recents...). Heads with a button and heads without one used to differ: Love Spot sat 10px
// above its row, Recents 15px. (The Settings navigation's group names stay tight so it fits 768px windows, 27 Oct.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cjs');

/** For each heading in `scope`: the gap from its name's text to the first row under it. */
const gaps = (page, scope, heads, row) => page.evaluate(([scope, heads, row]) => [...document.querySelectorAll(`${scope} ${heads}`)].flatMap(head => {
  const next = head.parentElement.querySelector(row);
  const text = [...head.querySelectorAll('*'), head].flatMap(el => [...el.childNodes]).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (!next || !text || !next.getBoundingClientRect().height) return [];
  const range = document.createRange(); range.selectNodeContents(text);
  return [{ name: text.textContent.trim(), gap: Math.round(next.getBoundingClientRect().top - range.getBoundingClientRect().bottom) }];
}), [scope, heads, row]);

for (const colorScheme of ['light']) test(`every heading sits the same distance above its first row (${colorScheme})`, async () => {
  const love = { ...THREADS[0], id: 'love-chat', name: 'Love Spot', preview: 'Love Spot' };
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, colorScheme, threads: [...THREADS, love], storage: {
    'elpis-pinned-chats-v1': JSON.stringify(['chat-c']),
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p1', name: 'Project one', cwd: '/tmp' }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ 'chat-b': 'p1' }),
  } }), { page } = f;
  try {
    await page.locator('section[aria-label="Love Spot"] .thread-row').waitFor();
    await page.locator('section[aria-label="Pinned"] .thread-row').waitFor();
    const sidebar = await gaps(page, 'aside.sidebar', 'section > .section-label-row', '.thread-row, .sidebar-group-row');
    assert.deepEqual(sidebar.map(item => item.name), ['Projects', 'Pinned', 'Love Spot', 'Recents']);
    const all = sidebar;
    assert.equal(new Set(all.map(item => item.gap)).size, 1, `one heading-to-row gap: ${JSON.stringify(all)}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
