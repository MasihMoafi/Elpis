// The chat's context ring and its Context Ledger breakdown (hover, click/Enter pin, Escape, /context), against a
// local fixture of the bridge's GET /api/threads/:id/context. No runtime or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

// The bridge's ledger for 50k measured tokens of a 200k window (bridge/bridge.test.mjs reconciles these numbers).
const categories = [['userMessages', 'User messages', 980], ['agentMessages', 'Agent messages', 2941], ['toolCalls', 'Tool calls', 490], ['toolResults', 'Tool results', 26471],
  ['systemInstructions', 'System instructions', 7843], ['developerMessages', 'Developer messages', 1471], ['toolDefinitions', 'Tool definitions + schema', 9804]];
const ledgers = {
  measured: { used: 50000, window: 200000, categories: categories.map(([id, label, tokens]) => ({ id, label, tokens })) },
  fresh: { used: null, window: null, categories: [] },
  // An old chat: the bridge restored its last recorded usage from the rollout; category shares come with the next request.
  older: { used: 12000, window: 200000, categories: [] },
};

test('the context ring shows the ledger breakdown on hover, pins on click or Enter, closes on Escape, and opens for /context', async () => {
  const thread = (id, name) => ({ id, name, cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
  const threads = [thread('measured', 'Ledger chat'), thread('fresh', 'Fresh chat'), thread('older', 'Older chat')];
  const streams = new Set(), saved = [];
  // The ledger switches, as GET/POST /api/context/switches report and write them (bridge/client.mjs).
  const switches = { version: 'v1', write: { available: true }, smartPrune: false, subagents: true, rag: true };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }], managed: {}, write: { available: true },
      memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, smartPrune: { enabled: null, explicitOverride: { reason: 'Fixture' } } });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : threads, nextCursor: null });
    if (url.pathname === '/api/context/switches') {
      if (req.method === 'POST') { const body = JSON.parse(raw); saved.push(body); const { version, ...changes } = body; Object.assign(switches, changes, { version: `v${saved.length + 1}` }); }
      return json(switches);
    }
    const context = url.pathname.match(/^\/api\/threads\/([^/]+)\/context$/);
    if (context) return json({ threadId: context[1], tokenUsage: null, smartPrune: null, ledger: ledgers[context[1]] });
    const read = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (read) return json({ thread: threads.find(item => item.id === read[1]), data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const shots = process.env.ELPIS_CONTEXT_SHOTS, shot = async (name, locator) => { if (shots) { await fs.mkdir(shots, { recursive: true }); await (locator ?? page).screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    const ring = page.getByRole('button', { name: 'Context window: 25% used', exact: true });
    const popup = page.getByRole('dialog', { name: 'Context window usage', exact: true });
    const away = () => page.mouse.move(5, 5);
    await ring.waitFor();
    const [ringBox, modelBox] = [await ring.boundingBox(), await page.getByRole('combobox', { name: 'Model', exact: true }).boundingBox()];
    assert.ok(Math.abs(ringBox.y + ringBox.height / 2 - (modelBox.y + modelBox.height / 2)) <= 0.5 && ringBox.height === modelBox.height, `the ring shares the composer controls' height and centre line (${JSON.stringify([ringBox, modelBox])})`);
    assert.equal(await page.getByRole('button', { name: 'Context', exact: true }).count(), 0, 'the header Context button is gone; the ring and /context open the breakdown');

    // Hover shows the breakdown; leaving hides it.
    await ring.hover(); await popup.waitFor();
    assert.equal(await popup.locator('.context-ledger-head > span').nth(1).textContent(), '50k of 200k used (25%)', 'the measured total carries no ≈');
    assert.deepEqual(await popup.locator('.context-ledger-row-label').allInnerTexts(), [...categories.map(([, label]) => label), 'Free capacity'], 'the TUI ledger\'s category names, in its order');
    assert.equal((await popup.locator('.context-ledger-row').filter({ hasText: 'Tool results' }).innerText()).replace(/\s+/g, ' ').trim(), 'Tool results ≈26.5k · 13.2%');
    assert.match(await popup.innerText(), /Measured total · estimated category shares/i, 'estimates are labelled as estimates');
    // Segments are proportional to the real numbers, on a full-window scale.
    const bar = await popup.locator('.context-bar').boundingBox();
    for (const [id, , tokens] of categories) {
      const segment = await popup.locator(`.context-bar-segment[data-category="${id}"]`).boundingBox();
      assert.ok(Math.abs(segment.width - bar.width * tokens / 200000) < 1, `${id} is ${tokens} of 200000 wide (got ${segment.width} of ${bar.width})`);
    }
    await shot('ring-hover-light');
    await away(); await popup.waitFor({ state: 'hidden' });

    // Click pins it: it stays after the pointer leaves, above the message box and level with the ring's right edge.
    await ring.click(); await popup.waitFor(); await away(); await page.waitForTimeout(500);
    assert.equal(await popup.isVisible(), true, 'a click pins the breakdown open');
    const [pinned, composer, anchor] = [await popup.boundingBox(), await page.locator('form.composer').boundingBox(), await ring.boundingBox()];
    assert.ok(pinned.y + pinned.height <= composer.y, `the pinned breakdown sits above the message box (${pinned.y + pinned.height} vs ${composer.y})`);
    assert.ok(Math.abs(pinned.x + pinned.width - (anchor.x + anchor.width)) <= 1, 'its right edge is the ring\'s right edge');
    // The ledger's switches, named as in the TUI, read and written through the bridge's switch keys.
    const smartPrune = popup.getByRole('switch', { name: 'Smart Prune', exact: true }), subagents = popup.getByRole('switch', { name: 'Subagents', exact: true }), rag = popup.getByRole('switch', { name: 'RAG', exact: true });
    await smartPrune.waitFor();
    assert.deepEqual([await smartPrune.isChecked(), await subagents.isChecked(), await rag.isChecked()], [false, true, true]);
    assert.match(await popup.innerText(), /Tool results pass through unchanged/); assert.match(await popup.innerText(), /May delegate to other agents/);
    await smartPrune.click(); await popup.getByText('Before first main-model send · sent history stays stable', { exact: true }).waitFor();
    await subagents.click(); await popup.getByText('All work stays in this thread', { exact: true }).waitFor();
    assert.deepEqual(saved, [{ version: 'v1', smartPrune: true }, { version: 'v2', subagents: false }], 'each switch writes only its own key, against the latest version');
    assert.deepEqual([await smartPrune.isChecked(), await subagents.isChecked()], [true, false]);
    await shot('ring-pinned-light');
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    // A second click on a pinned ring closes it.
    await ring.click(); await popup.waitFor(); await ring.click(); await popup.waitFor({ state: 'hidden' });

    // Keyboard: the ring is focusable, Enter pins it, and Tab reaches its switches.
    await ring.focus(); await page.keyboard.press('Enter'); await popup.waitFor(); await away(); await page.waitForTimeout(400);
    assert.equal(await popup.isVisible(), true, 'Enter pins the breakdown open');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Smart Prune', 'Tab moves from the ring into the breakdown');
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });

    // /context opens the same view, pinned, for the current chat, and leaves the focus in the composer.
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await input.fill('/context'); await page.locator('.slash-name').filter({ hasText: /^\/context$/ }).waitFor(); await input.press('Enter');
    await popup.waitFor(); await away(); await page.waitForTimeout(400);
    assert.equal(await popup.isVisible(), true, '/context pins the breakdown open');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    await shot('ring-pinned-dark');
    await shot('composer-dark', page.locator('form.composer'));
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    await page.emulateMedia({ colorScheme: 'light' });
    await shot('composer-light', page.locator('form.composer'));

    // An old chat shows its last recorded numbers at once; shares wait for its next request, as in the TUI.
    await page.getByRole('button', { name: 'Older chat', exact: true }).click();
    const older = page.getByRole('button', { name: 'Context window: 6% used', exact: true });
    await older.hover(); await popup.waitFor();
    assert.match(await popup.innerText(), /12k of 200k used \(6%\)/);
    assert.match(await popup.innerText(), /category attribution unavailable until the next provider attempt/);
    // No rag MCP server configured: the RAG switch cannot be turned on, and says why.
    await away(); await popup.waitFor({ state: 'hidden' }); switches.rag = null;
    await older.hover(); await popup.waitFor(); await rag.waitFor();
    assert.equal(await rag.isDisabled(), true); assert.match(await popup.innerText(), /No rag MCP server is configured/);
    await away(); await popup.waitFor({ state: 'hidden' });
    // A bridge without the switches route (or an odd answer) leaves the breakdown working, without switches.
    const kept = { ...switches }; for (const key of Object.keys(switches)) delete switches[key];
    await older.hover(); await popup.waitFor(); await popup.getByText('12k of 200k used (6%)', { exact: true }).waitFor(); await page.waitForTimeout(300);
    assert.equal(await popup.getByRole('switch').count(), 0);
    await away(); await popup.waitFor({ state: 'hidden' }); Object.assign(switches, kept);

    // A chat Elpis has not measured yet keeps its ring, empty, and says so.
    await page.getByRole('button', { name: 'Fresh chat', exact: true }).click();
    const empty = page.getByRole('button', { name: 'Context window: not measured yet', exact: true });
    await empty.hover(); await popup.waitFor();
    assert.match(await popup.innerText(), /Context measurement unavailable until the first request snapshot/);
    assert.equal(await popup.locator('.context-bar').count(), 0);
    await shot('ring-unmeasured-light');
    await away(); await popup.waitFor({ state: 'hidden' });

    // With the ring switched off in Settings, /context still opens the breakdown.
    await page.evaluate(() => localStorage.setItem('elpis-preferences-v1', JSON.stringify({ showContextUsage: false })));
    await page.reload(); await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.context-ring').count(), 0, 'the preference hides the ring');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('elpis:open-context')));
    await popup.waitFor();
    assert.match(await popup.innerText(), /50k of 200k used/);
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.context-ring').count(), 0, 'closing it hides the ring again');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
