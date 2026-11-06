const { threadMenuItem } = require('./controls.cjs');
// The integrated terminal as in the ChatGPT app (Codex mode), and the Elpis TUI handoff in both directions.
// The desktop bridge is a fake that records calls; no shell, engine or provider is started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cjs');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_TERMINAL_SHOTS;
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}

async function fixture(run) {
  const threads = [
    { id: 'chat-one', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/work/parser', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
    { id: 'chat-two', name: 'Write the docs', preview: 'Write the docs', cwd: '/work/docs', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
  ];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); for await (const _ of req) { /* drain */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const thread = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads, nextCursor: null });
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(() => {
      const saved = new Map(), calls = window.__terminal = { open: [], restart: [], closed: [], tui: [], input: [], resize: [], copied: [] };
      let data = () => {}, exit = () => {}, openThread = () => {}, sessions = 0;
      const shells = {}, start = key => { shells[key] = { id: ++sessions, end: 0 }; return { id: shells[key].id, end: 0, shell: 'bash', output: '', exited: null }; };
      window.__emit = (key, text) => { const shell = shells[key]; shell.end += text.length; data(key, shell.id, shell.end, text); };
      window.__exit = (key, code) => exit(key, shells[key].id, code);
      window.__openThread = id => openThread(id);
      window.elpisDesktop = {
        storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key), onError: () => () => {} },
        browser: { command: async () => ({ visible: false, activeId: null, focusAddress: 0, tabs: [] }), layout: () => {}, subscribe: () => () => {} },
        terminal: {
          open: async (...args) => { calls.open.push(args); return shells[args[0]] ? { ...shells[args[0]], shell: 'bash', output: '', exited: null } : start(args[0]); },
          restart: async (...args) => { calls.restart.push(args); return start(args[0]); },
          close: async key => { calls.closed.push(key); delete shells[key]; return {}; },
          tui: async (...args) => { calls.tui.push(args); return { started: true }; },
          input: (key, text) => calls.input.push([key, text]),
          resize: (...args) => calls.resize.push(args),
          copy: async text => { calls.copied.push(text); },
          paste: async () => 'pasted words',
          subscribe: (onData, onExit) => { data = onData; exit = onExit; return () => {}; },
        },
        onOpenThread: callback => { openThread = callback; return () => {}; },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').waitFor();
    await run({ page, calls: () => page.evaluate(() => window.__terminal) });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const panel = page => page.getByRole('region', { name: 'Terminal' });
const sidePanel = page => page.getByRole('region', { name: 'Side panel' });

test('Open in Elpis TUI is in the tab and sidebar menus and resumes that chat in a terminal tab of the side panel; /app opens a chat here', () => fixture(async ({ page, calls }) => {
  await page.locator('.thread-row[data-thread-id="chat-two"]').hover();
  await page.getByRole('button', { name: 'Actions for Write the docs' }).click();
  await (await threadMenuItem(page, 'Open in Elpis TUI')).click();
  await panel(page).waitFor();
  await eventually(async () => assert.deepEqual((await calls()).tui.map(([key, cwd, id]) => [/^terminal-/.test(key), cwd, id]), [[true, '/work/docs', 'chat-two']]));
  await page.getByRole('tab', { name: /Write the docs/ }).waitFor();
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await (await threadMenuItem(page, 'Open in Elpis TUI')).waitFor(); // the chat tab’s … menu has it too
  if (shots) await page.screenshot({ path: path.join(shots, 'open-in-tui-menu.png') });
  // Asking again for the same chat uses its terminal tab; it does not open another.
  await (await threadMenuItem(page, 'Open in Elpis TUI')).click();
  await eventually(async () => assert.equal((await calls()).tui.length, 2));
  assert.equal(new Set((await calls()).tui.map(([key]) => key)).size, 1);
  assert.equal(await sidePanel(page).getByRole('tab').count(), 1);
  // The TUI's /app: the running window opens the chat it names.
  await page.evaluate(() => window.__openThread('chat-one'));
  await page.getByRole('tab', { name: /Fix the parser/, selected: true }).waitFor();
  // Keys typed in the terminal go to its shell (as in ChatGPT); from the composer, Ctrl+/ lists the terminal's shortcut.
  await page.getByLabel('Message Elpis').focus();
  await page.keyboard.press('Control+/');
  await page.getByRole('alertdialog').getByText('Toggle terminal').waitFor();
}));
