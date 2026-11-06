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
// Colour follows Bookmark in sidebar and tab menus (577d5a5ad; R84, SPEC C8: Masih, 27 Oct, a colour for any conversation).
const CHAT_ACTIONS = ['Rename', 'Pin', 'Bookmark', 'Colour', 'Organize', 'Mark as unread', 'Open in', 'Archive', 'Delete'];
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
    // The open top-level menu: a closing menu or submenu stays in the page during its exit animation (two matched under load on CI).
    const menu = () => page.getByRole('menu').and(page.locator(':not([data-closed]):not([data-nested])'));
    const items = async () => { await menu().waitFor(); return menu().getByRole('menuitem').evaluateAll(list => list.map(item => { const copy = item.cloneNode(true); copy.querySelectorAll('kbd').forEach(key => key.remove()); return copy.textContent.trim(); })); };
    const closeMenu = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[role="menu"]')); await page.waitForFunction(() => !document.querySelector('[data-base-ui-inert]')); };
    const lastPrevented = async () => { await page.waitForTimeout(60); return page.evaluate(() => window.__contextmenu.at(-1)); };
    // Compare the shared actions' dimensions and style, accounting for the extra right-click action's height.
    const popup = async () => menu().evaluate(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element), change = [...element.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === 'Change this…'); return { width: Math.round(box.width), height: Math.round(box.height - (change?.getBoundingClientRect().height ?? 0)), background: style.backgroundColor, border: style.borderTopColor, radius: style.borderTopLeftRadius, font: style.fontSize }; });
    await run({ page, row, items, closeMenu, lastPrevented, popup, shot, menu, calls, errors });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
}

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
  // Escape closes only the submenu; it is still in the page during its exit animation (two menus match under load).
  await page.keyboard.press('Escape'); await organization.waitFor({ state: 'detached' });
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
