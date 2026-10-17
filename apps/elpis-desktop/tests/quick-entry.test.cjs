// Quick Entry, the tray's New chat and their settings, as Claude's desktop app has them, with real key presses:
// the Quick Entry page itself (desktop/quick-entry.html), the main page opening and sending a new chat when the main
// process hands it one, and Settings → General → System. A local bridge and a fake desktop; no engine, model or shortcut.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore, openSettings } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');

const out = path.resolve(__dirname, '../out');
const SHOTS = process.env.ELPIS_SHOTS; // A folder to keep screenshots in, for a look at the result.
/** What would start or send a chat: a new chat, or a message. */
const sends = posts => posts.filter(post => post.path === '/api/threads' || post.path.endsWith('/turns')).map(post => post.path);
const thread = (id, name) => ({ id, name, preview: name, cwd: '/tmp/quick-entry', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });

async function bridge() {
  const posts = [], threads = [thread('chat-a', 'Fix the parser')];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && url.pathname !== '/api/session') posts.push({ path: url.pathname, body });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'GPT-6.1-Sol', inputModalities: ['text'] }], nextCursor: null });
    if (url.pathname === '/api/threads' && req.method === 'POST') { const made = thread('chat-new', 'New chat'); threads.unshift(made); return json({ thread: made }); }
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : threads, nextCursor: null });
    const chat = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (chat && url.pathname.endsWith('/resume')) return json({ thread: chat, activeTurnId: null });
    if (chat && url.pathname.endsWith('/turns')) return json({ turn: { id: 'turn-1' } });
    if (chat && req.method === 'GET') return json({ thread: chat, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try {
      const file = path.join(out, url.pathname === '/' ? 'index.html' : url.pathname), content = await fs.readFile(file);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { posts, url: `http://127.0.0.1:${server.address().port}/#token=fixture`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

/** Runs with a headless Chrome, and the local bridge when `withBridge`; the browser closes first, then the bridge drops its
 * event streams, so a failing step can never leave Chrome open or the test file running. */
async function withBrowser(run, withBridge = false) {
  const server = withBridge ? await bridge() : null;
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try { await run(browser, server); } finally { await browser.close(); await server?.close(); }
}
const eventually = async check => { const end = Date.now() + 4000; for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } } };

test("Quick Entry: Claude's bar; Enter sends and clears, Shift+Enter adds a line, Esc or a click outside closes it", () => withBrowser(async browser => {
  const page = await browser.newPage({ viewport: { width: 606, height: 470 } }); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__sent = []; window.__dismissed = 0;
    window.elpisQuickEntry = { submit: text => window.__sent.push(text), dismiss: () => { window.__dismissed++; }, onShow: callback => { window.__show = callback; } };
  });
  await page.goto(`file://${path.resolve(__dirname, '../desktop/quick-entry.html')}?theme=dark`);
  const box = page.getByRole('textbox', { name: 'Message Elpis' });
  await eventually(async () => assert.equal(await box.evaluate(node => node === document.activeElement), true, 'it opens ready to type'));
  assert.equal(await box.getAttribute('placeholder'), 'What can I help you with today?');
  const bar = await page.locator('.bar').boundingBox();
  assert.deepEqual([bar.x, bar.y, bar.width], [0, 0, 606], "the bar spans Claude's 606-pixel window");
  assert.ok(bar.height >= 56, `the bar is at least 56 pixels tall: ${bar.height}`);
  assert.equal(await box.evaluate(node => getComputedStyle(node).fontSize), '16px');
  assert.equal(await page.locator('.bar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(17, 19, 23)', "the dark theme's card colour");
  await page.keyboard.type('Summarise the README');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('and the docs');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quick-entry-dark.png') });
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__sent), ['Summarise the README\nand the docs']);
  assert.equal(await box.inputValue(), '', 'Enter clears it for next time');
  await page.keyboard.type('a draft');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__dismissed), 1);
  assert.equal(await box.inputValue(), 'a draft', "Esc keeps the text, as Claude's does");
  await page.mouse.click(300, 400);
  assert.equal(await page.evaluate(() => window.__dismissed), 2, 'a click outside the bar closes it');
  await page.evaluate(() => window.__show({ dark: false }));
  assert.equal(await page.locator('.bar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)', 'it follows the app theme when shown');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quick-entry-light.png') });
  assert.deepEqual(errors, []);
}));

