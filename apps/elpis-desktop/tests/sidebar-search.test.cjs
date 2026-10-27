// Searching chats shows every matching chat as its own row, as the ChatGPT app does. On 24 Oct, searching "Rust" in
// Masih's chats showed only the parents ("main", collapsed) of the chats that matched, so the hits stayed hidden.
// Local bridge fixture (tests/parity-fixture.cjs) whose search answers as the engine does: name or first message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { rowAction } = require('./controls.cjs');

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
    await rowAction(page, page.locator('.thread-row[data-thread-id="obsidian"]'), 'rust-obsidian', 'Pin');
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

// 24 Oct: searching "main" listed "main" below chats that merely mention it. Results rank as Zed's file finder does:
// the whole name, then its start, then a word's start, then anywhere in the name, then the chat's other text.
test('search ranks the chat named exactly as typed first, then name starts, word starts, other name hits, then other text', async () => {
  const ranked = [
    chat('older-mention', 'Write the docs', { preview: 'merge into main later' }),
    chat('inside', 'Domain notes'),
    chat('word', 'Hermes main setup'),
    chat('starts', 'Main branch cleanup'),
    chat('chat-a', 'main'),
  ];
  const f = await fixture({ desktop: true, threads: ranked, routes: {
    '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [] : ranked, nextCursor: null }),
  } });
  try {
    const { page } = f;
    const rows = () => page.locator('section[aria-label="Results"] .thread-row .thread-link .thread-title').allInnerTexts();
    await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('main');
    await page.waitForTimeout(400);
    assert.deepEqual(await rows(), ['main', 'Main branch cleanup', 'Hermes main setup', 'Domain notes', 'Write the docs']);
    await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('');
    // The command menu (Ctrl+K) ranks chats the same way.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+k');
    await page.keyboard.type('main');
    await page.waitForTimeout(400);
    const menuChats = await page.getByRole('option').allInnerTexts();
    assert.match(menuChats[0] ?? '', /^main/, 'the exact name leads the command menu too');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
