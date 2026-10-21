// The shared fixture of the Claude-parity UI tests (claude-composer, claude-chat): the exported UI against a local
// bridge with three chats (the first has four turns of Markdown replies), a files route, a revert route that really
// drops turns, a fake desktop (browser, terminal, storage) and a clipboard that records what is written. Every POST is
// recorded. No engine, no model, no shell.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');

const out = path.resolve(__dirname, '../out');
const CWD = '/tmp/parity-fixture';
/** An 8×8 red PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const FILES = ['README.md', 'package.json', 'docs/guide.md', 'src/app.ts', 'src/lib/parser.ts', 'src/lib/lexer.ts'];
const thread = (id, name) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const THREADS = [thread('chat-a', 'Fix the parser'), thread('chat-b', 'Write the docs'), thread('chat-c', 'Plan the release')];
const filler = count => Array.from({ length: count }, (_, i) => `Detail ${i + 1} of the explanation, in a sentence of its own.`).join('\n\n');
/** The first chat: four turns, [turn id, prompt, reply]. The first reply is the Markdown the copy tests read. */
const TURNS = [
  ['t1', 'Explain the parser.', 'The parser has **two passes**.\n\n- lexing\n- parsing\n\nSee [the guide](https://example.invalid/guide).'],
  ['t2', 'Rename the lexer.', `Done: \`lexer.ts\` is now \`scan.ts\`.\n\n${filler(8)}`],
  ['t3', 'Add tests.', `Added three tests.\n\n${filler(8)}`],
  ['t4', 'Run them.', 'All green.'],
];

/** Starts the bridge and a browser page. `running` makes the first chat run a turn; `desktop` is the fake desktop;
 * `threads` replaces the chat list; `chat` replaces the first chat's turns: [turn id, prompt, reply, work items between them]; `routes` answers more
 * API paths: path → (body, url) → reply. `nativeClipboard` uses Chromium's clipboard
 * with read/write permissions instead of the default writeText recorder. `showScrollbars` keeps native scrollbar
 * geometry in headless Chromium, where Playwright otherwise passes --hide-scrollbars. */
