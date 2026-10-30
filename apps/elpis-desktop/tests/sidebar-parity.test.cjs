// The sidebar and start screen as in Claude's desktop app: a "+" on every project header that starts a chat in that
// project, a persistent colour control and active status on chat rows, a "Local" chip beside the project chip above the composer, and the account
// row at the bottom left with its menu. The exported UI against a scripted desktop bridge (tests/fake-desktop.cjs) and a
// synthetic bridge HTTP/SSE server: no engine, no provider. Screenshots go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore, oranges } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_PARITY_SHOTS;
async function eventually(check, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

const PROJECTS = [{ id: 'p-legal', name: 'legal', cwd: '/work/legal' }, { id: 'p-rag', name: 'rag-studio', cwd: '/work/rag' }, { id: 'p-empty', name: 'scratch', cwd: '/work/scratch' }];
const chat = (id, name, cwd, status = 'idle') => ({ id, name, preview: name, cwd, model: 'gpt-6-luna', modelProvider: 'openai', status: { type: status } });
const account = (auth = { state: 'signedIn', method: 'chatgpt', email: 'masih@example.com', plan: 'pro' }) => ({
  openai: { auth, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [],
});

async function fixture(run, { width = 1130, height = 660, colorScheme = 'light', signedIn = true } = {}) {
  const threads = [chat('t-run', 'Doctrine filters', '/work/legal', 'active'), chat('t-idle', 'Reread the statute', '/work/legal'), chat('t-bad', 'Broken import', '/work/legal', 'systemError'), chat('t-crypto', 'Crypto', '/work/rag')];
  const state = { providers: account(signedIn ? undefined : { state: 'signedOut' }), posts: [] };
  const clients = new Set();
  const emit = (method, params) => { for (const client of clients) client.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') state.posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true, cwd: '/work/home' });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/providers') return json(state.providers);
    if (url.pathname === '/api/providers/settings') return json({ version: 'p1', providers: [], managed: {}, write: { available: false } });
    if (url.pathname === '/api/providers/claude-accounts') return json({ activeId: '', accounts: [] });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads, nextCursor: null });
    const id = url.pathname.split('/')[3], thread = threads.find(item => item.id === id);
    if (thread && url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(projects => { if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects, selectedId: null })); }, PROJECTS);
    await page.addInitScript(fakeDesktop, { tabs: [] });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    const aside = page.locator('aside.sidebar');
    await aside.locator('.thread-row[data-thread-id="t-idle"]').first().waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const shoot = async name => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, aside, state, emit, shoot, threads });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}
const paint = (locator, property) => locator.evaluate((element, name) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fbfbfa'; context.fillRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(element)[name]; context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
}, property);
const same = (a, b) => a.join() === b.join();
const BASE = [251, 251, 250]; // what `paint` lays a transparent colour over: the light theme's page

test('every project header has a "+" that starts a new chat in that project', async () => {
  await fixture(async ({ page, aside, shoot }) => {
    const groups = aside.locator('.project-group');
    assert.equal(await groups.count(), 3);
    for (const name of ['legal', 'rag-studio', 'scratch']) {
      const plus = aside.getByRole('button', { name: `Start new chat in ${name}`, exact: true });
      assert.equal(await plus.isVisible(), true);
      await eventually(async () => assert.equal(await plus.evaluate(element => { let shown = 1; for (let node = element; node && node !== document.body; node = node.parentElement) shown *= Number(getComputedStyle(node).opacity); return shown; }), 1, `the "+" of ${name} shows without hovering`));
      assert.equal(await plus.evaluate(element => element.textContent.trim()), '', 'an icon, not a word');
    }
    // The "+" sits at the right end of its header, as in Claude, level with the project's name.
    const header = await aside.locator('.project-row').filter({ hasText: 'legal' }).boundingBox(), plus = await aside.getByRole('button', { name: 'Start new chat in legal', exact: true }).boundingBox();
    assert.ok(plus.x + plus.width <= header.x + header.width + 1 && plus.x + plus.width > header.x + header.width - 60, `the "+" is at the header's right end (${JSON.stringify([plus, header])})`);
    await shoot('sidebar-projects-light');
    // A real click on the "+" of rag-studio: a new chat, with that project chosen, and nothing else changed.
    await page.locator('.thread-row[data-thread-id="t-crypto"] .thread-link').first().click(); await aside.locator('.thread-row.active').first().waitFor();
    await aside.getByRole('button', { name: 'Start new chat in scratch', exact: true }).click();
    await eventually(async () => assert.equal(await page.locator('.empty-state h2').innerText(), 'What should we build in scratch?'));
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /scratch/);
    assert.equal(await aside.locator('.thread-row.active').count(), 0, 'no chat is shown as open: this is a new one');
  });
});

