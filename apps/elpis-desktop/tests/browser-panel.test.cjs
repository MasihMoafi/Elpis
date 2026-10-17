// The exported UI's browser panel against a scripted desktop browser (the Electron side is faked in the page):
// Annotate, the comment editor, sending comments to the chat with their screenshot sheet, find in page,
// the options menu, "Not secure" and the failure screen. Synthetic HTTP/SSE; no engine or provider calls.
// Screenshots go to $ELPIS_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cjs');
const staticOut = path.join(__dirname, '../out');
const shots = process.env.ELPIS_SHOTS;

async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

// The desktop browser as the renderer sees it: state pushed by "main", commands recorded. A tiny JPEG stands in for page captures.
function fakeDesktop() {
  const tab = { id: 't1', url: 'https://example.com/login', title: 'Example login', loading: false, error: null, failure: null, security: 'secure', zoom: 100, comments: 0, canGoBack: true, canGoForward: false };
  window.__state = { visible: true, activeId: 't1', focusAddress: 0, tabs: [tab], annotating: false, markersVisible: true, annotations: [], draft: null, find: { open: false, text: '', matches: 0, active: 0, focus: 0 } };
  window.__commands = []; window.__layouts = []; const listeners = new Set();
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 180); ctx.strokeStyle = '#2f6fed'; ctx.lineWidth = 3; ctx.strokeRect(40, 60, 120, 40);
  window.__jpeg = canvas.toDataURL('image/jpeg', 0.8);
  window.__push = patch => { window.__state = { ...window.__state, ...patch }; for (const listener of listeners) listener(window.__state); };
  const commands = {
    annotate: data => ({ annotating: data.value === undefined ? !window.__state.annotating : data.value === true }),
    comment: data => { const draft = window.__state.draft; const annotations = [...window.__state.annotations, { id: draft.id, number: window.__state.annotations.length + 1, kind: 'element', label: draft.label, body: data.body.trim() }]; return { draft: null, annotations, tabs: [{ ...window.__state.tabs[0], comments: annotations.length }] }; },
    commentCancel: () => ({ draft: null }),
    annotationsCollect: data => ({ result: { count: window.__state.annotations.length, text: `# Browser comments:\n\n## User Comment 1\nBrowser\nComment:\n${window.__state.annotations[0]?.body}\n`, images: data.value === 'images' ? window.__state.annotations.map(item => ({ number: item.number, dataUrl: window.__jpeg })) : [] } }),
    annotationsSent: () => ({ annotations: [], annotating: false, tabs: [{ ...window.__state.tabs[0], comments: 0 }] }),
    findOpen: () => ({ find: { ...window.__state.find, open: true, focus: window.__state.find.focus + 1 } }),
    find: data => ({ find: { ...window.__state.find, open: true, text: data.text, matches: data.text ? 3 : 0, active: data.text ? 1 : 0 } }),
    findClose: () => ({ find: { ...window.__state.find, open: false } }),
    screenshot: data => ({ result: data.value === 'copy' ? { copied: true } : { image: window.__jpeg } }),
  };
  window.elpisDesktop = {
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), onError: () => () => {} },
    browser: {
      command: async (action, data = {}) => {
        window.__commands.push({ action, ...data });
        const { result, ...patch } = commands[action]?.(data) ?? {};
        if (Object.keys(patch).length) window.__push(patch);
        return { ...window.__state, ...(result ? { result } : {}) };
      },
      layout: value => window.__layouts.push(value),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
}

async function fixture(t) {
  const streams = new Set(), posts = [], errors = [];
  const thread = { id: 'a', name: 'Chat A', cwd: '/tmp/browser-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : {}; posts.push({ path: pathname, body });
      if (pathname === '/api/threads') return json({ thread: { ...thread, id: 'fresh', name: 'New chat' } });
      if (/\/resume$/.test(pathname)) return json({ thread, activeTurnId: null });
      if (/\/turns$/.test(pathname)) return json({ turn: { id: 'turn-1' } });
      return json({});
    }
    if (pathname === '/api/health') return json({ connected: true, cwd: '/tmp/browser-fixture' });
    if (pathname === '/api/threads') return json({ data: [thread], nextCursor: null });
    if (pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol', inputModalities: ['text', 'image'] }], nextCursor: null });
    if (pathname === '/api/settings') return json({ version: 'v1', main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], write: { available: true }, background: { model: 'sol', provider: 'openai' }, memory: { generate: true, use: true, extractionModel: 'sol', consolidationModel: null } });
    if (pathname === '/api/providers') return json({ openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'fixture@example.invalid' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] });
    if (pathname.startsWith('/api/')) return json({});
    const file = path.join(staticOut, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ELPIS_CHROMIUM || undefined });
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
  page.setDefaultTimeout(4000); page.on('pageerror', error => errors.push(error.message));
  await guardDesktopStore(page);
  await page.addInitScript(fakeDesktop);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: 'Annotate this page' }).waitFor();
  const commands = () => page.evaluate(() => window.__commands.map(item => item.action));
  const shoot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  return { page, posts, errors, commands, shoot };
}

