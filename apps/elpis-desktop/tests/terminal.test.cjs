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
const screen = page => page.locator('.terminal-body .xterm-rows');
const keyOf = async calls => (await calls()).open.at(-1)[0];

test('Ctrl+` opens a shell as a side-panel tab in the chat’s folder; keys, output, copy, paste, resize and Ctrl+` again', () => fixture(async ({ page, calls }) => {
  await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').click();
  await page.getByRole('tab', { name: /Fix the parser/ }).waitFor();
  assert.equal(await sidePanel(page).count(), 0, 'the panel is closed until it is asked for');
  await page.keyboard.press('Control+Backquote');
  await panel(page).waitFor();
  await sidePanel(page).getByRole('tab', { name: 'Terminal' }).waitFor();
  await eventually(async () => { const [[key, cwd]] = (await calls()).open; assert.match(key, /^terminal-/); assert.equal(cwd, '/work/parser'); });
  const key = await keyOf(calls);
  const [, , cols, rows] = (await calls()).open[0];
  assert(cols > 20 && rows > 3, `the shell starts at the panel's size, not a default (${cols}x${rows})`);
  assert.equal(await panel(page).getByText('parser', { exact: true }).count(), 1, 'the header names the folder');
  await page.evaluate(key => window.__emit(key, 'hello from bash\r\n$ '), key);
  await eventually(async () => assert.match(await screen(page).innerText(), /hello from bash/));
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await eventually(async () => assert.equal((await calls()).input.filter(([k]) => k === key).map(([, text]) => text).join(''), 'ls\r\x03'));
  // Copy: the selection, with Ctrl+Shift+C. Paste: Ctrl+Shift+V, typed into the shell.
  const box = await page.locator('.terminal-body .xterm-screen').boundingBox();
  await page.mouse.move(box.x + 2, box.y + 6); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 6, { steps: 6 }); await page.mouse.up();
  await page.keyboard.press('Control+Shift+C');
  await eventually(async () => assert.match((await calls()).copied.join(''), /^hello/));
  await page.keyboard.press('Control+Shift+V');
  await eventually(async () => assert.match((await calls()).input.map(([, text]) => text).join(''), /pasted words$/));
  if (shots) await page.screenshot({ path: path.join(shots, 'terminal-open.png') });
  // The panel's left edge resizes it, and the shell is told its new size.
  const before = (await sidePanel(page).boundingBox()).width, resizes = (await calls()).resize.length;
  const edge = await page.getByRole('separator', { name: 'Resize side panel' }).boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 300); await page.mouse.down();
  await page.mouse.move(edge.x - 120, edge.y + 300, { steps: 5 }); await page.mouse.up();
  await eventually(async () => assert((await sidePanel(page).boundingBox()).width > before + 90));
  await eventually(async () => assert((await calls()).resize.length > resizes));
  // Ctrl+` from inside the terminal hides the panel; the shell keeps running and is not started again.
  await page.keyboard.press('Control+Backquote');
  await eventually(async () => assert.equal(await sidePanel(page).count(), 0));
  await page.keyboard.press('Control+Backquote');
  await panel(page).waitFor();
  await eventually(async () => assert.match(await screen(page).innerText(), /hello from bash/));
  assert.equal((await calls()).open.length, 1);
  // The shell belongs to its tab, not to a chat: another chat shows the same shell.
  await page.locator('.thread-row[data-thread-id="chat-two"] .thread-link').click();
  await page.getByRole('tab', { name: /Write the docs/ }).waitFor();
  await eventually(async () => assert.match(await screen(page).innerText(), /hello from bash/));
  assert.equal((await calls()).open.length, 1);
  // An ended shell says so and restarts.
  await page.evaluate(key => window.__exit(key, 0), key);
  await panel(page).getByText('Shell exited').waitFor();
  await panel(page).getByRole('button', { name: 'Restart terminal' }).click();
  await eventually(async () => assert.deepEqual((await calls()).restart.map(([k]) => k), [key]));
  await eventually(async () => assert.equal(await panel(page).getByText('Shell exited').count(), 0));
  // Closing the tab ends its shell; with its last tab gone the panel closes (A217: "this shouldn't be open for no reason")
  // and opens again, empty, ready for a new tab.
  await sidePanel(page).getByRole('button', { name: 'Close Terminal 1 tab' }).click();
  await eventually(async () => assert.deepEqual((await calls()).closed, [key]));
  await eventually(async () => assert.equal(await sidePanel(page).count(), 0));
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await sidePanel(page).getByText('Nothing open here yet.').waitFor();
  await page.getByRole('button', { name: 'Close side panel' }).click();
  await eventually(async () => assert.equal(await sidePanel(page).count(), 0));
}));

test('Open in Elpis TUI is in the tab and sidebar menus and resumes that chat in a terminal tab of the side panel; /app opens a chat here', () => fixture(async ({ page, calls }) => {
  await page.locator('.thread-row[data-thread-id="chat-two"]').hover();
  await page.getByRole('button', { name: 'Actions for Write the docs' }).click();
  await page.getByRole('menuitem', { name: 'Open in Elpis TUI' }).click();
  await panel(page).waitFor();
  await eventually(async () => assert.deepEqual((await calls()).tui.map(([key, cwd, id]) => [/^terminal-/.test(key), cwd, id]), [[true, '/work/docs', 'chat-two']]));
  await page.getByRole('tab', { name: /Write the docs/ }).waitFor();
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: 'Open in Elpis TUI' }).waitFor(); // the chat tab’s … menu has it too
  if (shots) await page.screenshot({ path: path.join(shots, 'open-in-tui-menu.png') });
  // Asking again for the same chat uses its terminal tab; it does not open another.
  await page.getByRole('menuitem', { name: 'Open in Elpis TUI' }).click();
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