test('sidebar rows share one height, one icon edge and an arrowless thin scrollbar', async () => {
  await fixture(async ({ page }) => {
    const heights = await page.locator('.nav-list button, .section-label-row, .sidebar-group-row, .thread-row').evaluateAll(rows => [...new Set(rows.filter(row => row.getBoundingClientRect().height > 0).map(row => Math.round(row.getBoundingClientRect().height)))]);
    assert.deepEqual(heights, [34]);
    const nav = await page.locator('.nav-list button svg').first().boundingBox();
    const dot = await page.locator('[data-thread-id="t-run"] .thread-dot').boundingBox();
    assert.ok(Math.abs((nav.x + nav.width / 2) - (dot.x + dot.width / 2)) <= 1, 'navigation icons and root chat marks share one left edge');
    assert.equal(await page.locator('.thread-list').evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-button').display), 'none');
  });
});

test('every chat keeps its automatic status at the left', async () => {
  await fixture(async ({ page, aside, emit, shoot }) => {
    const row = id => aside.locator(`.thread-row[data-thread-id="${id}"]`).first();
    const dot = id => row(id).locator('.conversation-state-slot .thread-dot');
    for (const id of ['t-idle', 't-crypto']) assert.equal(await dot(id).count(), 1, `${id} retains its automatic idle status marker`);
    for (const id of ['t-idle', 't-crypto']) assert.equal(await row(id).locator('.conversation-status').count(), 0, `${id} has nothing to report: its idle ring is not a status`);
    assert.deepEqual(await Promise.all(['t-run', 't-bad'].map(id => dot(id).getAttribute('data-state'))), ['working', 'error']);
    assert.deepEqual(await Promise.all(['t-run', 't-bad'].map(id => dot(id).getAttribute('title'))), ['Working', 'Error']);
    const fill = async id => paint(dot(id), 'backgroundColor'), ring = async id => paint(dot(id), 'borderTopColor');
    const [run, idle, bad] = [await fill('t-run'), await fill('t-idle'), await fill('t-bad')];
    assert.ok(same(run, BASE), `a running chat's status is a ring, not a filled notification (${run})`);
    assert.ok(!same(await ring('t-run'), BASE), 'a working chat has a visible automatic ring');
    assert.equal(await dot('t-run').evaluate(element => getComputedStyle(element).animationName), 'none', 'a running status does not flash');
    assert.ok(same(idle, BASE), `a read idle chat keeps a hollow automatic marker (${idle})`);
    assert.ok(bad[0] > bad[1] + 60 && bad[0] > bad[2] + 60, `an error status is red (${bad})`);
    // Automatic activity retains the original left column.
    const boxes = await Promise.all(['t-run', 't-idle', 't-bad'].map(async id => ({ dot: await dot(id).boundingBox(), link: await row(id).locator('.thread-link').boundingBox() })));
    assert.ok(boxes.every(box => box.dot.width === boxes[0].dot.width && Math.abs(box.dot.x - boxes[0].dot.x) < 1), 'one size and one column');
    assert.ok(boxes.every(box => box.dot.x + box.dot.width <= box.link.x + 1), 'left of the title');
    assert.ok(boxes.every(box => box.dot.width >= 8), 'big enough to use');
    const running = await dot('t-run').boundingBox(), link = await row('t-run').locator('.thread-link').boundingBox();
    assert.ok(running.x + running.width <= link.x + 1, 'automatic activity remains before the conversation title');
    emit('turn/started', { threadId: 't-idle', turn: { id: 'turn-9' } });
    await eventually(async () => assert.equal(await dot('t-idle').getAttribute('data-state'), 'working'));
    assert.ok(same(await fill('t-idle'), BASE), 'still a ring while it works');
    emit('turn/completed', { threadId: 't-idle', turn: { id: 'turn-9', status: 'completed' } });
    await eventually(async () => assert.equal(await dot('t-idle').getAttribute('data-state'), 'unread'));
    assert.ok(!same(await fill('t-idle'), BASE), 'filled once it finished unseen, like a notification');
    await row('t-idle').locator('.thread-link').click();
    await eventually(async () => assert.equal(await dot('t-idle').getAttribute('data-state'), 'idle'));
    assert.ok(same(await fill('t-idle'), BASE), 'reading clears the completion fill without removing the automatic marker');
    await shoot('sidebar-dots-light');
  });
});

test('start screen: a Local chip beside the project chip says where the chat works, and says what is not offered', async () => {
  await fixture(async ({ page, aside, shoot }) => {
    await aside.getByRole('button', { name: 'Start new chat in legal', exact: true }).click();
    const tray = page.locator('.composer-tray'), local = tray.getByRole('button', { name: 'Where this chat works', exact: true }), project = tray.getByRole('button', { name: 'Choose project', exact: true });
    await local.waitFor(); await project.waitFor();
    assert.equal((await local.innerText()).trim(), 'Local');
    const [a, b] = [await local.boundingBox(), await project.boundingBox()];
    assert.ok(a.x + a.width <= b.x + 1, 'Local is left of the project chip'); assert.ok(Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) < 1.5, 'on one line'); assert.equal(a.height, b.height, 'one chip style');
    assert.equal(await local.evaluate(element => getComputedStyle(element).fontSize), await project.evaluate(element => getComputedStyle(element).fontSize), 'one text size');
    await local.click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts().then(items => items.map(text => text.replace(/\s+/g, ' ').trim())), ['Local /work/legal', 'Worktree Needs a Git repository with a commit'], 'the local folder and the unavailable worktree choice');
    assert.match(await menu.innerText(), /worktree/i, 'and the menu says what is not offered');
    assert.equal(await menu.getByRole('menuitem', { name: /worktree/i }).getAttribute('aria-disabled'), 'true', 'worktrees require a committed Git repository');
    assert.equal(await menu.getByRole('menuitem').first().locator('svg[aria-label="Current"]').count(), 1, 'Local is marked as the choice');
    await shoot('start-environment-light');
    await page.keyboard.press('Escape');
    // With no project the chat works in the folder Elpis started in.
    await project.click(); await page.getByRole('menuitem', { name: /Don.t work in a project/ }).click();
    await local.click(); await page.getByRole('menu').waitFor();
    assert.match(await page.getByRole('menu').innerText(), /default folder/i, 'with no project, the folder Elpis starts in');
  });
});

