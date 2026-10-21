const { guardDesktopStore, leaveSettings, sidebar, openSettings } = require('./controls.cjs');
// Real exported UI with synthetic transfer events. Never reads/writes the system clipboard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const staticOut = process.env.ELPIS_COMPOSER_TEST_OUT || path.join(__dirname, '../out');

async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

async function fixture(t, options = {}) {
  const streams = new Set(), posts = [], errors = [];
  const control = { fail: false, hold: false, release: null, pdfFail: false, partialFork: false, mediaDataUrl: '' };
  const threads = new Map(['a', 'b', 'agent', 'fork'].map(id => [id, { id, name: id === 'agent' ? 'Parent-owned agent' : `Chat ${id.toUpperCase()}`, cwd: '/tmp/composer-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, ...(id === 'agent' ? { parentThreadId: 'a', desktopAccess: { mode: 'continue' } } : {}) }]));
  const emit = (method, params) => { for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const settings = { version: 'fixture-v1', main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], write: { available: true }, background: { model: 'sol', provider: 'openai' }, memory: { generate: true, use: true, extractionModel: 'sol', consolidationModel: null }, smartPrune: { enabled: true, explicitOverride: { available: false } } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : {}; posts.push({ path: pathname, body });
      if (pathname === '/api/attachments/extract') { if (control.pdfFail) { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'This PDF has no extractable text.' })); } return json({ attachment: { id: 'pdf-snapshot', name: body.name, type: 'text', mimeType: 'text/plain', text: 'Extracted PDF text' } }); }
      if (pathname === '/api/threads') { const thread = { ...threads.get('a'), id: 'fresh', name: 'New chat' }; threads.set(thread.id, thread); return json({ thread }); }
      const action = /^\/api\/threads\/([^/]+)\/(resume|turns|steer)$/.exec(pathname);
      if (action) {
        const thread = threads.get(action[1]);
        if (action[2] === 'resume') return json({ thread, activeTurnId: null });
        if (control.hold) await new Promise(resolve => { control.release = resolve; });
        if (control.fail) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Synthetic send failed' })); }
        if (control.partialFork && action[1] === 'agent') return json({ thread: threads.get('fork'), continuedFrom: 'agent', sendError: 'The follow-up chat was created, but sending failed.' });
        const turn = { id: `turn-${posts.length}` }; json({ turn }); setTimeout(() => emit('turn/completed', { threadId: action[1], turn: { ...turn, status: 'completed' } }), 20); return;
      }
      return json({});
    }
    if (pathname === '/api/health') return json({ connected: true, cwd: '/tmp/composer-fixture' });
    if (pathname === '/api/threads') return json({ data: [...threads.values()], nextCursor: null });
    if (pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol', inputModalities: options.textOnly ? ['text'] : ['text', 'image'] }], nextCursor: null });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/providers') return json({ openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'fixture@example.invalid' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] });
    if (pathname === '/api/providers/settings') return json({ version: 'fixture-v1', write: { available: false }, managed: {}, providers: [] });
    if (pathname === '/api/mcp') return json({ version: 'fixture-v1', write: { available: false }, servers: [] });
    if (pathname === '/api/tools/transcription') return json({ available: false, reason: 'Dictation is not configured.' });
    const read = /^\/api\/threads\/([^/]+)$/.exec(pathname);
    if (read) {
      const contents = 'Recorded text snapshot.\nمتن ذخیره‌شده', name = 'recorded-notes.md';
      const content = [{ type: 'text', text: `File: ${name}\n${contents}`, textElements: [{ byteRange: { start: 0, end: Buffer.byteLength(`File: ${name}\n${contents}`) }, placeholder: `Attachment: ${name}` }] }, { type: 'image', url: control.mediaDataUrl }, { type: 'localImage', path: '/fixture/recorded-page.png' }, { type: 'localAudio', path: '/fixture/recorded-voice.wav' }, { type: 'image', url: 'https://media.example.invalid/recorded.png' }];
      return json({ thread: threads.get(read[1]), data: control.mediaDataUrl ? [{ turnId: 'recorded-turn', item: { id: 'recorded-user', type: 'userMessage', content } }] : [], nextCursor: null });
    }
    if (/\/media\/[0-9]+$/.test(pathname)) {
      const audio = pathname.endsWith('/3');
      const bytes = audio ? Buffer.alloc(46) : Buffer.from(control.mediaDataUrl.split(',')[1], 'base64');
      if (audio) { bytes.write('RIFF', 0); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40); }
      res.writeHead(200, { 'Content-Type': audio ? 'audio/wav' : 'image/png' }); return res.end(bytes);
    }
    if (pathname.startsWith('/api/')) return json({});
    const file = path.join(staticOut, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { control.release?.(); await browser?.close(); for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ELPIS_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(4000); page.on('pageerror', error => errors.push(error.message));
  await guardDesktopStore(page);
  await page.addInitScript(() => { window.elpisDesktop = { storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), onError: () => () => {} } }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await eventually(async () => assert.equal(await input.isEnabled(), true));
  const initialUrl = page.url(); let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  return { page, input, initialUrl, control, get navigations() { return navigations; }, posts, errors };
}

async function transfer(view, kind, { text = '', file, target = 'input' } = {}) {
  await view.input.focus();
  const result = await view.page.evaluate(async ({ kind, text, file, target }) => {
    const input = document.querySelector('textarea[aria-label="Message Elpis"]'), data = new DataTransfer();
    const eventTarget = target === 'composer' ? input.closest('.composer') : input;
    input.setSelectionRange(input.value.length, input.value.length);
    if (text) data.setData('text/plain', text);
    if (file === 'image') {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; const context = canvas.getContext('2d'); context.fillStyle = '#7450d7'; context.fillRect(0, 0, 64, 64); context.fillStyle = 'white'; context.font = '15px sans-serif'; context.fillText('Book', 13, 37);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      data.items.add(new File([blob], 'pasted-image.png', { type: 'image/png' }));
    } else if (file === 'document') data.items.add(new File(['synthetic fixture contents'], 'brief.pdf', { type: 'application/pdf' }));
    let dragOverPrevented = false;
    if (kind === 'drop') { const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }); eventTarget.dispatchEvent(over); dragOverPrevented = over.defaultPrevented; }
    const event = kind === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    eventTarget.dispatchEvent(event);
    return { prevented: event.defaultPrevented, dragOverPrevented, text: data.getData('text/plain'), files: [...data.files].map(item => ({ name: item.name, type: item.type })) };
  }, { kind, text, file, target });
  // Untrusted transfer events do not perform default editing. Apply that editing explicitly,
  // after proving the app left the text event alone; this never touches an OS clipboard.
  if (!result.prevented && result.text && (kind === 'paste' || !file)) await view.page.keyboard.insertText(result.text);
  return result;
}

