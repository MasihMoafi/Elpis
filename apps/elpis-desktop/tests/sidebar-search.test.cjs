// Searching chats shows every matching chat as its own row, as the ChatGPT app does. On 24 Oct, searching "Rust" in
// Masih's chats showed only the parents ("main", collapsed) of the chats that matched, so the hits stayed hidden.
// Local bridge fixture (tests/parity-fixture.cjs) whose search answers as the engine does: name or first message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const chat = (id, name, extra = {}) => ({ id, name, preview: name, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const threads = [
  chat('chat-a', 'main', { preview: 'Plan the Rust port' }),
  chat('engine', 'Elpis Rust engine', { parentThreadId: 'chat-a', source: 'vscode' }),
  chat('docs', 'Write the docs'),
  chat('obsidian', 'rust-obsidian'),
];

test('a search lists each matching chat, also one started from another or pinned in a folded section, and nothing else', async () => {
  const f = await fixture({ desktop: true, threads, routes: {
    '/api/threads': (_body, url) => {
      const term = url.searchParams.get('searchTerm');
      if (url.searchParams.has('ancestorThreadId')) return { data: [], nextCursor: null };
      return { data: threads.filter(t => !term || t.name.includes(term) || t.preview.includes(term)), nextCursor: null };
    },
  } });
  try {
    const { page } = f;
    const rows = () => page.locator('.thread-row .thread-link .thread-title').allInnerTexts();
    // A pinned hit shows even while Pinned is folded, as a Recents hit does.
    await page.locator('.thread-row[data-thread-id="obsidian"]').hover();
    await page.getByRole('button', { name: 'Pin rust-obsidian', exact: true }).click();
    await page.locator('section[aria-label="Pinned"] .section-toggle').click();
    assert.equal((await rows()).includes('rust-obsidian'), false, 'Pinned is folded');
    await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('Rust');
    await page.getByText('Searching saved conversations…').waitFor({ state: 'detached' });
    await page.waitForTimeout(400); // the 250 ms search pause, then its answer
    assert.deepEqual((await rows()).sort(), ['Elpis Rust engine', 'main', 'rust-obsidian'].sort());
    assert.equal(await page.getByRole('button', { name: /^(Expand|Collapse) agents in/ }).count(), 0, 'results are one flat list');
    // The engine matches letter case exactly; the list already holds each chat's first message, so any case finds it.
    await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('rust');
    await page.waitForTimeout(400);
    assert.deepEqual((await rows()).sort(), ['Elpis Rust engine', 'main', 'rust-obsidian'].sort());
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
