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
  measured: { used: 50000, window: 200000, categories: categories.map(([id, label, tokens]) => ({ id, label, tokens })), basis: 'engine' },
  fresh: { used: null, window: null, categories: [] },
  // An old chat: the bridge restored its last recorded usage from the rollout and estimated the shares from its saved transcript.
  older: { used: 12000, window: 200000, categories: [['userMessages', 'User messages', 300], ['toolResults', 'Tool results', 9000], ['systemInstructions', 'System instructions', 1700], ['toolDefinitions', 'Tool definitions + schema', 1000]].map(([id, label, tokens]) => ({ id, label, tokens })), basis: 'transcript' },
  // A chat whose transcript cannot be attributed (its history was shortened): only the measured total.
  bare: { used: 9000, window: 200000, categories: [] },
  // Past 75% the ring turns amber and past 90% red; from half full the popover offers Compact session.
  heavy: { used: 160000, window: 200000, categories: [['toolResults', 'Tool results', 140000], ['systemInstructions', 'System instructions', 20000]].map(([id, label, tokens]) => ({ id, label, tokens })), basis: 'engine' },
  full: { used: 190000, window: 200000, categories: [['toolResults', 'Tool results', 170000], ['systemInstructions', 'System instructions', 20000]].map(([id, label, tokens]) => ({ id, label, tokens })), basis: 'engine' },
};
// Whether Compact session can run: a chat in the middle of a turn cannot.
const compactions = { full: { available: false, reason: 'Available when Elpis finishes this turn' } };
// The TUI's palettes (codex-rs/tui/src/chatwidget/context_usage.rs): charcoal in dark, paper in light. Tool calls are brown in light
// where the TUI's is orange, because the light theme has no orange (tests/elpis-features.test.cjs).
const palette = {
  dark: { userMessages: '#53b1ff', agentMessages: '#3fd394', reasoning: '#ab84ff', toolCalls: '#ffa13a', toolResults: '#d9db75', systemInstructions: '#f0445d', developerMessages: '#ff99c2', toolDefinitions: '#a0a0a0' },
  light: { userMessages: '#006cce', agentMessages: '#00875c', reasoning: '#7143d6', toolCalls: '#7d5b3a', toolResults: '#74841b', systemInstructions: '#8c2d3c', developerMessages: '#ce478f', toolDefinitions: '#646464' },
};
const rgb = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

