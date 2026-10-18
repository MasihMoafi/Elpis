// Masih's polish list, measured in the desktop app's own mode (title bar, tabs): no text smaller than 12px and no icon
// smaller than 14px in everyday views; icons level with their words; search text clear of its magnifier; the archived
// list's checkboxes in one column; the title bar dark in the dark theme and light in the light one.
// Screenshots go to $ELPIS_SHOTS when it is set. Synthetic HTTP/SSE; no engine or provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');
const { openSettings, leaveSettings, chooseTheme } = require('./controls.cjs');
const root = path.resolve(__dirname, '../out');

const limit = (limitId, limitName, usedPercent) => ({ limitId, limitName, planType: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: null, reached: null });
async function app({ width, height }, run) {
  const chat = (id, name, archived) => ({ id, name, preview: name, cwd: '/tmp/elpis-polish', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, archived });
  const threads = [chat('alpha', 'Fix the parser'), chat('bravo', 'Write the docs')], archived = [chat('old-1', 'Old plan', true), chat('old-2', 'Older notes', true)];
  const history = [{ turnId: 't1', turnStatus: 'completed', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Explain the parser.' }] } },
    { turnId: 't1', turnStatus: 'completed', item: { id: 'a1', type: 'agentMessage', text: 'The parser has two passes.' } }];
  const providers = { openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'me@example.com', plan: 'pro' }, usage: [limit('codex', 'Codex', 20)], usageError: null },
    claude: { state: 'connected', models: ['Opus'], usage: [limit('claude', 'Claude', 40)] }, gemini: { state: 'connected', models: ['Gemini 3 Pro'], usage: [limit('antigravity-pro', 'Gemini Pro', 30)] }, openrouter: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); for await (const chunk of req) void chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const thread = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/providers') return json(providers);
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') ? [] : url.searchParams.get('archived') === 'true' ? archived : threads, nextCursor: null });
    if (thread && url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread) return json({ thread, data: history, nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: 'dark' }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(fakeDesktop);
    await page.addInitScript(() => { window.__themes = []; window.elpisDesktop.setTheme = dark => window.__themes.push(dark); });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.thread-row[data-thread-id="alpha"] .thread-link').waitFor();
    await page.locator('.elpis-splash, .startup-splash').waitFor({ state: 'detached' }).catch(() => {});
    const shot = async name => { if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `${name}-${width}x${height}.png`) }); } };
    await run({ page, shot });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
}

/** Everything visible that breaks the rules: text under 12px, icons under 14px, icons more than 1.5px off their words'
 * middle, search text closer than 8px to its magnifier. */
const problems = page => page.evaluate(() => {
  const found = new Set();
  const name = element => `${element.tagName.toLowerCase()}${[...element.classList].slice(0, 2).map(c => `.${c}`).join('')}`;
  const shown = element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && style.visibility !== 'hidden' && Number(style.opacity) > 0.05; };
  const textBox = element => { const node = [...element.querySelectorAll('*'), element].flatMap(item => [...item.childNodes]).find(item => item.nodeType === 3 && item.textContent.trim()); if (!node) return null; const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()][0] ?? null; };
  for (const element of document.querySelectorAll('body *')) {
    if (!shown(element)) continue;
    if ([...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) && parseFloat(getComputedStyle(element).fontSize) < 12) found.add(`text under 12px: ${name(element)} "${element.textContent.trim().slice(0, 24)}" ${getComputedStyle(element).fontSize}`);
    if (element instanceof SVGSVGElement && element.closest('button, [role="menuitem"], [role="tab"], a, label') && element.getBoundingClientRect().width < 13.5) found.add(`icon under 14px: in ${name(element.closest('button, [role="menuitem"], [role="tab"], a, label'))} ${Math.round(element.getBoundingClientRect().width)}px`);
    if (element.matches('button, [role="menuitem"], [role="tab"]') && element.querySelector(':scope > svg')) {
      const icon = element.querySelector(':scope > svg').getBoundingClientRect(), words = textBox(element);
      if (words && Math.abs((icon.top + icon.height / 2) - (words.top + words.height / 2)) > 1.5) found.add(`icon off its words: ${name(element)} "${element.textContent.trim().slice(0, 20)}"`);
    }
    if (element.matches('.search-field')) { const icon = element.querySelector('svg').getBoundingClientRect(), input = element.querySelector('input'), start = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft); if (start - icon.right < 8) found.add(`search text ${Math.round(start - icon.right)}px from its icon: ${input.getAttribute('aria-label')}`); }
  }
  return [...found];
});