test("the main window opens Quick Entry's text as a new chat and sends it; the tray's New chat opens an empty one", () => withBrowser(async (browser, server) => {
  {
    const page = await browser.newPage({ viewport: { width: 1130, height: 660 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page); await page.addInitScript(fakeDesktop);
    await page.goto(server.url);
    const row = page.locator('.thread-row[data-thread-id="chat-a"]');
    await row.locator('.thread-link').click();
    await page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await composer.fill('unsent words for the parser');
    await page.evaluate(() => window.__newChat(''));
    await page.locator('.thread-row.active').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).getAttribute('aria-current'), 'page', 'a new chat is on screen');
    assert.deepEqual(sends(server.posts), [], 'the tray sends nothing');
    await page.evaluate(() => window.__newChat('Summarise the README'));
    await eventually(() => assert.deepEqual(sends(server.posts), ['/api/threads', '/api/threads/chat-new/turns']));
    assert.equal(server.posts.find(post => post.path === '/api/threads/chat-new/turns').body.text, 'Summarise the README');
    await page.locator('.thread-row.active[data-thread-id="chat-new"]').waitFor();
    await row.locator('.thread-link').click();
    await eventually(async () => assert.equal(await composer.inputValue(), 'unsent words for the parser', "the open chat's draft is kept"));
    assert.deepEqual(errors, []);
  }
}, true));

test('Settings → General → System: the Quick Entry shortcut is recorded from a key press, and Close to tray is off until switched on', () => withBrowser(async (browser, server) => {
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page); await page.addInitScript(fakeDesktop, { quickEntry: { refuse: ['Ctrl+Alt+J'] } });
    await page.goto(server.url);
    await openSettings(page);
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'General', exact: true }), system = panel.getByRole('region', { name: 'System' });
    const recorder = system.getByRole('button', { name: 'Quick Entry keyboard shortcut', exact: true });
    assert.deepEqual(await recorder.locator('kbd').allInnerTexts(), ['Ctrl', 'Alt', 'Space'], "Claude's Linux default");
    await system.getByText('Quickly open Elpis from anywhere.').waitFor();
    const tray = system.getByRole('switch', { name: 'Close to tray', exact: true });
    assert.equal(await tray.getAttribute('aria-checked'), 'false', 'off by default');
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('elpis-preferences-v1') || '{}'));
    await tray.click();
    await eventually(async () => assert.equal((await saved()).closeToTray, true));
    if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'settings-system.png') });

    await recorder.focus();
    await page.keyboard.press('Control+Alt+K');
    await eventually(async () => assert.deepEqual(await recorder.locator('kbd').allInnerTexts(), ['Ctrl', 'Alt', 'K']));
    assert.equal((await saved()).quickEntryShortcut, 'Ctrl+Alt+K');
    await page.keyboard.press('K');
    await system.getByRole('alert').filter({ hasText: 'reserved for common actions' }).waitFor();
    await page.keyboard.press('Control+S');
    await page.keyboard.press('Control+Alt+J');
    await system.getByRole('alert').filter({ hasText: 'already in use by another app' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__shortcuts), ['Ctrl+Alt+K', 'Ctrl+Alt+J'], 'refused keys are never registered');
    assert.equal((await saved()).quickEntryShortcut, 'Ctrl+Alt+K', 'a shortcut another app holds is not saved');
    await system.getByRole('button', { name: 'Turn off the Quick Entry shortcut', exact: true }).click();
    await recorder.getByText('Set shortcut').waitFor();
    assert.equal((await saved()).quickEntryShortcut, '');
    assert.deepEqual(errors, []);

    // A Wayland session without the GlobalShortcuts portal: Elpis says so and offers no recorder to fail silently.
    const wayland = await browser.newPage({ viewport: { width: 1280, height: 900 } }); wayland.setDefaultTimeout(6000);
    await guardDesktopStore(wayland); await wayland.addInitScript(fakeDesktop, { quickEntry: { supported: false, shortcut: '', reason: 'Global keyboard shortcuts need the GlobalShortcuts desktop portal, which this Wayland session does not provide.' } });
    await wayland.goto(server.url);
    await openSettings(wayland);
    await wayland.getByRole('tab', { name: 'General', exact: true }).click();
    const blocked = wayland.getByRole('tabpanel', { name: 'General', exact: true }).getByRole('region', { name: 'System' });
    await blocked.getByText('Global keyboard shortcuts need the GlobalShortcuts desktop portal, which this Wayland session does not provide.').waitFor();
    assert.equal(await blocked.getByRole('button', { name: 'Quick Entry keyboard shortcut', exact: true }).isDisabled(), true);
    if (SHOTS) await blocked.screenshot({ path: path.join(SHOTS, 'settings-system-wayland.png') });
  }
}, true));