/** A local fixture of the bridge for the four chats above; the page it serves is the built app (out/). */
async function startFixture() {
  const thread = (id, name) => ({ id, name, cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
  const threads = [thread('measured', 'Ledger chat'), thread('fresh', 'Fresh chat'), thread('older', 'Older chat'), thread('bare', 'Bare chat'), thread('heavy', 'Heavy chat'), thread('full', 'Full chat')];
  const streams = new Set(), saved = [], compacted = [];
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
    const compact = url.pathname.match(/^\/api\/threads\/([^/]+)\/compact$/);
    if (compact && req.method === 'POST') { compacted.push(compact[1]); return json({}); }
    if (url.pathname === '/api/context/switches') {
      if (req.method === 'POST') { const body = JSON.parse(raw); saved.push(body); const { version, ...changes } = body; Object.assign(switches, changes, { version: `v${saved.length + 1}` }); }
      return json(switches);
    }
    if (/^\/api\/threads\/[^/]+\/context-files$/.test(url.pathname)) return json({ files: [] });
    const context = url.pathname.match(/^\/api\/threads\/([^/]+)\/context$/);
    if (context) return json({ threadId: context[1], tokenUsage: null, smartPrune: null, ledger: ledgers[context[1]], compact: compactions[context[1]] ?? { available: true } });
    const read = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (read) return json({ thread: threads.find(item => item.id === read[1]), data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(process.env.ELPIS_OUT_DIR || path.join(__dirname, '../out'), relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, streams, saved, compacted, switches, url: `http://127.0.0.1:${server.address().port}` };
}
const stop = async ({ server, streams }) => { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test('the context ring is Claude\'s: a tooltip on hover, the breakdown on click, closed by a second click, Escape or a click elsewhere, and opened by /context', async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const shots = process.env.ELPIS_CONTEXT_SHOTS, shot = async (name, locator) => { if (shots) { await fs.mkdir(shots, { recursive: true }); await (locator ?? page).screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    const ring = page.getByRole('button', { name: 'Context window: 25% used', exact: true });
    const popup = page.getByRole('dialog', { name: 'Context window usage', exact: true });
    const away = () => page.mouse.move(5, 5);
    await ring.waitFor();
    const [ringBox, modelBox] = [await ring.boundingBox(), await page.getByRole('combobox', { name: 'Model', exact: true }).boundingBox()];
    assert.ok(Math.abs(ringBox.y + ringBox.height / 2 - (modelBox.y + modelBox.height / 2)) <= 0.5 && ringBox.height === modelBox.height, `the ring shares the composer controls' height and centre line (${JSON.stringify([ringBox, modelBox])})`);
    assert.equal(await page.getByRole('button', { name: 'Context', exact: true }).count(), 0, 'the header Context button is gone; the ring and /context open the breakdown');

    // Hovering shows Claude's tooltip with the numbers, not the breakdown; a click opens the breakdown, and the tooltip steps aside.
    const tooltip = page.locator('.hud-tooltip');
    await ring.hover(); await tooltip.waitFor();
    assert.equal((await tooltip.innerText()).trim(), 'Context 50k / 200k (25%)');
    await page.waitForTimeout(500);
    assert.equal(await popup.isVisible(), false, 'hovering the ring does not open the breakdown');
    assert.equal(await ring.locator('svg.context-ring-icon').getAttribute('width'), '16', 'a 16px ring');
    await ring.click(); await popup.waitFor(); await tooltip.waitFor({ state: 'hidden' });
    // The popover is Claude's: a 360px card that starts at the context window. The title and total, the switches and their note
    // are already in the chat below.
    assert.equal((await popup.boundingBox()).width, 360);
    assert.equal(await popup.locator('.context-ledger-name, .context-ledger-title, .context-ledger-switches').count(), 0, 'no title row, no switches');
    assert.equal(await popup.getByRole('switch').count(), 0, 'Smart Prune, Subagents and RAG are the chips under the message box, not here');
    assert.doesNotMatch(await popup.innerText(), /context ledger|tokens in context|smart prune|subagents|\bRAG\b|for every chat/i, 'nothing the chat below already says');
    assert.equal(await popup.locator(':scope > *').first().innerText().then(text => text.replace(/\s+/g, ' ').trim()), 'Context window 50k / 200k (25%)', 'it starts at the context window, and the total appears once');
    assert.equal(await popup.locator('.context-ledger-summary').textContent(), '50k / 200k (25%)', 'the measured total carries no ≈');
    assert.equal((await popup.locator('.context-bar').boundingBox()).height, 4, 'a thin bar, as Claude\'s meter');
    assert.deepEqual(await popup.locator('.context-ledger-row-label').allInnerTexts(), [...categories.map(([, label]) => label), 'Free capacity'], 'the TUI ledger\'s category names, in its order');
    assert.equal((await popup.locator('.context-ledger-row').filter({ hasText: 'Tool results' }).innerText()).replace(/\s+/g, ' ').trim(), 'Tool results ≈26.5k 13.2%');
    assert.match(await popup.innerText(), /Measured total · estimated category shares/i, 'estimates are labelled as estimates');
    // Segments are proportional to the real numbers, on a full-window scale.
    const bar = await popup.locator('.context-bar').boundingBox();
    for (const [id, , tokens] of categories) {
      const segment = await popup.locator(`.context-bar-segment[data-category="${id}"]`).boundingBox();
      assert.ok(Math.abs(segment.width - bar.width * tokens / 200000) < 1, `${id} is ${tokens} of 200000 wide (got ${segment.width} of ${bar.width})`);
    }
    // Each segment is its legend dot's colour, one colour per category, in the TUI's palette for the theme.
    const colours = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.context-ledger [data-category]')].filter(node => node.classList.contains('context-bar-segment')).map(segment => {
      const id = segment.getAttribute('data-category'), row = document.querySelector(`.context-ledger-row[data-category="${id}"]`);
      return [id, [getComputedStyle(segment).backgroundColor, getComputedStyle(row, '::before').backgroundColor]];
    })));
    const light = await colours();
    for (const [id, [segment, dot]] of Object.entries(light)) { assert.equal(segment, dot, `${id}: bar segment and legend dot share a colour`); assert.equal(segment, rgb(palette.light[id]), `${id} in light`); }
    assert.equal(new Set(Object.values(light).map(([segment]) => segment)).size, categories.length, 'one colour per category');
    await shot('ring-open-light');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    const dark = await colours();
    for (const [id, [segment, dot]] of Object.entries(dark)) { assert.equal(segment, dot, `${id}: bar segment and legend dot share a colour (dark)`); assert.equal(segment, rgb(palette.dark[id]), `${id} in dark`); }
    await shot('ring-open-dark');
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(200);

    // It stays open when the pointer leaves, sits above the message box and is level with the ring's right edge.
    await away(); await page.waitForTimeout(500);
    assert.equal(await popup.isVisible(), true, 'the breakdown stays open when the pointer leaves');
    const [pinned, composer, anchor] = [await popup.boundingBox(), await page.locator('form.composer').boundingBox(), await ring.boundingBox()];
    assert.ok(pinned.y + pinned.height <= composer.y, `the pinned breakdown sits above the message box (${pinned.y + pinned.height} vs ${composer.y})`);
    assert.ok(Math.abs(pinned.x + pinned.width - (anchor.x + anchor.width)) <= 1, 'its right edge is the ring\'s right edge');
    // The header row folds the categories away and back, as Claude's does; the bar stays.
    const head = popup.getByRole('button', { name: /^Context window/ });
    assert.equal(await head.getAttribute('aria-expanded'), 'true');
    await head.click(); await popup.locator('.context-ledger-rows').waitFor({ state: 'detached' });
    assert.equal(await popup.locator('.context-bar-segment').count(), categories.length, 'the bar stays when the categories are folded');
    await head.click(); await popup.locator('.context-ledger-rows').waitFor();
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    // A second click on the ring closes it; so does a click elsewhere.
    await ring.click(); await popup.waitFor(); await ring.click(); await popup.waitFor({ state: 'hidden' });
    await ring.click(); await popup.waitFor(); await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).click(); await popup.waitFor({ state: 'hidden' });

    // Keyboard: the ring is focusable and Enter opens it.
    await ring.focus(); await page.keyboard.press('Enter'); await popup.waitFor(); await away(); await page.waitForTimeout(400);
    assert.equal(await popup.isVisible(), true, 'Enter opens the breakdown');
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });

    // /context opens the same view, pinned, for the current chat, and leaves the focus in the composer.
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await input.fill('/context'); await page.locator('.slash-name').filter({ hasText: /^\/context$/ }).waitFor(); await input.press('Enter');
    await popup.waitFor(); await away(); await page.waitForTimeout(400);
    assert.equal(await popup.isVisible(), true, '/context opens the breakdown');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    await shot('ring-pinned-dark');
    await shot('composer-dark', page.locator('form.composer'));
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    await page.emulateMedia({ colorScheme: 'light' });
    await shot('composer-light', page.locator('form.composer'));

    // An old chat shows its last recorded numbers at once, with shares the bridge estimated from its saved transcript.
    const open = async name => { await ring_(name).click(); await popup.waitFor(); };
    const ring_ = name => page.getByRole('button', { name, exact: true });
    const close = async () => { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' }); };
    const strokeOf = locator => locator.locator('.context-ring-fill').evaluate(node => getComputedStyle(node).stroke);
    await page.getByRole('button', { name: 'Older chat', exact: true }).click();
    const olive = await strokeOf(ring_('Context window: 6% used'));
    await open('Context window: 6% used');
    assert.match(await popup.innerText(), /12k \/ 200k \(6%\)/);
    assert.match(await popup.innerText(), /Measured total · category shares estimated from the saved chat; exact after the next request/);
    assert.deepEqual(await popup.locator('.context-ledger-row-label').allInnerTexts(), ['User messages', 'Tool results', 'System instructions', 'Tool definitions + schema', 'Free capacity'], 'the bar is split here too');
    assert.equal(await popup.locator('.context-bar-segment').count(), 4);
    assert.doesNotMatch(await popup.innerText(), /unavailable/);
    assert.equal(await popup.getByRole('button', { name: 'Compact session' }).count(), 0, 'Compact session is offered from half full');
    await shot('ring-estimated-light');
    await close();
    // A chat whose transcript cannot be attributed has the measured total only, in one colour, and says why.
    await page.getByRole('button', { name: 'Bare chat', exact: true }).click();
    await open('Context window: 5% used');
    assert.match(await popup.innerText(), /9k \/ 200k \(5%\)/);
    assert.match(await popup.innerText(), /category attribution unavailable until the next provider attempt/);
    assert.equal(await popup.locator('.context-bar-segment').count(), 1);
    await close();

    // The ring is amber from 75% and red from 90%; from half full the popover offers Compact session, which compacts this chat.
    await page.getByRole('button', { name: 'Heavy chat', exact: true }).click();
    await ring_('Context window: 80% used').waitFor();
    assert.equal(await ring_('Context window: 80% used').locator('svg.context-ring-icon').getAttribute('data-level'), 'warning');
    const amber = await strokeOf(ring_('Context window: 80% used'));
    assert.notEqual(amber, olive, 'amber differs from the olive of a ring under 75%');
    await open('Context window: 80% used');
    const compact = popup.getByRole('button', { name: 'Compact session', exact: true });
    assert.equal(await compact.isEnabled(), true);
    await shot('ring-compact-light');
    await compact.click(); await popup.waitFor({ state: 'hidden' });
    assert.deepEqual(fixture.compacted, ['heavy'], 'Compact session compacts this chat');
    await page.getByRole('button', { name: 'Full chat', exact: true }).click();
    await ring_('Context window: 95% used').waitFor();
    assert.equal(await ring_('Context window: 95% used').locator('svg.context-ring-icon').getAttribute('data-level'), 'critical');
    await open('Context window: 95% used');
    assert.equal(await popup.getByRole('button', { name: 'Compact session', exact: true }).isDisabled(), true, 'not while the chat is in the middle of a turn');
    assert.equal(await popup.getByRole('button', { name: 'Compact session', exact: true }).locator('xpath=..').getAttribute('title'), 'Available when Elpis finishes this turn');
    await close();

    // A chat Elpis has not measured yet keeps its ring, empty, and says so as Claude's does.
    await page.getByRole('button', { name: 'Fresh chat', exact: true }).click();
    await open('Context window: not measured yet');
    assert.match(await popup.innerText(), /Send a message to see context usage\./);
    assert.equal(await popup.locator('.context-bar').count(), 0);
    await shot('ring-unmeasured-light');
    await close();

    // With the ring switched off in Settings, /context still opens the breakdown.
    await page.evaluate(() => localStorage.setItem('elpis-preferences-v1', JSON.stringify({ showContextUsage: false })));
    await page.reload(); await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.context-ring').count(), 0, 'the preference hides the ring');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('elpis:open-context')));
    await popup.waitFor();
    assert.match(await popup.innerText(), /50k \/ 200k \(25%\)/);
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.context-ring').count(), 0, 'closing it hides the ring again');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await stop(fixture);
  }
});

