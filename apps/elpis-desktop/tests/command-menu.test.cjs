// Ctrl+K is a command menu, as in Claude's desktop app ("Search or start a chat"): recent chats and actions; typing
// filters actions, chats and projects; ↑/↓ move (wrapping), Enter runs, Esc closes. Ctrl+Shift+K still searches the
// sidebar. The exported UI against tests/parity-fixture.cjs. Screenshots go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const shots = process.env.ELPIS_PARITY_SHOTS;
const { assertUiFit } = require('./ui-fit.cjs');

const chat = (id, name) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const LIST = [chat('chat-a', 'Fix the parser'), chat('chat-b', 'Write the docs'), chat('chat-c', 'Plan the release')];
/** The fixture's chat list, a saved-chat search that finds nothing more, and a new chat when one is created. */
const routes = { '/api/threads': (body, url) => body ? { thread: chat('chat-new', 'Write a haiku about lexers') }
  : { data: url.searchParams.has('searchTerm') || url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : LIST, nextCursor: null }, '/api/threads/chat-new/turns': () => ({ turn: { id: 't-new' } }) };

const menu = page => page.getByRole('dialog', { name: 'Command menu' });
const input = page => menu(page).getByRole('combobox', { name: 'Search or start a chat' });
const typeInMenu = async (page, text) => {
  await page.waitForFunction(() => document.activeElement?.matches('[role="combobox"][aria-label="Search or start a chat"]'));
  await page.keyboard.type(text);
};
const active = page => menu(page).locator('[role="option"][aria-selected="true"]');
const names = page => menu(page).locator('[role="option"] .command-name').allTextContents();
const sections = page => menu(page).locator('[role="group"]').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')));

