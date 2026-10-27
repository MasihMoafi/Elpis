const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');
const { rowAction, threadMenuItem } = require('./controls.cjs');

test('projects: explicit membership, drag, menu moves, persistence, and unscoped new chats', async () => {
  const root = process.env.ELPIS_RENDERER_OUT || path.resolve(__dirname, '../out');
  const projects = [{ id: 'one', name: 'First project', cwd: '/tmp/project-one' }, { id: 'two', name: 'Second project', cwd: '/tmp/project-two' }];
  const threads = ['alpha', 'bravo'].map(id => ({ id, name: id === 'alpha' ? 'Alpha' : 'Bravo', cwd: projects[0].cwd, model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } }));
  threads.push({ ...threads[0], id: 'alpha-worker', name: 'Alpha worker', parentThreadId: 'alpha', agentNickname: 'Alpha worker' });
  const creates = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const thread = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') {
      if (req.method === 'POST') { const body = JSON.parse(raw); creates.push(body); const created = { ...threads[0], id: `created-${creates.length}`, name: `Created ${creates.length}`, cwd: body.cwd ?? '/tmp/project-one' }; threads.push(created); return json({ thread: created }); }
      return json({ data: threads, nextCursor: null });
    }
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (url.pathname.endsWith('/turns')) return json({ turn: { id: 'fixture-turn' } });
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(await fs.readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(fakeDesktop);
    await page.addInitScript(projects => { if (!localStorage.getItem('project-fixture-initialized')) { localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects, selectedId: 'one' })); localStorage.setItem('project-fixture-initialized', 'yes'); } }, projects);
    const sidebar = page.locator('aside.sidebar');
    const group = name => sidebar.locator('.project-group').filter({ has: page.getByRole('button', { name, exact: true, includeHidden: true }) });
    const first = group('First project'), second = group('Second project');
    const row = id => sidebar.locator(`.thread-row[data-thread-id="${id}"]`).first();
    const waitForCount = async (locator, count) => { await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector: locator, count }); };
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await row('alpha').waitFor();
    assert.equal(await first.locator('.thread-row').count(), 0, 'matching cwd must not assign unrelated chats to a project');
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /Work in a project/, 'startup must not inherit the last project');

    await first.getByRole('button', { name: 'First project', exact: true }).click();
    await row('alpha').dragTo(first.locator('.project-row'));
    await first.locator('.thread-row[data-thread-id="alpha"]').waitFor();
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'a project chat must not also appear in global Recents');
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha-worker"]').count(), 0, 'children of a project chat must not become global root chats');
    await rowAction(page, row('alpha'), 'Alpha', 'Pin');
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'pinning a project chat must not duplicate it in the global list');
    await rowAction(page, row('alpha'), 'Alpha', 'Unpin');
    await page.getByLabel('Search conversations', { exact: true }).fill('Alpha');
    await row('alpha').waitFor();
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'global search must still find a project chat');
    await page.getByLabel('Search conversations', { exact: true }).fill('');
    await first.locator('.thread-row[data-thread-id="alpha"]').waitFor();
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'clearing search must restore project-only placement');
    if (process.env.ELPIS_PROJECT_ISOLATION_SCREENSHOT) await page.screenshot({ path: process.env.ELPIS_PROJECT_ISOLATION_SCREENSHOT });
    assert.equal(await first.locator('.thread-row[data-thread-id="bravo"]').count(), 0);
    assert.equal(await second.locator('.thread-row').count(), 0);
    await row('alpha').getByRole('button', { name: 'Actions for Alpha', exact: true }).click();
    await (await threadMenuItem(page, 'Move to project…')).click();
    const picker = page.getByRole('alertdialog', { name: 'Move chat to project' });
    await page.evaluate(() => { window.elpisDesktop.storage.saveItem = async () => { throw Error('Project membership save failed'); }; });
    await picker.getByRole('button', { name: 'Second project', exact: true }).click();
    await picker.getByRole('alert').filter({ hasText: 'Project membership save failed' }).waitFor();
    assert.equal(await first.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'failed saves retain the previous membership');
    assert.equal(await second.locator('.thread-row').count(), 0);
    await page.evaluate(() => { delete window.elpisDesktop.storage.saveItem; });
    await picker.getByRole('button', { name: 'Second project', exact: true }).click();
    await second.locator('.thread-row[data-thread-id="alpha"]').waitFor();
    assert.equal(await first.locator('.thread-row').count(), 0, 'moving removes the former membership');
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'moving between projects must not leave a global copy');
    await page.reload(); await second.locator('.thread-row[data-thread-id="alpha"]').waitFor();
    assert.equal(await first.locator('.thread-row[data-thread-id="bravo"]').count(), 0, 'refresh must not reassign chats by cwd');
    assert.equal(await sidebar.locator('.thread-row[data-thread-id="alpha"]').count(), 1, 'reload must preserve exclusive placement');

    await row('alpha').getByRole('button', { name: 'Actions for Alpha', exact: true }).click();
    await (await threadMenuItem(page, 'Move to project…')).click();
    await picker.getByRole('button', { name: 'No project', exact: true }).click();
    await waitForCount('.project-group .thread-row[data-thread-id="alpha"]', 0);
    await row('alpha').dragTo(second.locator('.project-row'));
    await second.locator('.thread-row[data-thread-id="alpha"]').waitFor();
    await row('alpha').dragTo(sidebar.getByRole('region', { name: 'Recents', exact: true }));
    await waitForCount('.project-group .thread-row[data-thread-id="alpha"]', 0);
    const invalid = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('text/plain', 'bravo'); return data; });
    await first.dispatchEvent('dragover', { dataTransfer: invalid }); await first.dispatchEvent('drop', { dataTransfer: invalid });
    assert.equal(await first.locator('.thread-row').count(), 0, 'unrelated drags must not assign chats');
    await invalid.dispose();
    await page.reload(); await row('alpha').waitFor();
    assert.equal(await first.locator('.thread-row').count(), 0, 'removing membership persists');

    await row('alpha').locator('.thread-link').click();
    await page.getByRole('heading', { name: 'This conversation has no messages yet.', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start new chat in Second project', exact: true }).click();
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /Second project/);
    assert.equal(await page.getByRole('heading', { name: 'This conversation has no messages yet.', exact: true }).count(), 0, 'switching projects must clear the previous conversation');

    await page.getByRole('button', { name: 'Start new chat in First project', exact: true }).click();
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /First project/);
    await page.getByRole('button', { name: 'New chat tab', exact: true }).click();
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /Work in a project/, 'new tabs do not inherit a project');
    await page.getByRole('button', { name: 'Start new chat in First project', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /Work in a project/, 'global New chat clears the project');
    await page.getByLabel('Message Elpis', { exact: true }).fill('Unscoped fixture');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await row('created-1').waitFor(); assert.equal(creates[0].cwd, undefined);
    assert.equal(await first.locator('.thread-row').count(), 0, 'server default cwd must not assign a global new chat');
    await page.getByRole('button', { name: 'Start new chat in First project', exact: true }).click();
    await page.getByLabel('Message Elpis', { exact: true }).fill('Project fixture');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await first.locator('.thread-row[data-thread-id="created-2"]').waitFor();
    assert.equal(creates[1].cwd, projects[0].cwd);
    await page.reload(); await first.locator('.thread-row[data-thread-id="created-2"]').waitFor();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /Work in a project/);
    if (process.env.ELPIS_PROJECT_SCREENSHOT) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => localStorage.setItem('elpis-theme', theme), theme);
        await page.reload(); await row('alpha').waitFor();
        await page.getByRole('status', { name: 'Elpis is starting', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
        await row('alpha').getByRole('button', { name: 'Actions for Alpha', exact: true }).click();
        await (await threadMenuItem(page, 'Move to project…')).click();
        await picker.waitFor();
        await page.screenshot({ path: process.env.ELPIS_PROJECT_SCREENSHOT.replace('.png', `-${theme}.png`) });
        await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
