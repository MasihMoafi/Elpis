// Right-click in the app. Chats, projects, the chat tab and messages keep their "…" or hover actions and append "Change this…";
// text, links and images are left to Electron's native menu (desktop/context-menu.cjs), so the page must not cancel those.
// Synthetic HTTP/SSE; no engine or provider calls. Screenshots of each menu go to $ELPIS_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');
const CWD = '/tmp/elpis-rclick-fixture';
const CHAT_ACTIONS = ['Rename', 'Pin', 'Bookmark', 'Organize', 'Mark as unread', 'Open in', 'Archive', 'Delete'];
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}

async function fixture(run, { desktop = true } = {}) {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  const threads = names.map(name => ({ id: name.toLowerCase(), name, preview: name, cwd: CWD, model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } }));
  const calls = [], gone = new Set();
  const entries = [
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Please summarize the cache design.' }] } },
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'reply-1', type: 'agentMessage', text: 'The cache keeps one prefix per chat. Read [the docs](https://docs.example.invalid/cache) for more.' } },
  ];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const id = url.pathname.split('/')[3], thread = threads.find(item => item.id === id);
    if (req.method === 'POST') calls.push({ path: url.pathname, data: raw ? JSON.parse(raw) : undefined });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads.filter(item => !gone.has(item.id)), nextCursor: null });
    if (url.pathname.endsWith('/delete') || url.pathname.endsWith('/archive')) { gone.add(id); return json({ deleted: true, alsoDeleted: [] }); }
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread) return json({ thread, data: id === 'alpha' ? entries : [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, desktop }) => {
      localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'project-1', name: 'Fixture project', cwd }], selectedId: null }));
      // Whether each right-click ended up cancelled once every handler had run: a cancelled event shows no native menu.
      window.__contextmenu = []; window.addEventListener('contextmenu', event => setTimeout(() => window.__contextmenu.push(event.defaultPrevented)), true);
      window.__opened = [];
      // Electron provides native Change this support; its onPoint hook keeps text/link/edit menus native.
      if (desktop) window.elpisDesktop = { improve: { onPoint: () => () => {} }, browser: { command: async () => ({ visible: false, activeId: null, focusAddress: 0, tabs: [] }), layout() {}, subscribe: callback => { callback({ visible: false, activeId: null, focusAddress: 0, tabs: [] }); return () => {}; } }, chooseFolder: async () => null, openFolder: async folder => { window.__opened.push(folder); } };
    }, { cwd: CWD, desktop });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    const row = id => page.locator(`.thread-list .thread-row[data-thread-id="${id}"]`).first();
    await row('alpha').waitFor();
    const shot = async name => { if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `${name}.png`) }); } };
    const menu = () => page.getByRole('menu');
    const items = async () => { await menu().waitFor(); return menu().getByRole('menuitem').evaluateAll(list => list.map(item => { const copy = item.cloneNode(true); copy.querySelectorAll('kbd').forEach(key => key.remove()); return copy.textContent.trim(); })); };
    const closeMenu = async () => { await page.keyboard.press('Escape'); await menu().waitFor({ state: 'detached' }); await page.waitForFunction(() => !document.querySelector('[data-base-ui-inert]')); };
    const lastPrevented = async () => { await page.waitForTimeout(60); return page.evaluate(() => window.__contextmenu.at(-1)); };
    // Compare the shared actions' dimensions and style, accounting for the extra right-click action's height.
    const popup = async () => menu().evaluate(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element), change = [...element.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === 'Change this…'); return { width: Math.round(box.width), height: Math.round(box.height - (change?.getBoundingClientRect().height ?? 0)), background: style.backgroundColor, border: style.borderTopColor, radius: style.borderTopLeftRadius, font: style.fontSize }; });
    await run({ page, row, items, closeMenu, lastPrevented, popup, shot, menu, calls, errors });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
}