const attachments = view => view.page.locator('.composer').getByRole('list', { name: 'Message attachments', exact: true });
const sends = view => view.posts.filter(post => /\/(turns|steer)$/.test(post.path));
async function openChat(view, name) { await leaveSettings(view.page); await view.page.locator('.thread-row .thread-link').filter({ hasText: name }).click(); await eventually(async () => assert.equal(await view.input.isEnabled(), true)); }
async function visibleFile(view, name) { try { await eventually(async () => assert.equal(await attachments(view).getByRole('button', { name: `Remove ${name}`, exact: true }).count(), 1)); } catch (error) { console.error('Attachment fixture diagnostic', await view.page.evaluate(() => ({ lastChat: localStorage.getItem('elpis-last-chat'), storage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)?.slice(0, 400)])), body: document.body.innerText.slice(-1800) }))); throw error; } }
async function noSend(view) { assert.equal(sends(view).length, 0); assert.deepEqual(view.errors, []); }

test('ordinary text paste and drop remain uncancelled and editable without attachments', async t => {
  const view = await fixture(t); await view.input.fill('Draft');
  const pasted = await transfer(view, 'paste', { text: ' plus pasted text' });
  assert.equal(pasted.prevented, false); await eventually(async () => assert.equal(await view.input.inputValue(), 'Draft plus pasted text'));
  await view.input.fill('Draft'); const dropped = await transfer(view, 'drop', { text: ' plus dropped text' });
  assert.equal(dropped.prevented, false); assert.equal(dropped.dragOverPrevented, false);
  await eventually(async () => assert.equal(await view.input.inputValue(), 'Draft plus dropped text'));
  assert.equal(await attachments(view).count(), 0); await noSend(view);
});

