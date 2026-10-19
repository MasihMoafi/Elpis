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
// With `scoped`, each chat has its own browser, as the real preload's (sessionScoped): "session" shows that chat's.
function fakeDesktop(scoped = false) {
  const tab = { id: 't1', url: 'https://example.com/login', title: 'Example login', loading: false, error: null, failure: null, security: 'secure', zoom: 100, comments: 0, canGoBack: true, canGoForward: false };
  const fresh = sessionId => ({ visible: true, activeId: 't1', focusAddress: 0, tabs: [tab], annotating: false, markersVisible: true, annotations: [], draft: null, find: { open: false, text: '', matches: 0, active: 0, focus: 0 }, ...(scoped ? { sessionId } : {}) });
  const sessions = new Map();
  window.__state = fresh(null);
  window.__commands = []; window.__layouts = []; window.__themes = []; const listeners = new Set();
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 180); ctx.strokeStyle = '#2f6fed'; ctx.lineWidth = 3; ctx.strokeRect(40, 60, 120, 40);
  window.__jpeg = canvas.toDataURL('image/jpeg', 0.8);
  window.__push = patch => { window.__state = { ...window.__state, ...patch }; for (const listener of listeners) listener(window.__state); };
  const commands = {
    session: data => { sessions.set(window.__state.sessionId, window.__state); window.__state = sessions.get(data.sessionId) ?? fresh(data.sessionId); return {}; },
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
    setTheme: (dark, details) => window.__themes.push({ dark, ...details }),
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), onError: () => () => {} },
    browser: {
      ...(scoped ? { sessionScoped: true } : {}),
      command: async (action, data = {}) => {
        window.__commands.push({ action, ...data });
        if (scoped && action !== 'session' && data.sessionId !== window.__state.sessionId) return { error: 'This browser session is no longer shown.' };
        const { result, ...patch } = commands[action]?.(data) ?? {};
        if (Object.keys(patch).length) window.__push(patch);
        return { ...window.__state, ...(result ? { result } : {}) };
      },
      layout: value => window.__layouts.push(value),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
}

async function fixture(t, { running = false, scoped = false, hold = null } = {}) {
  const streams = new Set(), posts = [], errors = [];
  const thread = { id: 'a', name: 'Chat A', cwd: '/tmp/browser-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : {}; posts.push({ path: pathname, body });
      if (pathname === '/api/threads') return json({ thread: { ...thread, id: 'fresh', name: 'New chat' } });
      if (/\/resume$/.test(pathname)) return json({ thread: running ? { ...thread, status: { type: 'active', activeFlags: [] } } : thread, activeTurnId: running ? 'turn-0' : null });
      if (/\/steer$/.test(pathname)) return json({ turnId: 'turn-0' });
      if (/\/turns$/.test(pathname)) {
        if (hold && await hold() === 'fail') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'The engine is unavailable.' })); }
        return json({ turn: { id: `turn-${posts.length}` } });
      }
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
  await page.addInitScript(fakeDesktop, scoped);
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

test('A21: Send clears the message and its comments before the server answers, and the next Send carries only its own comments', async t => {
  let release; const gate = () => new Promise(resolve => { release = resolve; });
  let waiting = gate();
  const { page, posts, errors } = await fixture(t, { hold: () => waiting });
  const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  const cards = page.locator('.composer').getByRole('list', { name: 'Message attachments', exact: true }).getByRole('listitem');
  const turns = () => posts.filter(post => /\/(turns|steer)$/.test(post.path));
  const comment = body => page.evaluate(body => window.__push({ annotating: true, annotations: [{ id: body, number: 1, kind: 'element', label: 'link', body }] }), body);
  await input.fill('make it Elpis like');
  await comment('first comment');
  await page.getByRole('button', { name: 'Send 1 pending annotation' }).click();
  await eventually(async () => assert.equal(turns().length, 1));
  assert.equal(await input.inputValue(), '', 'the text leaves the composer at once (R2)');
  assert.equal(await cards.count(), 0, 'the comment cards leave the composer at once (R2)');
  release(); waiting = Promise.resolve();
  await page.waitForTimeout(300);
  assert.equal(await input.inputValue(), ''); assert.equal(await cards.count(), 0);
  await input.fill('second');
  await comment('second comment');
  await page.getByRole('button', { name: 'Send 1 pending annotation' }).click();
  await eventually(async () => assert.equal(turns().length, 2));
  const second = turns()[1].body;
  assert.equal(second.text, 'second');
  assert.deepEqual(second.attachments.filter(part => part.type === 'text').map(part => part.text.match(/Comment:\n(.*)/)[1]), ['second comment'], 'only this Send’s comments');
  assert.deepEqual(errors, []);
});