test('account row: bottom left, the signed-in account and plan, only shown; the theme button sits beside Settings', async () => {
  await fixture(async ({ page, aside, shoot }) => {
    const row = aside.getByRole('group', { name: /masih@example\.com/ });
    await row.waitFor();
    assert.equal(await row.locator('.account-name').innerText(), 'masih', 'the name before the @, as Claude shows a first name'); assert.equal(await row.locator('.account-plan').innerText(), 'Pro');
    assert.equal(await row.getAttribute('aria-label'), 'Account: masih@example.com, Pro plan', 'the full email is its label');
    assert.equal(await row.evaluate(element => element.tagName), 'DIV', 'the name is not a button');
    const box = await row.boundingBox(), side = await aside.boundingBox();
    assert.ok(box.x < side.x + 24 && box.y + box.height > 560, `bottom left of the sidebar (${JSON.stringify(box)})`);
    assert.ok(box.height >= 34, 'a full-size row');
    const labels = await row.evaluate(element => [...element.querySelectorAll('.account-name, .account-plan')].map(node => node.scrollWidth <= node.clientWidth + 1));
    assert.deepEqual(labels, [true, true], 'the account and the plan are not cut');
    await row.click();
    assert.equal(await page.getByRole('menu').count(), 0, 'clicking the name opens nothing');
    const theme = aside.getByRole('button', { name: 'Use dark theme', exact: true }), settings = aside.getByRole('button', { name: 'Settings', exact: true });
    const [themeBox, settingsBox] = [await theme.boundingBox(), await settings.boundingBox()];
    assert.ok(themeBox.x < settingsBox.x && Math.abs(themeBox.y - settingsBox.y) < 4 && settingsBox.x - (themeBox.x + themeBox.width) < 12, 'the theme button is right beside Settings');
    await shoot('account-row-light');
    await theme.click();
    await page.locator('.app-shell.dark').waitFor();
    await aside.getByRole('button', { name: 'Use light theme', exact: true }).waitFor();
    await shoot('account-row-dark');
    await aside.getByRole('button', { name: 'Use light theme', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.app-shell.dark'));
    await settings.click();
    await page.getByRole('button', { name: 'Back to app', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'General', exact: true }).isVisible(), true, 'Settings opens on General');
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    assert.deepEqual(await oranges(page), [], 'light theme, account row: no orange');
  });
});

test('account row without a signed-in account says so', async () => {
  await fixture(async ({ page, aside }) => {
    const row = aside.locator('.account-row');
    await eventually(async () => assert.equal(await row.locator('.account-name').innerText(), 'Not signed in'));
    assert.equal(await row.locator('.account-plan').count(), 0);
  }, { signedIn: false });
});