test('Ctrl+K opens recent chats and actions; ↑/↓ wrap, Enter opens, Esc returns to the message box', async () => {
  const f = await fixture({ routes }), { page, composer } = f;
  try {
    await composer.fill('draft');
    await page.keyboard.press('Control+k');
    await input(page).waitFor();
    assert.ok(await input(page).evaluate(element => element === document.activeElement), 'the search box has the focus');
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
    assert.ok(await composer.evaluate(element => element === document.activeElement), 'Esc returns to where you were');
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
    const sent = page.waitForResponse(response => response.url().endsWith('/api/threads/chat-new/turns'));
    await page.keyboard.press('Enter');
    await menu(page).waitFor({ state: 'detached' });
    await sent;
    const created = f.posts.find(post => post.path === '/api/threads');
    assert.ok(created, 'a new chat was started');
    assert.ok(f.posts.some(post => post.path.endsWith('/turns') && JSON.stringify(post.body).includes('Write a haiku about lexers')), 'with the typed text as its first message');

    await page.keyboard.press('Control+Shift+K');
    assert.ok(await page.getByLabel('Search conversations').evaluate(element => element === document.activeElement), 'Ctrl+Shift+K focuses the sidebar search');
    assert.equal(await menu(page).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [900, 700]]) test(`the command menu's rows align and fit (${colorScheme}, ${width}×${height})`, async () => {
  const f = await fixture({ colorScheme, width, height, routes }), { page } = f;
  try {
    await f.open('chat-a');
    await page.keyboard.press('Control+k');
    await input(page).waitFor();
    const rows = await menu(page).locator('[role="option"]').evaluateAll(options => options.map(option => {
      const box = option.getBoundingClientRect(), name = option.querySelector('.command-name').getBoundingClientRect(), list = option.closest('[role="listbox"]').getBoundingClientRect();
      return { left: Math.round(name.left), inside: box.left >= list.left - 0.5 && box.right <= list.right + 0.5, height: Math.round(box.height) };
    }));
    assert.equal(new Set(rows.map(row => row.left)).size, 1, 'every name starts at one edge');
    assert.ok(rows.every(row => row.inside), 'no row leaves the list');
    assert.equal(new Set(rows.map(row => row.height)).size, 1, 'every row has one height');
    await assertUiFit(menu(page), 'command menu fits');
    if (shots) await page.screenshot({ path: path.join(shots, `command-menu-${colorScheme}-${width}.png`) });
    await typeInMenu(page, 're');
    await assertUiFit(menu(page), 'filtered command menu fits');
    if (shots) await page.screenshot({ path: path.join(shots, `command-menu-typed-${colorScheme}-${width}.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('mouse clicks run navigation actions; projects match folders; sidebar hint and shortcut help agree', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    await page.evaluate(() => localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'proj', name: 'Compiler', cwd: '/tmp/compiler-project' }], selectedId: null })));
    await page.reload(); await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').waitFor();
    assert.equal(await page.locator('aside.sidebar .search-field .kbd-hint').textContent(), 'Ctrl Shift K');
    for (const name of ['Workflows', 'Love Spot', 'Settings']) {
      await page.keyboard.press('Control+k'); await input(page).fill(name);
      await menu(page).getByRole('option', { name: new RegExp('^' + name) }).click();
      await menu(page).waitFor({ state: 'detached' });
      if (name === 'Settings') await page.getByRole('button', { name: 'Back to app', exact: true }).click();
      else await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    await page.keyboard.press('Control+k'); await input(page).fill('compiler-project');
    assert.ok((await sections(page)).includes('Projects'));
    await menu(page).getByRole('option', { name: /^Compiler/ }).click();
    await menu(page).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Choose project', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-projects-v1')).selectedId), 'proj');
    await page.keyboard.press('Control+/');
    const shortcuts = page.getByRole('alertdialog'); await shortcuts.waitFor();
    assert.match(await shortcuts.innerText(), /Command menu[\s\S]*Ctrl\+K/);
    assert.match(await shortcuts.innerText(), /Search chats[\s\S]*Ctrl\+Shift\+K/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('saved chat search finds a chat outside recents; cancelling restores the field that opened the menu', async () => {
  const remote = chat('saved-only', 'Recovered compiler notes');
  const f = await fixture({ routes: { ...routes, '/api/threads': (body, url) => url.searchParams.has('searchTerm') ? { data: [remote], nextCursor: null } : routes['/api/threads'](body, url), '/api/threads/saved-only/resume': () => ({ thread: remote }), '/api/threads/saved-only': () => ({ thread: remote, data: [], nextCursor: null }) } }), { page } = f;
  try {
    const search = page.getByLabel('Search conversations'); await search.click();
    await page.keyboard.press('Control+k'); await input(page).fill('Recovered');
    await menu(page).getByRole('option', { name: /^Recovered compiler notes/ }).click();
    await menu(page).waitFor({ state: 'detached' });
    await page.locator('.thread-row.active[data-thread-id="saved-only"]').waitFor();
    await search.click(); await page.keyboard.press('Control+k'); await page.keyboard.press('Escape');
    await menu(page).waitFor({ state: 'detached' });
    assert.ok(await search.evaluate(element => element === document.activeElement));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('menu search leaves Settings; Ctrl+Shift+K inside the menu searches; Ctrl+K and Close return focus', async () => {
  const f = await fixture({ routes }), { page, composer } = f;
  try {
    await composer.click(); await page.keyboard.press('Control+k'); await input(page).fill('Settings');
    await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Back to app', exact: true }).waitFor();
    await page.keyboard.press('Control+k'); await input(page).fill('Search chats'); await page.keyboard.press('Enter');
    const search = page.getByLabel('Search conversations');
    await search.waitFor();
    assert.ok(await search.evaluate(element => element === document.activeElement), 'Search chats reveals the sidebar and focuses it from Settings');
    await composer.click(); await page.keyboard.press('Control+k'); await input(page).waitFor(); await page.keyboard.press('Control+Shift+K');
    await menu(page).waitFor({ state: 'detached' });
    assert.ok(await search.evaluate(element => element === document.activeElement));
    await page.keyboard.press('Control+k'); await input(page).fill('unused'); await page.keyboard.press('Control+k');
    await menu(page).waitFor({ state: 'detached' });
    assert.ok(await search.evaluate(element => element === document.activeElement));
    await page.keyboard.press('Control+k'); assert.equal(await input(page).inputValue(), '');
    await menu(page).getByRole('button', { name: 'Close command menu' }).click();
    await menu(page).waitFor({ state: 'detached' });
    assert.ok(await search.evaluate(element => element === document.activeElement));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