test('image-only paste previews a real attachment and sends its exact bytes without message text', async t => {
  const view = await fixture(t); const pasted = await transfer(view, 'paste', { file: 'image' });
  await visibleFile(view, 'pasted-image.png'); assert.equal(pasted.files[0].type, 'image/png');
  assert.equal(await view.input.inputValue(), ''); await noSend(view);
  const image = attachments(view).getByRole('img', { name: 'pasted-image.png', exact: true });
  const dataUrl = await image.getAttribute('src'); assert.match(dataUrl, /^data:image\/png;base64,/);
  if (process.env.ELPIS_COMPOSER_SHOTS) {
    await view.page.emulateMedia({ colorScheme: 'light' });
    await view.page.screenshot({ path: path.join(process.env.ELPIS_COMPOSER_SHOTS, 'attachments-light-wide.png') });
    await view.page.setViewportSize({ width: 390, height: 900 });
    await view.page.screenshot({ path: path.join(process.env.ELPIS_COMPOSER_SHOTS, 'attachments-light-narrow.png') });
    await view.page.emulateMedia({ colorScheme: 'dark' });
    await eventually(async () => assert.equal(await view.page.evaluate(() => document.documentElement.classList.contains('dark')), true));
    await view.page.screenshot({ path: path.join(process.env.ELPIS_COMPOSER_SHOTS, 'attachments-dark-narrow.png') });
    assert.equal(await view.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await view.page.setViewportSize({ width: 1280, height: 900 });
  }
  await view.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await eventually(async () => assert.equal(sends(view).length, 1));
  assert.equal(sends(view)[0].body.text, ''); assert.equal(sends(view)[0].body.attachments[0].dataUrl, dataUrl);
  await eventually(async () => assert.equal(await attachments(view).count(), 0)); assert.deepEqual(view.errors, []);
});

test('PDF drop on the composer cancels navigation and attaches only the extracted text snapshot', async t => {
  const view = await fixture(t); await view.input.fill('Keep this document question');
  const dropped = await transfer(view, 'drop', { file: 'document', text: 'File metadata must not replace draft', target: 'composer' });
  assert.equal(dropped.prevented, true); assert.equal(dropped.dragOverPrevented, true);
  await visibleFile(view, 'brief.pdf'); assert.equal(await view.input.inputValue(), 'Keep this document question'); await noSend(view);
  assert.equal(view.page.url(), view.initialUrl); assert.equal(view.navigations, 0);
  assert.equal(view.posts.find(post => post.path === '/api/attachments/extract').body.mimeType, 'application/pdf');
  await view.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await eventually(async () => assert.equal(sends(view).length, 1));
  assert.equal(sends(view)[0].body.attachments[0].text, 'Extracted PDF text'); assert.equal(sends(view)[0].body.attachments[0].type, 'text');
});

test('mixed clipboard text and image keeps ordinary text insertion and adds the image', async t => {
  const view = await fixture(t); await view.input.fill('Draft');
  const pasted = await transfer(view, 'paste', { text: ' plus clipboard text', file: 'image' });
  assert.equal(pasted.prevented, false); await visibleFile(view, 'pasted-image.png');
  await eventually(async () => assert.equal(await view.input.inputValue(), 'Draft plus clipboard text')); await noSend(view);
});

test('attachment drafts survive settings, chat switches, reload and failed send; acknowledgement clears only that chat', async t => {
  const view = await fixture(t);
  let remoteRequests = 0; await view.page.route('https://media.example.invalid/**', route => { remoteRequests++; return route.abort(); });
  view.control.mediaDataUrl = await view.page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100; const context = canvas.getContext('2d'); context.fillStyle = '#355e91'; context.fillRect(0, 0, 160, 100); context.fillStyle = 'white'; context.font = '18px sans-serif'; context.fillText('Book page', 30, 55); return canvas.toDataURL('image/png'); });
  await openChat(view, 'Chat A');
  await view.page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'notes-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Exact first line\nمتن فارسی') });
  await visibleFile(view, 'notes-a.md'); await openSettings(view.page);
  await openChat(view, 'Chat B'); assert.equal(await attachments(view).count(), 0);
  await view.page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'notes-b.txt', mimeType: 'text/plain', buffer: Buffer.from('B private draft') });
  await visibleFile(view, 'notes-b.txt'); await openChat(view, 'Chat A'); await visibleFile(view, 'notes-a.md');
  await view.page.reload(); await visibleFile(view, 'notes-a.md');
  const ownedImage = view.page.locator('img[src="/api/threads/a/turns/recorded-turn/items/recorded-user/media/2"]');
  await eventually(async () => assert.equal(await ownedImage.evaluate(image => image.complete && image.naturalWidth === 160), true));
  const audio = view.page.locator('audio'); assert.equal(await audio.getAttribute('preload'), 'none'); assert.equal(await audio.getAttribute('autoplay'), null);
  await view.page.getByText('recorded-notes.md', { exact: true }).click();
  assert.equal(await view.page.getByRole('link', { name: /Open image/i }).count(), 1); assert.equal(remoteRequests, 0);
  if (process.env.ELPIS_COMPOSER_SHOTS) {
    await view.page.emulateMedia({ colorScheme: 'light' });
    await view.page.screenshot({ path: path.join(process.env.ELPIS_COMPOSER_SHOTS, 'attachments-history-light.png') });
    await view.page.setViewportSize({ width: 390, height: 900 }); await view.page.emulateMedia({ colorScheme: 'dark' });
    await eventually(async () => assert.equal(await view.page.evaluate(() => document.documentElement.classList.contains('dark')), true));
    await view.page.screenshot({ path: path.join(process.env.ELPIS_COMPOSER_SHOTS, 'attachments-history-dark-narrow.png') });
    assert.equal(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await view.page.setViewportSize({ width: 1280, height: 900 });
  }
  view.control.fail = true; await view.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await eventually(async () => assert.equal(await view.page.getByRole('alert').filter({ hasText: 'Synthetic send failed' }).count(), 1)); await visibleFile(view, 'notes-a.md');
  view.control.fail = false; await view.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await eventually(async () => assert.equal(await attachments(view).count(), 0));
  assert.equal(sends(view)[0].body.attachments[0].text, 'Exact first line\nمتن فارسی');
  await openChat(view, 'Chat B'); await visibleFile(view, 'notes-b.txt'); assert.deepEqual(view.errors, []);
});