test('a chat row opens its "…" menu on right-click, at the pointer, without the native menu', () => fixture(async ({ page, row, items, closeMenu, lastPrevented, popup, shot, menu, calls }) => {
  const dots = row('alpha').getByRole('button', { name: 'Actions for Alpha', exact: true });
  await row('alpha').hover(); await dots.click();
  const fromButton = await items(), buttonLook = await popup();
  assert.deepEqual(fromButton, CHAT_ACTIONS);
  await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
  const organization = page.getByRole('menu', { name: 'Organize', exact: true });
  await organization.waitFor();
  assert.deepEqual(await organization.getByRole('menuitem').allTextContents(), ['Move to group', 'Put under…', 'Move to project…', 'New project from this chat…']);
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: 'Open in', exact: true }).hover();
  const opening = page.getByRole('menu', { name: 'Open in', exact: true }); await opening.waitFor();
  assert.match(await opening.innerText(), /Split view/);
  await page.keyboard.press('Escape');
  await shot('chat-row-dots-menu');
  await closeMenu();
  const box = await row('alpha').boundingBox();
  await row('alpha').click({ button: 'right', position: { x: 90, y: box.height / 2 } });
  assert.deepEqual(await items(), [...fromButton, 'Change this…'], 'right-click keeps the "…" actions and appends Improve Elpis');
  assert.equal(await lastPrevented(), true, 'the page cancels the native menu so only one appears');
  assert.deepEqual(await popup(), buttonLook, 'same size and look as the "…" menu');
  const at = await page.getByRole('menu').boundingBox();
  assert.ok(Math.abs(at.x - (box.x + 90)) < 12 && at.y > box.y && at.y < box.y + box.height + 40, `opens at the pointer (${JSON.stringify(at)} for row ${JSON.stringify(box)})`);
  await shot('chat-row-right-click');
  await closeMenu();
  // The row stays marked while its menu is open, so it is clear which chat the menu acts on.
  await row('bravo').click({ button: 'right' }); await menu().waitFor();
  assert.notEqual(await row('bravo').getAttribute('data-popup-open'), null);
  assert.notEqual(await row('bravo').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  await closeMenu();
  assert.equal(await row('bravo').getAttribute('data-popup-open'), null);
  // The keyboard's menu key (Shift+F10) opens it for the focused chat.
  await row('bravo').locator('.thread-link').focus(); await page.keyboard.press('Shift+F10');
  assert.deepEqual(await items(), [...fromButton, 'Change this…']);
  await closeMenu();
  // Each item works from the right-click menu: Archive posts, Rename opens its dialog, Delete asks first.
  await row('bravo').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('alertdialog').getByLabel('Conversation name').waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  await row('charlie').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByText('Delete “Charlie”?').waitFor();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await row('delta').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await eventually(async () => assert.deepEqual(calls.filter(call => call.path.endsWith('/archive')).map(call => call.path), ['/api/threads/delta/archive']));
}));

test('F2 renames the focused chat row, shows F2 in the Rename item, and leaves typing and other rows alone', () => fixture(async ({ page, row, items, closeMenu, menu, calls }) => {
  const dialog = page.getByRole('alertdialog'), field = dialog.getByLabel('Conversation name');
  const link = id => row(id).locator('.thread-link');
  // Discoverable: the Rename item carries the key.
  await row('bravo').click({ button: 'right' });
  await items();
  assert.equal(await menu().getByRole('menuitem', { name: /^Rename/ }).locator('kbd').textContent(), 'F2');
  await closeMenu();
  // Positive: the focused row is the one renamed, not the open chat (Alpha) or a neighbour.
  await link('charlie').focus(); await page.keyboard.press('F2');
  await field.waitFor(); assert.equal(await field.inputValue(), 'Charlie');
  await field.fill('Charlie renamed');
  await page.keyboard.press('F2'); // inside the dialog's field F2 does nothing more
  assert.equal(await dialog.count(), 1);
  await page.keyboard.press('Enter');
  await eventually(async () => assert.deepEqual(calls.filter(call => call.path.endsWith('/rename')), [{ path: '/api/threads/charlie/rename', data: { name: 'Charlie renamed' } }]));
  await dialog.waitFor({ state: 'hidden' });
  // Cancel: Escape closes without saving.
  await link('delta').focus(); await page.keyboard.press('F2');
  await field.waitFor(); assert.equal(await field.inputValue(), 'Delta');
  await field.fill('Never saved'); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(calls.filter(call => call.path.endsWith('/rename')).length, 1);
  // Negative: with focus in the message box (a text field), F2 opens nothing.
  const composer = page.locator('textarea').first(); await composer.focus(); await page.keyboard.press('F2');
  await page.waitForTimeout(150); assert.equal(await dialog.count(), 0);
  // Negative: with Ctrl, Shift or Alt held, or on a menu, F2 is not Rename.
  await link('bravo').focus();
  for (const combo of ['Control+F2', 'Shift+F2', 'Alt+F2']) { await page.keyboard.press(combo); await page.waitForTimeout(80); assert.equal(await dialog.count(), 0, combo); }
  // The open menu's F2 picks Rename for the row whose menu it is.
  await row('bravo').click({ button: 'right' }); await menu().waitFor();
  // A visible popup can still be handing focus off from the row. F2 must go
  // to the menu; otherwise the row opens Rename underneath the still-open menu.
  await eventually(async () => assert.equal(await menu().evaluate(element => element.contains(document.activeElement)), true));
  await page.keyboard.press('F2');
  await menu().waitFor({ state: 'detached' });
  await field.waitFor(); assert.equal(await field.inputValue(), 'Bravo');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
}));

