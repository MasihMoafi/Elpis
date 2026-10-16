// The sidebar as in the ChatGPT and Claude apps: add a project folder, close and reopen the sidebar, D to delete,
// arrow keys, Ctrl/Shift selection and the row's hover actions. Synthetic HTTP/SSE; no engine or provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { leaveSettings } = require('./controls.cjs');
const root = path.resolve(__dirname, '../out');
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}

test('sidebar: projects, toggle, D to delete, arrows, Ctrl/Shift selection, hover actions', async () => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const threads = names.map(name => ({ id: name.toLowerCase(), name, preview: name, cwd: '/tmp/elpis-sidebar-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } }));
  const deleted = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); for await (const _ of req) { /* drain */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const id = url.pathname.split('/')[3], thread = threads.find(item => item.id === id);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads.filter(item => !deleted.includes(item.id)), nextCursor: null });
    if (url.pathname.endsWith('/delete')) { deleted.push(id); return json({ deleted: true, alsoDeleted: [] }); }
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // The desktop bridge's native folder chooser; each call returns the next queued folder (null = cancelled).
    await page.addInitScript(() => { window.__folders = []; window.elpisDesktop = { chooseFolder: async () => window.__folders.shift() ?? null }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    const aside = page.locator('aside.sidebar');
    const row = id => page.locator(`.thread-list .thread-row[data-thread-id="${id}"]`).first();
    const link = id => row(id).locator('.thread-link');
    const focusedRow = () => page.evaluate(() => document.activeElement?.closest('.thread-row')?.getAttribute('data-thread-id') ?? null);
    const selectedRows = async () => [...new Set(await page.locator('.thread-list .thread-row.selected').evaluateAll(rows => rows.map(item => item.getAttribute('data-thread-id'))))];
    const heading = page.locator('.workspace-header h1');
    const dialog = page.getByRole('alertdialog');
    await link('alpha').waitFor();

    // 1. One click on "Add new project" opens the native chooser; the folder becomes a project named after it, selected.
    const add = aside.getByRole('button', { name: 'Add new project', exact: true });
    assert.notEqual(await add.evaluate(element => getComputedStyle(element).opacity), '0', '"Add new project" is visible without hovering');
    await page.evaluate(() => window.__folders.push(null)); await add.click();
    await page.waitForTimeout(150); assert.equal(await aside.locator('.project-row').count(), 0, 'cancelling the chooser adds nothing');
    await page.evaluate(() => window.__folders.push('/tmp/work/elpis-sidebar-project')); await add.click();
    await aside.locator('.project-row').filter({ hasText: 'elpis-sidebar-project' }).waitFor();
    await eventually(async () => assert.equal(await page.locator('.empty-state h2').innerText(), 'What should we build in elpis-sidebar-project?'));
    assert.equal(await dialog.count(), 0, 'no name dialog: the folder name is the project name');
    await page.evaluate(() => window.__folders.push('/tmp/work/second-project'));
    await page.getByRole('button', { name: 'Choose project', exact: true }).click(); await page.getByRole('menuitem', { name: 'New project…', exact: true }).click();
    await aside.locator('.project-row').filter({ hasText: 'second-project' }).waitFor();
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /second-project/);
    await page.getByRole('button', { name: 'Project actions for second-project', exact: true }).click(); await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click();
    await page.getByLabel('Project name').fill('Renamed project'); await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await aside.locator('.project-row').filter({ hasText: 'Renamed project' }).waitFor();

    // 2. The sidebar toggle at the top left hides the sidebar and stays reachable; Ctrl+B does the same.
    const close = page.getByRole('button', { name: 'Close sidebar', exact: true }), open = page.getByRole('button', { name: 'Open sidebar', exact: true });
    const box = await close.boundingBox(); assert.ok(box && box.x < 80 && box.y < 60, `the toggle sits at the top left (${JSON.stringify(box)})`);
    await close.click(); await aside.waitFor({ state: 'hidden' });
    const reopen = await open.boundingBox(); assert.ok(reopen && reopen.x < 80 && reopen.y < 60, `the reopen button sits at the top left (${JSON.stringify(reopen)})`);
    await open.click(); await aside.waitFor({ state: 'visible' });
    await page.keyboard.press('Control+b'); await aside.waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+b'); await aside.waitFor({ state: 'visible' });

    // 3. Row hover shows only Pin and Archive (and the "…" menu); showing agents is a worded menu item.
    await row('alpha').hover();
    assert.deepEqual(await row('alpha').getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent.trim())), ['Alpha', 'Pin Alpha', 'Archive Alpha', 'Actions for Alpha']);
    await row('alpha').getByRole('button', { name: 'Actions for Alpha', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Show agents', exact: true }).waitFor(); await page.keyboard.press('Escape');

    // 4. D right after clicking a row asks to delete it, exactly like the menu's Delete; typing D in the composer does not.
    await link('bravo').click(); await eventually(async () => assert.equal(await heading.innerText(), 'Bravo'));
    assert.equal(await focusedRow(), 'bravo', 'clicking a row focuses it');
    await page.keyboard.press('d');
    await dialog.getByText('Delete “Bravo”?').waitFor();
    const skip = dialog.getByRole('checkbox', { name: 'Don’t show me this again' }); assert.equal(await skip.isChecked(), false);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await row('bravo').waitFor({ state: 'detached' }); assert.deepEqual(deleted, ['bravo']);
    await page.getByLabel('Message Elpis').fill('add a d'); assert.equal(await dialog.count(), 0, 'D in the composer types');

    // 5. Arrow keys move between chats and open them.
    await link('alpha').click(); await eventually(async () => assert.equal(await heading.innerText(), 'Alpha'));
    await page.keyboard.press('ArrowDown'); await eventually(async () => assert.equal(await heading.innerText(), 'Charlie')); assert.equal(await focusedRow(), 'charlie');
    await page.keyboard.press('ArrowDown'); await eventually(async () => assert.equal(await heading.innerText(), 'Delta'));
    await page.keyboard.press('ArrowUp'); await eventually(async () => assert.equal(await heading.innerText(), 'Charlie')); assert.equal(await focusedRow(), 'charlie');

    // 6. Ctrl+click adds to the selection, Escape clears it, Shift+click selects a range; D deletes them all after one confirmation.
    await link('alpha').click();
    await link('delta').click({ modifiers: ['Control'] });
    assert.deepEqual(await selectedRows(), ['alpha', 'delta']);
    await page.keyboard.press('Escape'); assert.deepEqual(await selectedRows(), []);
    await link('alpha').click(); await link('delta').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selectedRows(), ['alpha', 'charlie', 'delta']);
    await page.keyboard.press('d');
    await dialog.getByText('Delete 3 chats?').waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(deleted, ['bravo'], 'Cancel deletes nothing');
    // Delete in a selected row's menu acts on the whole selection.
    await row('charlie').hover(); await row('charlie').getByRole('button', { name: 'Actions for Charlie', exact: true }).click(); await page.getByRole('menuitem', { name: /^Delete/ }).click();
    await dialog.getByText('Delete 3 chats?').waitFor();
    await dialog.getByRole('checkbox', { name: 'Don’t show me this again' }).check();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await eventually(async () => assert.deepEqual([...deleted].sort(), ['alpha', 'bravo', 'charlie', 'delta']));
    await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(await selectedRows(), []);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-preferences-v1')).confirmDeleteChats), false);

    // 7. With confirmation off, D deletes at once; Settings → General turns it back on.
    await link('echo').click(); await eventually(async () => assert.equal(await heading.innerText(), 'Echo'));
    await page.keyboard.press('d');
    await eventually(async () => assert.ok(deleted.includes('echo'))); assert.equal(await dialog.count(), 0, 'no confirmation once turned off');
    await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
    const confirm = page.getByRole('switch', { name: 'Confirm before deleting chats', exact: true });
    assert.equal(await confirm.getAttribute('aria-checked'), 'false'); await confirm.click();
    await eventually(async () => assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-preferences-v1')).confirmDeleteChats), true));
    await leaveSettings(page);
    await link('foxtrot').click(); await page.keyboard.press('d'); await dialog.getByText('Delete “Foxtrot”?').waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