test('Annotate: the editor takes a comment and Send gives the chat the comments and one screenshot sheet', async t => {
  const { page, posts, errors, commands, shoot } = await fixture(t);
  const annotate = page.getByRole('button', { name: 'Annotate this page' });
  assert.equal(await annotate.getAttribute('aria-pressed'), 'false');
  await annotate.click();
  assert.equal(await annotate.getAttribute('aria-pressed'), 'true');
  await page.getByText('Click anything on the page to comment on it').waitFor();
  await shoot('elpis-annotate-mode');
  await page.evaluate(() => window.__push({ draft: { id: 'p1', number: 1, kind: 'element', label: 'button “Sign in”', body: '', editing: false } }));
  const comment = page.getByRole('textbox', { name: 'Comment', exact: true });
  await eventually(async () => assert.equal(await comment.evaluate(element => element === document.activeElement), true, 'a new selection puts the cursor in the comment'));
  assert.equal((await page.locator('.annotation-target').innerText()).replace(/\s+/g, ' '), '1 button “Sign in”');
  await comment.fill('Make this the accent colour');
  await shoot('elpis-annotate-editor');
  await comment.press('Enter');
  await eventually(async () => assert.deepEqual((await page.evaluate(() => window.__commands)).filter(item => item.action === 'comment'), [{ action: 'comment', body: 'Make this the accent colour' }]));
  const send = page.getByRole('button', { name: 'Send 1 pending annotation' });
  await send.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Edit comment 1: button “Sign in”' }).count(), 1);
  await shoot('elpis-annotate-pending');
  await send.click();
  await eventually(async () => assert.ok((await commands()).includes('annotationsSent'), 'comments are cleared only after the chat took them'));
  const turn = posts.find(post => /\/turns$/.test(post.path));
  assert.ok(turn, 'Send sends the message');
  const [text, image] = turn.body.attachments;
  assert.equal(text.name, 'Browser comments'); assert.match(text.text, /^# Browser comments:/);
  assert.equal(image.name, 'Browser comments.jpg'); assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok((await commands()).indexOf('annotationsCollect') < (await commands()).indexOf('annotationsSent'));
  assert.deepEqual(errors, []);
});

test('find bar, options menu, Not secure, zoom and the failure screen', async t => {
  const { page, errors, commands, shoot } = await fixture(t);
  await page.evaluate(() => window.__push({ tabs: [{ ...window.__state.tabs[0], url: 'http://example.com/', security: 'insecure', zoom: 125 }] }));
  await page.getByText('Not secure').waitFor();
  await page.getByRole('button', { name: '125%' }).click();
  assert.deepEqual((await page.evaluate(() => window.__commands)).at(-1), { action: 'zoom', value: 'reset' });

  await page.getByRole('tab', { name: 'Example login' }).click({ button: 'right' });
  for (const name of ['Reload', 'Duplicate', 'Copy URL', 'Open in external browser', 'Close tab']) await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).waitFor();
  await page.getByRole('menuitem', { name: 'Copy URL' }).click();
  assert.deepEqual((await page.evaluate(() => window.__commands)).at(-1), { action: 'copyUrl', id: 't1' });

  await page.getByRole('button', { name: 'Browser options' }).click();
  for (const name of ['Find in page', 'Print', 'Take a screenshot', 'Add a screenshot to your message', 'Force reload', 'Developer tools', 'Clear cookies', 'Clear cache']) await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).waitFor();
  await eventually(async () => assert.equal((await page.evaluate(() => window.__layouts.at(-1))).obscured, true, 'the native page hides under the menu'));
  await shoot('elpis-browser-options');
  await page.getByRole('menuitem', { name: 'Take a screenshot' }).click();
  await page.getByText('Screenshot saved to clipboard').waitFor();

  await page.getByRole('button', { name: 'Browser options' }).click();
  await page.getByRole('menuitem', { name: /^Find in page/ }).click();
  const find = page.getByRole('textbox', { name: 'Find in page' });
  await eventually(async () => assert.equal(await find.evaluate(element => element === document.activeElement), true));
  await find.fill('cache');
  await page.getByText('1 of 3').waitFor();
  await find.press('Shift+Enter');
  assert.deepEqual((await page.evaluate(() => window.__commands)).at(-1), { action: 'find', text: 'cache', value: 'previous' });
  await shoot('elpis-browser-find');
  await find.press('Escape');
  assert.ok((await commands()).includes('findClose'));

  await page.evaluate(() => window.__push({ tabs: [{ ...window.__state.tabs[0], url: 'http://localhost:3000/', security: 'local', zoom: 100, error: 'ERR_CONNECTION_REFUSED',
    failure: { heading: "This site can't be reached", summary: 'localhost refused to connect', tips: ['Checking that the development server is running on this port', 'Checking the connection'], code: 'ERR_CONNECTION_REFUSED' } }] }));
  await page.getByRole('heading', { name: "This site can't be reached" }).waitFor();
  assert.equal(await page.locator('.browser-error').count(), 0, 'the one-line error gives way to the explanation');
  await eventually(async () => assert.equal((await page.evaluate(() => window.__layouts.at(-1))).obscured, true, 'Chromium\'s blank error page is hidden'));
  await shoot('elpis-browser-failure');
  await page.locator('.browser-failure').getByRole('button', { name: 'Reload' }).click();
  assert.equal((await commands()).at(-1), 'reload');
  assert.deepEqual(errors, []);
});