test('right-click on a chat inside a Ctrl/Shift selection acts on the whole selection, as D does', () => fixture(async ({ page, row, items, closeMenu, popup, shot, calls }) => {
  const link = id => row(id).locator('.thread-link');
  await link('alpha').click(); await link('charlie').click({ modifiers: ['Control'] }); await link('delta').click({ modifiers: ['Control'] });
  await row('charlie').click({ button: 'right' });
  assert.deepEqual(await items(), ['Organize', 'Archive 3 chats', 'Delete 3 chats', 'Change this…']);
  await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
  const organization = page.getByRole('menu', { name: 'Organize', exact: true }); await organization.waitFor();
  assert.deepEqual(await organization.getByRole('menuitem').allTextContents(), ['Move 3 chats to group', 'Put under…', 'Move to project…', 'New project from 3 chats…']);
  await page.keyboard.press('Escape');
  const fromRightClick = await popup();
  await shot('chat-selection-right-click');
  await closeMenu();
  await row('charlie').hover(); await row('charlie').getByRole('button', { name: 'Actions for Charlie', exact: true }).click();
  assert.deepEqual(await items(), ['Organize', 'Archive 3 chats', 'Delete 3 chats'], 'the "…" of a selected chat is the same list');
  assert.deepEqual(await popup(), fromRightClick);
  await closeMenu();
  await row('delta').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete 3 chats', exact: true }).click();
  await page.getByRole('alertdialog').getByText('Delete 3 chats?').waitFor();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await row('delta').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Archive 3 chats', exact: true }).click();
  await eventually(async () => assert.deepEqual(calls.filter(call => call.path.endsWith('/archive')).map(call => call.path).sort(), ['/api/threads/alpha/archive', '/api/threads/charlie/archive', '/api/threads/delta/archive']));
  // A chat outside the selection is acted on alone.
  await row('bravo').click({ button: 'right' });
  assert.deepEqual(await items(), [...CHAT_ACTIONS, 'Change this…']);
}));

test('a project opens its "…" menu on right-click', () => fixture(async ({ page, items, closeMenu, popup, shot }) => {
  const project = page.locator('aside .project-row').filter({ hasText: 'Fixture project' });
  await project.hover(); await project.getByRole('button', { name: 'Project actions for Fixture project', exact: true }).click();
  const fromButton = await items(), buttonLook = await popup();
  assert.deepEqual(fromButton, ['Edit…', 'Open in file manager', 'Remove project']);
  await shot('project-dots-menu');
  await closeMenu();
  await project.click({ button: 'right' });
  assert.deepEqual(await items(), [...fromButton, 'Change this…']);
  assert.deepEqual(await popup(), buttonLook);
  await shot('project-right-click');
  await page.getByRole('menuitem', { name: 'Open in file manager', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__opened), [CWD]);
  await project.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click();
  await page.getByLabel('Project name').waitFor();
}));

