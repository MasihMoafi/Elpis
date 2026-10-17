// Elpis's own features in view on the main chat (no hover needed), as the TUI's ledger sits beside its composer, and
// a light theme without orange. Local fixture of the bridge; no runtime or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

/** Every orange the light theme paints (hue 15–50°, saturated, mid lightness), as `selector: property value`. The
 * colours are read back from a canvas pixel, so color-mix(), oklch() and gradients count as what is drawn. */
const oranges = page => page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = '#000'; context.fillStyle = value; context.fillRect(0, 0, 1, 1); return context.getImageData(0, 0, 1, 1).data; };
  const orange = value => {
    const [r, g, b, a] = rgba(value); if (a < 40) return false;
    const [R, G, B] = [r / 255, g / 255, b / 255], max = Math.max(R, G, B), min = Math.min(R, G, B), light = (max + min) / 2, delta = max - min;
    if (!delta) return false;
    const saturation = delta / (1 - Math.abs(2 * light - 1));
    const hue = max === R ? 60 * (((G - B) / delta) % 6) : max === G ? 60 * ((B - R) / delta + 2) : 60 * ((R - G) / delta + 4);
    return hue >= 15 && hue <= 50 && saturation >= 0.5 && light >= 0.25 && light <= 0.85;
  };
  const colours = text => text.match(/(?:rgba?|color|oklab|oklch|lab|lch|hsla?)\([^()]*\)|#[0-9a-f]{3,8}\b/gi) ?? [];
  const name = element => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList].slice(0, 2).map(c => `.${c}`).join('')}`;
  const hits = new Set();
  for (const element of document.querySelectorAll('body *')) {
    if (!element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const checks = [['background-color', style.backgroundColor], ['box-shadow', style.boxShadow], ['background-image', style.backgroundImage]];
    if ([...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) checks.push(['color', style.color]);
    for (const side of ['top', 'right', 'bottom', 'left']) if (parseFloat(style[`border-${side}-width`]) > 0) checks.push([`border-${side}-color`, style[`border-${side}-color`]]);
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) checks.push(['outline-color', style.outlineColor]);
    if (element instanceof SVGElement) checks.push(['fill', style.fill], ['stroke', style.stroke]);
    for (const [property, value] of checks) for (const colour of colours(value ?? '')) if (orange(colour)) hits.add(`${name(element)}: ${property} ${colour}`);
  }
  return [...hits];
});

test('the main chat shows Elpis features under the message box, one click each, and light mode has no orange', async () => {
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
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
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
    assert.deepEqual(await Promise.all(['Smart Prune', 'Subagents', 'RAG'].map(label => chip(label).getAttribute('aria-pressed'))), ['true', 'true', 'false']);
    const [composer, strip] = [await page.locator('.composer').boundingBox(), await features.boundingBox()];
    assert.ok(strip.y >= composer.y + composer.height - 1 && strip.y - (composer.y + composer.height) < 40, `the features sit right under the message box (${JSON.stringify([composer, strip])})`);
    assert.deepEqual(await oranges(page), [], 'light theme, new chat: no orange');

    // One click flips a switch, writes only its key, and the ledger shows the same state.
    await chip('Subagents').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Elpis features"] button[aria-pressed="false"]')?.textContent?.includes('Subagents'));
    assert.deepEqual(saved, [{ version: 'v1', subagents: false }]);
    await chip('RAG').click(); await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Elpis features"] button')].find(b => b.textContent.includes('RAG'))?.getAttribute('aria-pressed') === 'true');
    assert.deepEqual(saved.at(-1), { version: 'v2', rag: true });

    // In a chat, Ledger opens the Context Ledger, whose switches agree with the chips.
    await page.getByRole('button', { name: 'Ledger chat', exact: true }).click();
    await chip('Ledger').click();
    const popup = page.getByRole('dialog', { name: 'Context window usage', exact: true });
    await popup.waitFor();
    assert.equal(await popup.getByRole('switch', { name: 'Subagents', exact: true }).getAttribute('aria-checked'), 'false');
    assert.equal(await popup.getByRole('switch', { name: 'RAG', exact: true }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(await oranges(page), [], 'light theme, open chat with its Context Ledger: no orange');
    await popup.getByRole('switch', { name: 'Smart Prune', exact: true }).click();
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