test('pending acknowledgement keeps later attachment additions and unrelated chat drafts', async t => {
  const view = await fixture(t); await openChat(view, 'Chat A'); await transfer(view, 'paste', { file: 'image' }); await visibleFile(view, 'pasted-image.png');
  view.control.hold = true; await view.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await eventually(() => assert.equal(sends(view).length, 1));
  await view.page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'later.txt', mimeType: 'text/plain', buffer: Buffer.from('Later unsent addition') }); await visibleFile(view, 'later.txt');
  await openChat(view, 'Chat B'); await view.input.fill('B text stays'); view.control.release();
  await eventually(async () => assert.equal(await view.input.inputValue(), 'B text stays')); await openChat(view, 'Chat A'); await visibleFile(view, 'later.txt');
  assert.equal(await attachments(view).getByRole('button', { name: 'Remove pasted-image.png' }).count(), 0); assert.deepEqual(view.errors, []);
});

test('known text-only model blocks images without discarding them; unsupported files and failed PDFs show errors', async t => {
  const view = await fixture(t, { textOnly: true }); await transfer(view, 'paste', { file: 'image' }); await visibleFile(view, 'pasted-image.png');
  assert.equal(await view.page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  assert.match(await view.page.locator('.composer [role="alert"]').innerText(), /text only/i); await noSend(view);
  // Every notice about files is one element in one style: this one, a file that is not supported, a failed PDF.
  const alertLook = () => view.page.locator('.composer [role="alert"]').evaluate(node => ({ tag: node.tagName, cls: node.className, margin: getComputedStyle(node).margin, padding: getComputedStyle(node).padding, color: getComputedStyle(node).color, size: getComputedStyle(node).fontSize }));
  const textOnlyLook = await alertLook();
  await attachments(view).getByRole('button', { name: 'Remove pasted-image.png' }).click();
  await view.input.fill('Keep draft'); await view.page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from('binary') });
  await eventually(async () => assert.match(await view.page.locator('.composer [role="alert"]').innerText(), /choose.*text file/i));
  assert.deepEqual(await alertLook(), textOnlyLook, 'a text-only model\'s notice looks like a file notice');
  view.control.pdfFail = true; await transfer(view, 'drop', { file: 'document' });
  await eventually(async () => assert.match(await view.page.locator('.composer [role="alert"]').innerText(), /no extractable text/i));
  assert.equal(await view.input.inputValue(), 'Keep draft'); assert.equal(await attachments(view).count(), 0); await noSend(view);
});

test('failed parent-owned follow-up moves exact attachments into acknowledged fork and keeps existing fork draft separate', async t => {
  const view = await fixture(t); await openChat(view, 'Chat FORK');
  await view.page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'fork-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Existing fork draft') }); await visibleFile(view, 'fork-draft.txt');
  await openChat(view, 'Chat A'); await view.page.getByRole('button', { name: 'Observability', exact: true }).click();
  await view.page.getByRole('button', { name: 'Parent-owned agent', exact: true }).first().click();
  await eventually(async () => assert.match(await view.input.getAttribute('placeholder'), /Parent-owned agent/));
  await transfer(view, 'paste', { file: 'image' }); await visibleFile(view, 'pasted-image.png'); view.control.partialFork = true;
  await view.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await eventually(async () => assert.equal(await view.page.getByText('Recover unsent message', { exact: true }).count(), 1));
  await visibleFile(view, 'fork-draft.txt'); await view.page.getByText('Recover unsent message', { exact: true }).click();
  assert.match(await view.page.locator('.error-banner').filter({ hasText: 'Recover unsent message' }).innerText(), /pasted-image.png/);
  assert.equal(await view.page.getByRole('button', { name: 'Use in composer', exact: true }).isDisabled(), true);
  await attachments(view).getByRole('button', { name: 'Remove fork-draft.txt' }).click();
  await view.page.getByRole('button', { name: 'Use in composer', exact: true }).click(); await visibleFile(view, 'pasted-image.png');
  assert.equal(await view.page.getByText('Recover unsent message', { exact: true }).count(), 0); assert.deepEqual(view.errors, []);
});
