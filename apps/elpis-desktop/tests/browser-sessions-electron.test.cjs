const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture } = require('./parity-fixture.cjs');

test('session browsers switch, start empty, restore history, isolate concurrent tools and close with their chat', async () => {
  const profiles = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(profiles, { recursive: true });
  const root = await fs.mkdtemp(path.join(profiles, 'session-browsers-'));
  const shots = process.env.ELPIS_BROWSER_SESSION_SHOTS;
  const f = await fixture({ desktop: false, routes: { '/api/trash': body => ({ trashed: body.threadIds }) } });
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Page ${req.url}</title><style>:root{color-scheme:light dark}body{background:Canvas;color:CanvasText}</style><h1>Session page ${req.url}</h1><input aria-label="Session note"><button class="btn" onclick="const heading=document.querySelector('h1');heading.textContent=document.querySelector('input').value;heading.dataset.saved='true'">Save</button>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const display = await new Promise((resolve, reject) => { xvfb.once('error', reject); xvfb.stdio[3].once('data', value => resolve(`:${String(value).trim()}`)); });
  let electron, page, nativeErrors = '';
  const launch = async () => {
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'session-windows-electron.cjs')],
      env: { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', ELECTRON_OZONE_PLATFORM_HINT: 'x11', HOME: root, ELPIS_HOME: root, SESSION_WINDOW_PROFILE: path.join(root, 'profile'), SESSION_WINDOW_URL: f.page.url(), SESSION_BROWSER_TOOLS: '1' } });
    electron.process().stderr.on('data', data => { nativeErrors = (nativeErrors + data).slice(-6000); });
    page = await electron.firstWindow(); page.setDefaultTimeout(10000);
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
  };
  const select = async id => { await page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`).click(); await page.locator(`.thread-row.active[data-thread-id="${id}"]`).waitFor(); };
  const state = () => page.evaluate(() => window.elpisDesktop.browser.command('state'));
  const address = () => page.getByRole('textbox', { name: 'Search or enter a URL', exact: true });
  const visit = async url => { await address().fill(url); await address().press('Enter'); await page.getByRole('tab', { name: `Page ${new URL(url).pathname}`, exact: true }).waitFor(); };
  const newPage = async url => {
    const show = page.getByRole('button', { name: 'Show side panel', exact: true }); if (await show.count()) await show.click();
    await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Browser tab', exact: true }).click(); await visit(url);
  };
  const { callBrowser } = await import('../bridge/browser-mcp.mjs');
  try {
    await launch();
    const initial = await state();
    const background = await electron.evaluate(() => ({ path: global.browserSocket.path, capability: global.browserSocket.scope('first-background'), other: global.browserSocket.scope('other-background') }));
    const backgroundCall = (name, args = {}) => callBrowser(background.path, name, args, background.capability);
    const backgroundTab = (await backgroundCall('browser_open', { url: `${base}/background` })).tabId;
    await backgroundCall('browser_wait', { tabId: backgroundTab, selector: 'button' });
    const backgroundPage = await backgroundCall('browser_snapshot', { tabId: backgroundTab });
    assert.ok(backgroundPage.viewport.width > 0 && backgroundPage.viewport.height > 0, 'a never-shown session has a usable viewport');
    await backgroundCall('browser_type', { tabId: backgroundTab, selector: 'input', text: 'FIRST_BACKGROUND_PROOF' });
    await backgroundCall('browser_click', { tabId: backgroundTab, selector: 'button' });
    // Native input dispatch is asynchronous. Wait for its DOM result before reading a snapshot.
    await backgroundCall('browser_wait', { tabId: backgroundTab, selector: 'h1[data-saved]' });
    assert.match((await backgroundCall('browser_snapshot', { tabId: backgroundTab })).text, /FIRST_BACKGROUND_PROOF/);
    assert.equal((await backgroundCall('browser_screenshot', { tabId: backgroundTab })).content[0].type, 'image');
    await assert.rejects(callBrowser(background.path, 'browser_snapshot', { tabId: backgroundTab }, background.other), /closed/);
    assert.equal((await state()).sessionId, initial.sessionId, 'background input does not switch the shown session');
    assert.equal((await state()).tabs.length, 0);
    await electron.evaluate(() => global.sessionWindows.closeBrowser('first-background'));
    await select('chat-a'); await newPage(`${base}/a`); await visit(`${base}/a-next`);
    const a = (await state()).tabs[0]; assert.equal(a.canGoBack, true);
    await newPage(`${base}/a-extra`); const extra = (await state()).tabs[1];
    await page.getByRole('tab', { name: 'Page /a-next', exact: true }).click();
    await select('chat-b');
    assert.equal((await state()).tabs.length, 0, 'chat B must not inherit A pages');
    await newPage(`${base}/b`); const b = (await state()).tabs[0];
    const nativeA = electron.context().pages().find(page => page.url() === `${base}/a-next`), nativeB = electron.context().pages().find(page => page.url() === `${base}/b`);
    await nativeA.evaluate(() => { document.cookie = 'browser-sign-in=shared;path=/'; });
    assert.match(await nativeB.evaluate(() => document.cookie), /browser-sign-in=shared/, 'website sign-ins stay shared');
    await select('chat-a'); assert.equal(await address().inputValue(), `${base}/a-next`);
    assert.deepEqual((await state()).tabs.map(tab => tab.id), [a.id, extra.id]);
    await page.getByRole('button', { name: 'Close Page /a-extra tab', exact: true }).click();
    await page.getByRole('form', { name: 'Browser navigation' }).getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('tab', { name: 'Page /a', exact: true }).waitFor();
    await page.getByRole('form', { name: 'Browser navigation' }).getByRole('button', { name: 'Forward', exact: true }).click();
    await page.getByRole('tab', { name: 'Page /a-next', exact: true }).waitFor();
    // Ctrl+T is a real renderer key: each unsent chat also starts with an empty browser.
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).focus(); await page.keyboard.press('Control+t');
    await page.waitForFunction(() => !document.querySelector('.thread-row.active'));
    assert.equal((await state()).tabs.length, 0, 'new chat browser is empty');
    await newPage(`${base}/draft`);
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).focus(); await page.keyboard.press('Control+t');
    assert.equal((await state()).tabs.length, 0, 'another new chat must not share the first draft browser');
    await select('chat-b'); assert.equal(await address().inputValue(), `${base}/b`);

    const credentials = await electron.evaluate(() => ({ path: global.browserSocket.path, a: global.browserSocket.scope('chat-a'), b: global.browserSocket.scope('chat-b') }));
    const call = (session, name, args = {}) => callBrowser(credentials.path, name, args, credentials[session]);
    const [ta, tb] = await Promise.all([call('a', 'browser_tabs'), call('b', 'browser_tabs')]);
    assert.deepEqual(ta.tabs.map(tab => tab.id), [a.id]); assert.deepEqual(tb.tabs.map(tab => tab.id), [b.id]);
    await assert.rejects(call('a', 'browser_snapshot', { tabId: b.id }), /closed/);
    await assert.rejects(callBrowser(credentials.path, 'browser_tabs', {}), /session|capability/i);
    // Hold A's DOM read while B types and clicks. B must finish before A is released.
    await electron.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url), original = wc.executeJavaScriptInIsolatedWorld.bind(wc);
      global.releaseBrowserRead = null;
      wc.executeJavaScriptInIsolatedWorld = (...args) => new Promise(resolve => { global.releaseBrowserRead = () => { wc.executeJavaScriptInIsolatedWorld = original; resolve(original(...args)); }; });
    }, `${base}/a-next`);
    const pendingA = call('a', 'browser_snapshot', { tabId: a.id });
    await electron.waitForEvent('console', { predicate: () => false, timeout: 50 }).catch(() => {});
    await call('b', 'browser_type', { tabId: b.id, selector: 'input', text: 'Only session B' });
    await call('b', 'browser_click', { tabId: b.id, selector: 'button' });
    await call('b', 'browser_wait', { tabId: b.id, selector: 'h1[data-saved]' });
    await electron.evaluate(() => { if (!global.releaseBrowserRead) throw Error('A read did not start'); global.releaseBrowserRead(); });
    assert.match((await pendingA).text, /Session page \/a-next/);
    assert.match((await call('b', 'browser_snapshot', { tabId: b.id })).text, /Only session B/);
    await call('a', 'browser_type', { tabId: a.id, selector: 'input', text: 'Only hidden session A' });
    await call('a', 'browser_click', { tabId: a.id, selector: 'button' });
    await call('a', 'browser_wait', { tabId: a.id, selector: 'h1[data-saved]' });
    assert.match((await call('a', 'browser_snapshot', { tabId: a.id })).text, /Only hidden session A/);
    assert.match((await call('b', 'browser_snapshot', { tabId: b.id })).text, /Only session B/);
    await select('chat-a'); assert.equal(await address().inputValue(), `${base}/a-next`, 'B tools did not select or navigate A');
    if (shots) {
      await fs.mkdir(shots, { recursive: true });
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        await page.waitForFunction(dark => document.querySelector('.app-shell').classList.contains('dark') === dark, colorScheme === 'dark');
        await new Promise(resolve => setTimeout(resolve, 300));
        const box = await (await electron.browserWindow(page)).evaluate(host => host.getContentBounds());
        const file = path.join(shots, `session-a-${colorScheme}.png`);
        execFileSync('python3', ['-c', `from PIL import ImageGrab;ImageGrab.grab(xdisplay=${JSON.stringify(display)}).crop((${box.x},${box.y},${box.x + box.width},${box.y + box.height})).save(${JSON.stringify(file)})`]);
      }
    }
    await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
    const opened = electron.waitForEvent('window');
    await page.getByRole('menuitem', { name: 'Open session in new window', exact: true }).click();
    const secondWindow = await opened; secondWindow.setDefaultTimeout(10000);
    await secondWindow.getByRole('textbox', { name: 'Search or enter a URL', exact: true }).waitFor();
    assert.deepEqual((await secondWindow.evaluate(() => window.elpisDesktop.browser.command('state'))).tabs.map(tab => tab.id), [a.id]);
    assert.equal(await electron.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter(wc => wc.getURL() === url).length, `${base}/a-next`), 1, 'one session keeps one native page across windows');
    await secondWindow.close(); await page.bringToFront();
    await address().waitFor(); assert.equal(await address().inputValue(), `${base}/a-next`);
    await electron.evaluate(() => global.sessionWindows.flushBrowsers());
    await electron.close(); electron = null; await launch();
    await select('chat-a'); assert.equal(await address().inputValue(), `${base}/a-next`);
    assert.equal((await state()).tabs[0].canGoBack, true, 'history survives app restart');
    await page.getByRole('form', { name: 'Browser navigation' }).getByRole('button', { name: 'Back', exact: true }).click(); await page.getByRole('tab', { name: 'Page /a', exact: true }).waitFor();
    await select('chat-b'); assert.equal(await address().inputValue(), `${base}/b`);
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).focus(); await page.keyboard.press('Control+w');
    await select('chat-b'); assert.equal((await state()).tabs.length, 0, 'closing a chat closes its pages');
    await select('chat-a');
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').focus(); await page.keyboard.press('d');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('.thread-row[data-thread-id="chat-a"]').waitFor({ state: 'detached' });
    assert.equal((await state()).tabs.length, 0, 'deleted sessions lose their pages');
    await electron.evaluate(async ({ webContents }, url) => {
      const deadline = Date.now() + 4000;
      while (webContents.getAllWebContents().some(wc => /^\/(a|a-next|b)$/.test(wc.getURL().slice(url.length)))) {
        if (Date.now() > deadline) throw Error('Closed sessions still have native pages');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }, base);
  } catch (error) { console.error(nativeErrors); throw error; } finally {
    if (electron) await electron.close(); xvfb.kill(); await f.close(); await new Promise(resolve => site.close(resolve));
  }
});
