// Archived chats in bulk: Select all (across pages), then Delete or Unarchive the selection, with one confirmation.
// Synthetic HTTP/SSE; no engine or provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { leaveSettings } = require('./controls.cjs');
const root = path.resolve(__dirname, '../out');

test('archived chats: select all across pages, delete all after one confirmation, unarchive a selection', async () => {
  const threads = Array.from({ length: 130 }, (_, index) => ({ id: `old-${index + 1}`, name: `Old chat ${index + 1}`, preview: '', cwd: '/tmp/elpis-archive-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } }));
  const archived = new Set(threads.map(thread => thread.id)), deleted = [], restored = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); for await (const _ of req) { /* drain */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const id = url.pathname.split('/')[3], thread = threads.find(item => item.id === id);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') {
      if (url.searchParams.get('archived') !== 'true' || url.searchParams.get('ancestorThreadId')) return json({ data: [], nextCursor: null });
      // The cursor names the last chat returned, as Elpis's does, so changes between pages don't shift them.
      const after = url.searchParams.get('cursor'), rows = threads.filter(item => archived.has(item.id) && (!after || threads.indexOf(item) > threads.findIndex(t => t.id === after))), data = rows.slice(0, 100);
      return json({ data, nextCursor: rows.length > 100 ? data.at(-1).id : null });
    }
    if (url.pathname.endsWith('/delete')) { deleted.push(id); archived.delete(id); return json({ deleted: true, alsoDeleted: [] }); }
    if (url.pathname.endsWith('/unarchive')) { restored.push(id); archived.delete(id); return json({ thread }); }
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Confirmation turned off by the person: bulk delete still asks once.
    await page.addInitScript(() => localStorage.setItem('elpis-preferences-v1', JSON.stringify({ confirmDeleteChats: false })));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Archived chats', exact: true }).click();
    const list = page.getByLabel('Archived conversations'), dialog = page.getByRole('alertdialog');
    await list.getByText('Old chat 1', { exact: true }).waitFor();

    // Unarchive two picked chats.
    await list.getByRole('checkbox', { name: 'Select Old chat 1', exact: true }).check();
    await list.getByRole('checkbox', { name: 'Select Old chat 2', exact: true }).check();
    await list.getByRole('button', { name: 'Unarchive 2', exact: true }).click();
    await list.getByText('Old chat 1', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(restored.sort(), ['old-1', 'old-2']);

    // Select all covers the chats not loaded yet; Delete asks once, then deletes them all.
    await list.getByRole('checkbox', { name: 'Select all', exact: true }).check();
    await list.getByRole('button', { name: 'Delete 128', exact: true }).click();
    await dialog.getByText('Delete 128 chats?').waitFor();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await list.getByText('No archived conversations').waitFor({ timeout: 20000 });
    assert.equal(deleted.length, 128);
    assert.deepEqual(errors, []);
    await leaveSettings(page);
  } finally { await browser.close(); server.close(); }
});