for (const size of [{ width: 1440, height: 900 }, { width: 1130, height: 800 }]) {
  test(`everyday views at ${size.width}x${size.height}: readable sizes, icons level with words, clear search fields`, () => app(size, async ({ page, shot }) => {
    const seen = {};
    await page.locator('.thread-row[data-thread-id="alpha"] .thread-link').click(); await page.getByText('The parser has two passes.').waitFor();
    await page.locator('.thread-row[data-thread-id="bravo"]').hover();
    seen.chat = await problems(page); await shot('polish-chat');
    await page.locator('.thread-row[data-thread-id="bravo"]').getByRole('button', { name: /^Actions for/ }).click(); await page.getByRole('menu').waitFor();
    seen.chatMenu = await problems(page); await page.keyboard.press('Escape');
    await openSettings(page);
    for (const tab of ['General', 'Usage & limits', 'Archived chats', 'Models & accounts', 'Keyboard shortcuts', 'Configuration']) {
      await page.getByRole('tab', { name: tab, exact: true }).click(); await page.getByRole('tabpanel', { name: tab, exact: true }).waitFor(); await page.waitForTimeout(150);
      seen[tab] = await problems(page);
    }
    await page.getByRole('tab', { name: 'Archived chats', exact: true }).click(); await page.getByRole('checkbox', { name: 'Select Old plan' }).waitFor(); await shot('polish-archived');
    // Select all and each row's checkbox share one column, and their words start at one line.
    const column = await page.evaluate(() => [...document.querySelectorAll('.archived-check input, .archived-row-check')].map(box => Math.round(box.getBoundingClientRect().left)));
    const words = await page.evaluate(() => [document.querySelector('.archived-check'), ...document.querySelectorAll('.archived-row .settings-row-title')].map(element => { const range = document.createRange(); range.selectNodeContents([...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim())); return Math.round(range.getBoundingClientRect().left); }));
    assert.deepEqual([...new Set(Object.entries(seen).flatMap(([view, list]) => list.map(item => `${view}: ${item}`)))], []);
    assert.equal(new Set(column).size, 1, `checkboxes at x = ${column.join(', ')}`);
    assert.equal(new Set(words).size, 1, `labels start at x = ${words.join(', ')}`);
  }));
}

test('the title bar follows the theme: dark in dark mode, light in light mode, and the window buttons are told', () => app({ width: 1440, height: 900 }, async ({ page, shot }) => {
  const bar = () => page.evaluate(() => { const style = getComputedStyle(document.querySelector('.title-bar')); const [r, g, b] = style.backgroundColor.match(/\d+/g).map(Number); return { light: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, height: Math.round(document.querySelector('.title-bar').getBoundingClientRect().height), top: Math.round(document.querySelector('.title-bar').getBoundingClientRect().top) }; });
  const dark = await bar();
  assert.ok(dark.light < 0.12, `the dark title bar is dark (${dark.light.toFixed(2)})`); assert.deepEqual([dark.top, dark.height], [0, 36]);
  assert.equal(await page.evaluate(() => window.__themes.at(-1)), true, 'the window buttons were drawn dark');
  await shot('polish-titlebar-dark');
  await chooseTheme(page, 'light');
  await page.waitForFunction(() => window.__themes.at(-1) === false);
  assert.ok((await bar()).light > 0.85, 'the light title bar is light');
  await leaveSettings(page);
}));