test('the Ledger button under the message box toggles the breakdown like any popover trigger; Escape and a click outside close it too', async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    const chip = page.locator('.composer .context-ring');
    const popup = page.getByRole('dialog', { name: 'Context window usage', exact: true });
    const settled = () => page.waitForTimeout(450);
    await chip.waitFor();
    // It carries the same ring as the composer's, and the same tooltip.
    assert.equal(await chip.locator('svg.context-ring-icon .context-ring-fill').count(), 1, 'the Ledger button shows the context ring');
    await chip.hover(); await page.locator('.hud-tooltip').waitFor();
    assert.match(await page.locator('.hud-tooltip').innerText(), /^Context 50k \/ 200k \(25%\)/);
    await page.mouse.move(5, 5);

    // Real clicks: the first opens it and it stays open when the pointer moves on; the second closes it, and it stays closed.
    await chip.click(); await popup.waitFor(); await page.mouse.move(5, 5); await settled();
    assert.equal(await popup.isVisible(), true, 'a click on Ledger pins the breakdown');
    await chip.click(); await popup.waitFor({ state: 'hidden' }); await settled();
    assert.equal(await popup.isVisible(), false, 'a second click on Ledger closes it, and it does not open again');
    await chip.click(); await popup.waitFor();

    // Escape closes it; a click outside (on the message box) closes it; the context ring toggles it too.
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
    await chip.click(); await popup.waitFor(); await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).click(); await popup.waitFor({ state: 'hidden' });
    await chip.click(); await popup.waitFor(); await page.getByRole('button', { name: 'Context window: 25% used', exact: true }).click(); await popup.waitFor({ state: 'hidden' });

    // From the keyboard: Enter on Ledger opens it, Enter again closes it.
    await chip.focus(); await page.keyboard.press('Enter'); await popup.waitFor();
    await page.keyboard.press('Enter'); await popup.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await stop(fixture); }
});