async function fixture({ staticDir = out, cwd = CWD, width = 1130, height = 660, colorScheme = 'light', running = false, desktop = true, chat: start = TURNS, threads: initialThreads = THREADS, routes = {}, storage = {}, browserChannel, nativeClipboard = false, showScrollbars = false } = {}) {
  const posts = [], turns = start.map(turn => [...turn]), streams = new Set(), loveStreams = new Set();
  const threads = initialThreads.map(item => ({ ...item, cwd }));
  let rewindSaved = null, rewindAction;
  // A turn may give its start time (ms) fifth, or null for a turn with no recorded times; otherwise turns are two
  // minutes apart, ending now.
  const entries = () => turns.flatMap(([id, prompt, reply, work, startedAt], index) => {
    const at = startedAt ?? Date.now() - (turns.length - index) * 120_000;
    const turn = [{ turnId: id, item: { id: `u-${id}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] }, startedAtMs: at, completedAtMs: at },
      ...(work ?? []).map(item => ({ turnId: id, item, startedAtMs: at + 1000, completedAtMs: at + 2000 })),
      { turnId: id, item: { id: `a-${id}`, type: 'agentMessage', text: reply }, startedAtMs: at + 5000, completedAtMs: at + 5000 }];
    return startedAt === null ? turn.map(({ turnId, item }) => ({ turnId, item })) : turn;
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const chat = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (req.method === 'POST') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (/^\/api\/love-spot\/(?:talk\/)?events$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); loveStreams.add(res); req.on('close', () => loveStreams.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    // A route answers with its value, or with { __http: status, error } for a refusal.
    if (routes[url.pathname]) {
      const reply = await routes[url.pathname](raw ? JSON.parse(raw) : null, url);
      if (reply?.__http) { res.statusCode = reply.__http; return json({ error: reply.error }); }
      if (reply?.__asset) { res.writeHead(200, { 'Content-Type': reply.__asset.mimeType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...reply.__asset.headers }); return res.end(reply.__asset.bytes); }
      return json(reply);
    }
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'GPT-6.1-Sol', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }], nextCursor: null });
    if (url.pathname === '/api/providers/claude-accounts') return json({ activeId: '', accounts: [] });
    if (url.pathname === '/api/files') return json({ data: FILES });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : threads.map(item => item.id === 'chat-a' && running ? { ...item, status: { type: 'active' } } : item), nextCursor: null });
    if (chat && url.pathname.endsWith('/resume')) return json({ thread: chat, activeTurnId: running && chat.id === 'chat-a' ? 't4' : null });
    if (chat && url.pathname.endsWith('/rewind')) {
      const body = JSON.parse(raw);
      if (body.action === 'preview') return json({ available: false, reason: 'No file checkpoint for this message.' });
      if (body.action === 'status') return json({ action: rewindAction });
      if (body.action === 'restore') { rewindSaved = turns.map(turn => [...turn]); const at = turns.findIndex(turn => turn[0] === body.beforeTurnId); if (at >= 0) turns.length = at; rewindAction = 'undo'; }
      else if (rewindSaved) { const previous = turns.map(turn => [...turn]); turns.splice(0, turns.length, ...rewindSaved); rewindSaved = previous; rewindAction = body.action === 'undo' ? 'redo' : 'undo'; }
      return json({ rewound: true, undo: rewindAction });
    }
    if (chat && url.pathname.endsWith('/revert')) { const body = JSON.parse(raw); const at = turns.findIndex(turn => turn[0] === body.beforeTurnId); if (at >= 0) turns.length = at; return json({ rewound: true, beforeTurnId: body.beforeTurnId }); }
    if (chat && url.pathname.endsWith('/turns')) return json({ turn: { id: 't-new' } });
    // Recorded media: every item's picture is the same small PNG.
    if (chat && /\/media\/\d+$/.test(url.pathname)) { res.setHeader('content-type', 'image/png'); res.end(PNG); return; }
    if (chat && url.pathname.endsWith('/prompts')) return json({ data: chat.id === 'chat-a' ? turns.map(([turnId, text]) => ({ turnId, text })) : [] });
    if (chat && req.method === 'GET') return json({ thread: chat, data: chat.id === 'chat-a' ? entries().reverse() : [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try {
      const file = path.join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname), content = await fs.readFile(file);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, channel: browserChannel, headless: !process.env.ELPIS_UI_HEADED,
    ignoreDefaultArgs: showScrollbars ? ['--hide-scrollbars'] : undefined });
  const page = await browser.newPage({ viewport: { width, height }, colorScheme }); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await guardDesktopStore(page);
  await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, storage);
  if (desktop) await page.addInitScript(fakeDesktop);
  if (nativeClipboard) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  else await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } }); });
  await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').first().waitFor();
  const deadline = Date.now() + 6000;
  while (streams.size === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (streams.size === 0) throw new Error('The fixture did not connect to /api/events');
  const open = async id => {
    await page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`).click();
    await page.locator(`.thread-row.active[data-thread-id="${id}"]`).waitFor();
    if (id === 'chat-a') await page.getByText(turns.at(-1)[2], { exact: true }).waitFor();
  };
  const shown = () => page.locator('.thread-row.active').first().getAttribute('data-thread-id', { timeout: 400 }).catch(() => null);
  const copied = () => page.evaluate(() => window.__copied);
  /** Sends a bridge event (approval, approvalResolved, message …) to the page, as the bridge's /api/events does. */
  const emit = (event, data) => { for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const close = async () => { await browser.close(); for (const stream of loveStreams) stream.end(); await new Promise(resolve => server.close(resolve)); };
  /** How many pages are listening to /api/events: an event emitted before a pane subscribes never reaches it. */
  const listening = () => streams.size;
  const disconnectEvents = () => { for (const stream of streams) stream.end(); };
  return { page, composer, errors, posts, open, shown, copied, close, turns, emit, listening, disconnectEvents };
}
module.exports = { fixture, CWD, FILES, TURNS };
