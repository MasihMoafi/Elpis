// Elpis's own features in view on the main chat (no hover needed), as the TUI's ledger sits beside its composer, and
// a light theme with the approved amber/orange accents. Local fixture of the bridge; no runtime or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { unapprovedOranges } = require('./controls.cjs');

test('the A87 accent check accepts only the approved colours and mixes, and rejects the old brown', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>:root { --hud-edge: #ddd; } .composer { border: 1px solid color-mix(in oklch, #e89d34 80%, var(--hud-edge)); } .message.user { border-right: 2px solid color-mix(in oklch, #e89d34 70%, transparent); }</style><button style="background:#ff8a00">Send</button><svg width="16" height="16" fill="#e89d34"><path d="M0 0H16V16H0Z" /></svg><form class="composer">Message</form><div class="message user">Prompt</div>');
    assert.deepEqual(await unapprovedOranges(page), []);
    for (const colour of ['#b34700', '#e89d35']) {
      await page.locator('button').evaluate((button, colour) => { button.style.backgroundColor = colour; }, colour);
      assert.equal((await unapprovedOranges(page)).length, 1, `${colour} is not approved`);
    }
    await page.locator('button').evaluate(button => { button.style.backgroundColor = '#ff8a00'; });
    await page.locator('.composer').evaluate(form => { form.style.borderColor = '#b34700'; });
    assert.equal((await unapprovedOranges(page)).length, 4, 'unapproved borders stay checked');
  } finally { await browser.close(); }
});

test('the main chat shows Elpis features under the message box, one click each, and light mode has only approved amber/orange accents', async () => {
  const thread = { id: 'ledger', name: 'Ledger chat', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const switches = { version: 'v1', write: { available: true }, smartPrune: true, subagents: true, rag: false }, saved = [];
  // As the bridge does: every /api request is refused until the page trades its #token for a session.
  let session = false; const refused = [];
  const ledger = { used: 50000, window: 200000, categories: [['userMessages', 980], ['toolCalls', 490], ['toolResults', 26471], ['systemInstructions', 7843]].map(([id, tokens]) => ({ id, label: id, tokens })) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/session' && req.method === 'POST') { session = JSON.parse(raw).token === 'fixture'; return json({ authenticated: session }); }
    if (url.pathname.startsWith('/api/') && !session) { refused.push(url.pathname); res.statusCode = 401; return json({ error: 'Not signed in' }); }
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : [thread], nextCursor: null });
    if (url.pathname === '/api/context/switches') {
      if (req.method === 'POST') { const body = JSON.parse(raw); saved.push(body); const { version, ...changes } = body; Object.assign(switches, changes, { version: `v${saved.length + 1}` }); }
      return json(switches);
    }
    if (url.pathname === '/api/threads/ledger/context') return json({ threadId: 'ledger', tokenUsage: null, smartPrune: null, ledger });
    if (url.pathname === '/api/threads/ledger') return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(process.env.ELPIS_OUT_DIR || path.join(__dirname, '../out'), relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 }, colorScheme: 'light' }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    const features = page.getByRole('group', { name: 'Elpis features', exact: true });
    const chip = label => features.getByRole('button', { name: label, exact: true });

    // A new chat: the switches are in view without hovering anything, and say whether each is on.
    await features.waitFor();
    assert.deepEqual(await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--primary', '--primary-action'].map(key => style.getPropertyValue(key).trim());
    }), ['#e89d34', '#ff8a00'], 'A87: logo amber and send orange are the actual theme accents');
    assert.deepEqual(await Promise.all(['Smart Prune', 'Subagents', 'RAG'].map(label => chip(label).getAttribute('aria-pressed'))), ['true', 'true', 'false']);
    const [composer, strip] = [await page.locator('.composer').boundingBox(), await features.boundingBox()];
    assert.ok(strip.y >= composer.y + composer.height - 1 && strip.y - (composer.y + composer.height) < 40, `the features sit right under the message box (${JSON.stringify([composer, strip])})`);
    assert.deepEqual(await unapprovedOranges(page), [], 'light theme, new chat: only approved amber/orange accents');

    // A new chat has its context ring too; clicking it (as in Claude) shows the context window alone: the switches are the chips above.
    const ring = page.getByRole('button', { name: 'Context window: not measured yet', exact: true });
    await ring.click();
    const ledgerPopup = page.getByRole('dialog', { name: 'Context window usage', exact: true }); await ledgerPopup.waitFor();
    assert.equal(await ledgerPopup.getByRole('switch').count(), 0);
    assert.equal((await ledgerPopup.innerText()).replace(/\s+/g, ' ').trim(), 'Context window Send a message to see context usage.');
    assert.deepEqual(await unapprovedOranges(page), [], 'light theme, new chat ledger: only approved amber/orange accents');
    await page.keyboard.press('Escape'); await ledgerPopup.waitFor({ state: 'hidden' });

    // One click flips a switch, writes only its key, and the ledger shows the same state.
    await chip('Subagents').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Elpis features"] button[aria-pressed="false"]')?.textContent?.includes('Subagents'));
    assert.deepEqual(saved, [{ version: 'v1', subagents: false }]);
    await chip('RAG').click(); await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Elpis features"] button')].find(b => b.textContent.includes('RAG'))?.getAttribute('aria-pressed') === 'true');
    assert.deepEqual(saved.at(-1), { version: 'v2', rag: true });

    // In a chat, Ledger opens the breakdown, which does not repeat the switches the chips carry.
    await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    await chip('Ledger').click();
    const popup = page.getByRole('dialog', { name: 'Context window usage', exact: true });
    await popup.waitFor();
    assert.equal(await popup.getByRole('switch').count(), 0);
    assert.deepEqual(await unapprovedOranges(page), [], 'light theme, open chat with its Context Ledger: only approved amber/orange accents');
    await chip('Smart Prune').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Elpis features"] button')].find(b => b.textContent.includes('Smart Prune'))?.getAttribute('aria-pressed') === 'false');

    // The ledger's context colour is olive (a yellowish green), in both themes.
    const hueOf = () => page.evaluate(() => { const ring = document.querySelector('.context-ring-fill'); const [r, g, b] = getComputedStyle(ring).stroke.match(/[\d.]+/g).map(Number); const max = Math.max(r, g, b), min = Math.min(r, g, b); return max === min ? -1 : max === r ? 60 * (((g - b) / (max - min)) % 6) : max === g ? 60 * ((b - r) / (max - min) + 2) : 60 * ((r - g) / (max - min) + 4); });
    assert.ok((await hueOf()) >= 55 && (await hueOf()) <= 80, `light: olive context colour (hue ${await hueOf()})`);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    assert.ok((await hueOf()) >= 55 && (await hueOf()) <= 80, `dark: olive context colour (hue ${await hueOf()})`);
    assert.deepEqual(refused, [], 'nothing asks the bridge before the session exists');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