test('A21: a Send that fails puts the message and its comments back in the composer', async t => {
  const { page, posts, errors } = await fixture(t, { hold: async () => 'fail' });
  const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  const cards = page.locator('.composer').getByRole('list', { name: 'Message attachments', exact: true }).getByRole('listitem');
  await input.fill('keep me');
  await page.evaluate(() => window.__push({ annotating: true, annotations: [{ id: 'c1', number: 1, kind: 'element', label: 'link', body: 'kept comment' }] }));
  await page.getByRole('button', { name: 'Send 1 pending annotation' }).click();
  await eventually(async () => assert.equal(posts.filter(post => /\/turns$/.test(post.path)).length, 1));
  await eventually(async () => assert.equal(await input.inputValue(), 'keep me'));
  assert.ok(await cards.count() >= 1, 'the comment cards come back');
  await page.getByText('The engine is unavailable.').first().waitFor();
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

test('the page area follows the app theme: the app background, never white, and the desktop is told dark, the choice and the colour', async t => {
  const { page, errors } = await fixture(t);
  const look = () => page.evaluate(() => ({ viewport: getComputedStyle(document.querySelector('.browser-viewport')).backgroundColor, body: getComputedStyle(document.body).backgroundColor,
    dark: document.documentElement.classList.contains('dark'), reported: window.__themes.at(-1) }));
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await eventually(async () => {
      const seen = await look();
      assert.equal(seen.dark, scheme === 'dark');
      assert.notEqual(seen.viewport, 'rgb(255, 255, 255)', `${scheme}: the page area is not white`);
      assert.equal(seen.viewport, seen.body, `${scheme}: the page area is the app background`);
      assert.deepEqual(seen.reported, { dark: scheme === 'dark', source: 'system', background: seen.body });
    });
  }
  await page.evaluate(() => localStorage.setItem('elpis-theme', 'dark')); await page.reload();
  await page.getByRole('button', { name: 'Annotate this page' }).waitFor();
  await eventually(async () => { const seen = await look(); assert.deepEqual(seen.reported, { dark: true, source: 'dark', background: seen.body }, 'an explicit choice is reported as the choice, whatever the system says'); });
  assert.deepEqual(errors, []);
});

for (const running of [false, true]) test(`Annotate in an open chat${running ? ' while its turn runs' : ''}: Send adds the comments to that chat, not a new conversation (A16)`, async t => {
  const { page, posts, errors } = await fixture(t, { running });
  await page.locator('.thread-row[data-thread-id="a"] .thread-link').click();
  await page.locator('.thread-row.active[data-thread-id="a"]').waitFor();
  await page.getByRole('button', { name: 'Annotate this page' }).click();
  await page.evaluate(() => window.__push({ draft: { id: 'p1', number: 1, kind: 'element', label: 'button “Sign in”', body: '', editing: false } }));
  const comment = page.getByRole('textbox', { name: 'Comment', exact: true });
  await comment.fill('Make this the accent colour'); await comment.press('Enter');
  await page.getByRole('button', { name: 'Send 1 pending annotation' }).click();
  const sent = () => posts.filter(post => /\/(turns|steer)$/.test(post.path) || post.path === '/api/threads').map(post => post.path);
  await eventually(async () => assert.ok(sent().length, 'Send sends the message'));
  assert.equal(sent().length, 1); assert.match(sent()[0], /^\/api\/threads\/a\/(turns|steer)$/, 'the comments go to chat A, not a new conversation');
  assert.equal(await page.locator('.thread-row.active[data-thread-id="a"]').count(), 1, 'chat A stays the open chat');
  assert.deepEqual(errors, []);
});

test('Comments made in a chat\'s browser stay with that chat: a new chat tab has its own browser, and Send back in the chat goes to it (A16)', async t => {
  const { page, posts, errors } = await fixture(t, { scoped: true });
  await page.locator('.thread-row[data-thread-id="a"] .thread-link').click();
  await page.locator('.thread-row.active[data-thread-id="a"]').waitFor();
  await page.getByRole('button', { name: 'Annotate this page' }).click();
  await eventually(async () => assert.equal(await page.evaluate(() => window.__state.annotating), true));
  await page.evaluate(() => window.__push({ draft: { id: 'p1', number: 1, kind: 'element', label: 'button “Sign in”', body: '', editing: false } }));
  const comment = page.getByRole('textbox', { name: 'Comment', exact: true });
  await comment.fill('Make this the accent colour'); await comment.press('Enter');
  const send = page.getByRole('button', { name: 'Send 1 pending annotation' });
  await send.waitFor();
  await page.getByRole('button', { name: 'New chat tab', exact: true }).click();
  await send.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: /Chat A/ }).click();
  await page.locator('.thread-row.active[data-thread-id="a"]').waitFor();
  await send.click();
  const sent = () => posts.filter(post => /\/(turns|steer)$/.test(post.path) || post.path === '/api/threads').map(post => post.path);
  await eventually(async () => assert.ok(sent().length, 'Send sends the message'));
  assert.deepEqual(sent(), ['/api/threads/a/turns'], 'the comments go to chat A, not a new conversation');
  assert.deepEqual(errors, []);
});
