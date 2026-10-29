// The agent and the person each have their own browser tab, as in Chrome beside an agent: the production window
// factory on a private Xvfb display, the agent's tools through the real socket route (callBrowser), and the
// person's clicks and keys as X input (xdotool), so keyboard focus is real. Synthetic local pages; no engine or model.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture } = require('./parity-fixture.cjs');

let f, site, base, xvfb, display, electron, page, agent, userTab, agentTab, nativeErrors = '';
const state = () => page.evaluate(() => window.elpisDesktop.browser.command('state'));
const pageAt = url => electron.context().pages().find(item => item.url() === url);
const x = (...args) => promisify(execFile)('xdotool', args, { env: { ...process.env, DISPLAY: display } });
// A person clicks the centre of an element in the page shown on screen.
async function click(native, selector) {
  const rect = await native.evaluate(selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }, selector);
  const origin = await electron.evaluate(({ BrowserWindow }, url) => {
    const host = BrowserWindow.getAllWindows()[0], content = host.getContentBounds();
    const view = host.contentView.children.find(child => child.webContents?.getURL() === url);
    if (!view?.getVisible()) throw Error(`${url} is not on screen`);
    const bounds = view.getBounds(); return { x: content.x + bounds.x, y: content.y + bounds.y };
  }, native.url());
  await x('mousemove', '--sync', String(Math.round(origin.x + rect.x)), String(Math.round(origin.y + rect.y)), 'click', '1');
}

before(async () => {
  const profiles = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(profiles, { recursive: true });
  const root = await fs.mkdtemp(path.join(profiles, 'agent-tabs-'));
  f = await fixture({ desktop: false });
  site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Page ${req.url}</title><h1>Page ${req.url}</h1><input aria-label="Note" style="width:300px"><button onclick="const h=document.querySelector('h1');h.textContent=document.querySelector('input').value;h.dataset.saved='true'">Save</button>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  display = await new Promise((resolve, reject) => { xvfb.once('error', reject); xvfb.stdio[3].once('data', value => resolve(`:${String(value).trim()}`)); });
  electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'session-windows-electron.cjs')],
    env: { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', ELECTRON_OZONE_PLATFORM_HINT: 'x11', HOME: root, ELPIS_HOME: root, SESSION_WINDOW_PROFILE: path.join(root, 'profile'), SESSION_WINDOW_URL: f.page.url(), SESSION_BROWSER_TOOLS: '1' } });
  electron.process().stderr.on('data', data => { nativeErrors = (nativeErrors + data).slice(-6000); });
  page = await electron.firstWindow(); page.setDefaultTimeout(10000);
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click(); await page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
  const { callBrowser } = await import('../bridge/browser-mcp.mjs');
  const socket = await electron.evaluate(() => ({ path: global.browserSocket.path, capability: global.browserSocket.scope('chat-a') }));
  agent = (name, args = {}) => callBrowser(socket.path, name, args, socket.capability);
  // The person opens his own tab from the side panel's + menu and the address bar.
  const show = page.getByRole('button', { name: 'Show side panel', exact: true }); if (await show.count()) await show.click();
  await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Browser tab', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'Search or enter a URL', exact: true });
  await address.fill(`${base}/mine`); await address.press('Enter');
  await page.getByRole('tab', { name: 'Page /mine', exact: true }).waitFor();
  userTab = (await state()).activeId;
  await pageAt(`${base}/mine`).locator('input').waitFor();
});

after(async () => {
  if (electron) await electron.close(); xvfb?.kill(); await f?.close(); await new Promise(resolve => site ? site.close(resolve) : resolve());
});

test('the agent fills and saves a form in its own tab while the person types in his, and each text lands in its own tab', async () => {
  try {
    const mine = pageAt(`${base}/mine`);
    await click(mine, 'input');
    // He types slowly enough that the agent opens, fills and saves its page in the middle of his typing.
    const typing = x('type', '--delay', '45', 'typed by Masih while the agent works');
    agentTab = (await agent('browser_open', { url: `${base}/agent` })).tabId;
    await agent('browser_wait', { tabId: agentTab, selector: 'input' });
    await agent('browser_type', { tabId: agentTab, selector: 'input', text: 'typed by the agent' });
    await agent('browser_click', { tabId: agentTab, selector: 'button' });
    await agent('browser_wait', { tabId: agentTab, selector: 'h1[data-saved]' });
    await typing;
    // The agent types again with clear (Control+A) while he keeps typing.
    const more = x('type', '--delay', '45', ', and more');
    await agent('browser_type', { tabId: agentTab, selector: 'input', text: 'agent again' });
    await more;
    assert.equal(await mine.locator('input').inputValue(), 'typed by Masih while the agent works, and more', 'his keys stay in his tab');
    assert.equal(await mine.locator('h1').textContent(), 'Page /mine');
    const theirs = pageAt(`${base}/agent`);
    assert.equal(await theirs.locator('input').inputValue(), 'agent again', 'the agent typed only into its tab');
    assert.equal(await theirs.locator('h1').textContent(), 'typed by the agent', 'the agent clicked Save in its tab');
    const now = await state();
    assert.equal(now.activeId, userTab, 'his tab stays the shown tab');
    assert.deepEqual(now.tabs.map(tab => tab.id).sort(), [userTab, agentTab].sort());
    assert.equal(now.agent.tabId, agentTab, 'the panel names the agent tab');
    assert.equal(await page.getByRole('textbox', { name: 'Search or enter a URL', exact: true }).inputValue(), `${base}/mine`);
  } catch (error) { console.error(nativeErrors); throw error; }
});

test('the agent never navigates, types, clicks, presses or scrolls in the person’s tab, and its key chords stay in its own tab', async () => {
  try {
    const mine = pageAt(`${base}/mine`), value = await mine.locator('input').inputValue();
    for (const [name, args] of [['browser_navigate', { url: `${base}/hijacked` }], ['browser_navigate', { action: 'reload' }], ['browser_type', { selector: 'input', text: 'INTRUDER' }],
      ['browser_click', { selector: 'button' }], ['browser_click', { x: 20, y: 20 }], ['browser_press', { key: 'Enter' }], ['browser_scroll', { deltaY: 300 }]]) {
      await assert.rejects(agent(name, { tabId: userTab, ...args }), /person’s tab|your own tab/, `${name} must not act in his tab`);
    }
    // Browser chords the agent presses in its own tab do not close or switch his tab.
    for (const key of ['Control+W', 'Control+Tab', 'Control+T', 'Control+L']) await agent('browser_press', { tabId: agentTab, key });
    await agent('browser_snapshot', { tabId: agentTab });
    const now = await state();
    assert.equal(now.activeId, userTab); assert.deepEqual(now.tabs.map(tab => tab.id).sort(), [userTab, agentTab].sort());
    assert.equal(mine.url(), `${base}/mine`); assert.equal(await mine.locator('input').inputValue(), value);
    assert.equal(await mine.locator('h1').getAttribute('data-saved'), null);
    // Reading his page stays allowed: he can ask the agent to look at it.
    assert.match((await agent('browser_snapshot', { tabId: userTab })).text, /Page \/mine/);
    assert.equal((await agent('browser_tabs')).tabs.find(tab => tab.id === userTab).agent, false);
  } catch (error) { console.error(nativeErrors); throw error; }
});
