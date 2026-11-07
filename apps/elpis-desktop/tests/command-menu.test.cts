type Locator = { evaluate<T>(fn: (element: Element) => T): Promise<T>; first(): Locator; textContent(): Promise<string | null>; count(): Promise<number>; click(): Promise<void>; getByRole(role: string, options: { name: string | RegExp }): Locator; locator(selector: string): Locator; allTextContents(): Promise<string[]>; evaluateAll<T>(fn: (elements: Element[]) => T): Promise<T>; waitFor(options?: { state: string }): Promise<void>; fill(value: string): Promise<void> };
type Page = { getByRole(role: string, options: { name: string | RegExp }): Locator; waitForFunction(fn: () => boolean | undefined): Promise<void>; keyboard: { type(text: string): Promise<void> } };
type Post = { path: string; body: unknown };

// Ctrl+K is a command menu, as in Claude's desktop app ("Search or start a chat"): recent chats and actions; typing
// filters actions, chats and projects; ↑/↓ move (wrapping), Enter runs, Esc closes. Ctrl+Shift+K still searches the
// sidebar. The exported UI against tests/parity-fixture.cts. Screenshots go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cts');

const chat = (id: string, name: string) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const LIST = [chat('chat-a', 'Fix the parser'), chat('chat-b', 'Write the docs'), chat('chat-c', 'Plan the release')];
/** The fixture's chat list, a saved-chat search that finds nothing more, and a new chat when one is created. */
const routes = { '/api/threads': (body: unknown, url: URL) => body ? { thread: chat('chat-new', 'Write a haiku about lexers') }
  : { data: url.searchParams.has('searchTerm') || url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : LIST, nextCursor: null }, '/api/threads/chat-new/turns': () => ({ turn: { id: 't-new' } }) };

const menu = (page: Page) => page.getByRole('dialog', { name: 'Command menu' });
const input = (page: Page) => menu(page).getByRole('combobox', { name: 'Search or start a chat' });
const searchFocused = (page: Page) => page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Search conversations"]'));
const typeInMenu = async (page: Page, text: string) => {
  await page.waitForFunction(() => document.activeElement?.matches('[role="combobox"][aria-label="Search or start a chat"]'));
  await page.keyboard.type(text);
};
const active = (page: Page) => menu(page).locator('[role="option"][aria-selected="true"]');
const names = (page: Page) => menu(page).locator('[role="option"] .command-name').allTextContents();
const sections = (page: Page) => menu(page).locator('[role="group"]').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')));

test('Ctrl+K opens recent chats and actions; ↑/↓ wrap, Enter opens, Esc returns to the message box', async () => {
  const f = await fixture({ routes }), { page, composer } = f;
  try {
    await composer.fill('draft');
    await page.keyboard.press('Control+k');
    await input(page).waitFor();
    assert.ok(await input(page).evaluate((element: Element) => element === document.activeElement), 'the search box has the focus');
    assert.deepEqual(await sections(page), ['Recents', 'Actions']);
    const all = await names(page);
    assert.deepEqual(all.slice(0, 3), ['Fix the parser', 'Write the docs', 'Plan the release']);
    assert.ok(['New chat', 'Settings', 'Keyboard shortcuts', 'Toggle sidebar'].every(name => all.includes(name)));
    const newChat = menu(page).getByRole('option', { name: /^New chat/ });
    assert.equal(await newChat.locator('kbd').first().textContent(), 'Ctrl+N', 'an action shows its shortcut');
    assert.equal(await active(page).locator('.command-name').textContent(), 'Fix the parser');
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(page).locator('.command-name').textContent(), 'Write the docs');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    assert.equal(await active(page).locator('.command-name').textContent(), all.at(-1), '↑ from the top wraps to the last row');
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(page).locator('.command-name').textContent(), 'Fix the parser', '↓ from the bottom wraps to the top');
    await page.keyboard.press('Escape');
    await menu(page).waitFor({ state: 'detached' });
    assert.ok(await composer.evaluate((element: Element) => element === document.activeElement), 'Esc returns to where you were');
    assert.equal(await composer.inputValue(), 'draft');

    await page.keyboard.press('Control+k');
    await typeInMenu(page, 'docs');
    assert.deepEqual(await sections(page), ['Chats', 'New chat']);
    assert.equal(await active(page).locator('.command-name').textContent(), 'Write the docs');
    await page.keyboard.press('Enter');
    await menu(page).waitFor({ state: 'detached' });
    await page.locator('aside.sidebar .thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('typing filters the actions; Enter runs one; text that matches nothing starts a chat with it; Ctrl+Shift+K searches the sidebar', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    await f.open('chat-a');
    await page.keyboard.press('Control+k');
    await typeInMenu(page, 'pin');
    assert.equal(await active(page).locator('.command-name').textContent(), 'Pin chat');
    await page.keyboard.press('Enter');
    await page.locator('aside.sidebar section[aria-label="Pinned"] .thread-row[data-thread-id="chat-a"]').waitFor();

    await page.keyboard.press('Control+k');
    await typeInMenu(page, 'SETT');
    assert.equal(await active(page).locator('.command-name').textContent(), 'Settings', 'matching ignores case');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();

    await page.keyboard.press('Control+k');
    await typeInMenu(page, 'Write a haiku about lexers');
    assert.deepEqual(await sections(page), ['New chat']);
    assert.equal(await active(page).locator('.command-detail').textContent(), 'Write a haiku about lexers');
    const sent = page.waitForResponse((response: { url(): string }) => response.url().endsWith('/api/threads/chat-new/turns'));
    await page.keyboard.press('Enter');
    await menu(page).waitFor({ state: 'detached' });
    await sent;
    const created = f.posts.find((post: Post) => post.path === '/api/threads');
    assert.ok(created, 'a new chat was started');
    assert.ok(f.posts.some((post: Post) => post.path.endsWith('/turns') && JSON.stringify(post.body).includes('Write a haiku about lexers')), 'with the typed text as its first message');

    await page.keyboard.press('Control+Shift+K');
    await searchFocused(page);
    assert.ok(await page.getByLabel('Search conversations').evaluate((element: Element) => element === document.activeElement), 'Ctrl+Shift+K focuses the sidebar search');
    assert.equal(await menu(page).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('saved chat search finds a chat outside recents; cancelling restores the field that opened the menu', async () => {
  const remote = chat('saved-only', 'Recovered compiler notes');
  const f = await fixture({ routes: { ...routes, '/api/threads': (body: unknown, url: URL) => url.searchParams.has('searchTerm') ? { data: [remote], nextCursor: null } : routes['/api/threads'](body, url), '/api/threads/saved-only/resume': () => ({ thread: remote }), '/api/threads/saved-only': () => ({ thread: remote, data: [], nextCursor: null }) } }), { page } = f;
  try {
    const search = page.getByLabel('Search conversations'); await search.click();
    await page.keyboard.press('Control+k'); await input(page).fill('Recovered');
    await menu(page).getByRole('option', { name: /^Recovered compiler notes/ }).click();
    await menu(page).waitFor({ state: 'detached' });
    await page.locator('.thread-row.active[data-thread-id="saved-only"]').waitFor();
    await search.click(); await page.keyboard.press('Control+k'); await page.keyboard.press('Escape');
    await menu(page).waitFor({ state: 'detached' });
    assert.ok(await search.evaluate((element: Element) => element === document.activeElement));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