test('the chat tab opens the "Chat actions" menu on right-click', () => fixture(async ({ page, row, items, closeMenu, popup, shot }) => {
  await row('alpha').locator('.thread-link').click();
  const tab = page.getByRole('tablist', { name: 'Chat tabs' }).getByRole('tab', { name: 'Alpha' });
  await tab.waitFor();
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  const fromButton = await items(), buttonLook = await popup();
  assert.deepEqual(fromButton, CHAT_ACTIONS);
  await shot('chat-tab-dots-menu');
  await closeMenu();
  await tab.click({ button: 'right' });
  assert.deepEqual(await items(), [...fromButton, 'Change this…']);
  assert.deepEqual(await popup(), buttonLook);
  await shot('chat-tab-right-click');
}));

test('without the desktop tab strip, the chat title right-clicks into the same menu', () => fixture(async ({ page, row, items, closeMenu }) => {
  await row('alpha').locator('.thread-link').click();
  await page.locator('.header-title-row h1').waitFor();
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  const fromButton = await items(); await closeMenu();
  await page.locator('.header-title-row h1').click({ button: 'right' });
  assert.deepEqual(await items(), [...fromButton, 'Change this…']);
}, { desktop: false }));

test('a message right-click opens the message menu, the same list as the hover …; selected text, links and fields keep the native menu', () => fixture(async ({ page, row, items, closeMenu, lastPrevented, popup, shot }) => {
  await row('alpha').locator('.thread-link').click();
  const user = page.locator('.user-turn'), reply = page.locator('article.message.agent');
  await reply.waitFor();
  // The hover … opens the same list as a right-click (the message menu's own contents are in claude-chat.test.cjs).
  const hovered = async scope => { await scope.hover(); await scope.getByRole('button', { name: 'More message actions', exact: true }).click(); const list = await items(); await closeMenu(); return list; };
  // Right-click on a message that has no selection.
  const userMenu = await hovered(user);
  await page.evaluate(() => getSelection().removeAllRanges());
  await user.locator('.message.user').click({ button: 'right' });
  assert.deepEqual(await items(), [...userMenu, 'Change this…'], 'a user message keeps the hover actions and appends Improve Elpis');
  assert.ok((await items()).includes('Copy as Markdown'));
  assert.equal(await lastPrevented(), true);
  await shot('message-user-right-click');
  await page.getByRole('menuitem', { name: 'Copy as Markdown', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Please summarize the cache design.');
  const replyMenu = await hovered(reply);
  await page.evaluate(() => getSelection().removeAllRanges());
  const paragraph = reply.locator('p').first();
  // A paragraph's centre can land on its link. Target plain text for the app-menu case.
  const plainTextPoint = await paragraph.evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 3);
    const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
    return { x: text.x - box.x + text.width / 2, y: text.y - box.y + text.height / 2 };
  });
  await paragraph.click({ button: 'right', position: plainTextPoint });
  assert.deepEqual(await items(), [...replyMenu, 'Change this…'], 'a reply keeps the hover actions and appends Improve Elpis');
  assert.ok((await items()).includes('Copy as Markdown'));
  await shot('message-reply-right-click');
  await page.getByRole('menuitem', { name: 'Copy as Markdown', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^The cache keeps one prefix per chat\./);
  // Selected text: the page leaves the right-click to the native Copy.
  await paragraph.click({ clickCount: 3, position: plainTextPoint });
  assert.notEqual(await page.evaluate(() => getSelection().toString()), '');
  await paragraph.click({ button: 'right' });
  assert.equal(await lastPrevented(), false, 'selected text shows the native Copy');
  assert.equal(await page.getByRole('menu').count(), 0);
  // A link keeps the native Open link / Copy link; so do the composer and plain space.
  await page.mouse.click(5, 500);
  await reply.getByRole('link', { name: 'the docs' }).click({ button: 'right' });
  assert.equal(await lastPrevented(), false, 'a link shows the native link items');
  assert.equal(await page.getByRole('menu').count(), 0);
  await page.getByLabel('Message Elpis').click({ button: 'right' });
  assert.equal(await lastPrevented(), false, 'the composer shows the native edit items');
  assert.equal(await page.getByRole('menu').count(), 0);
}));
