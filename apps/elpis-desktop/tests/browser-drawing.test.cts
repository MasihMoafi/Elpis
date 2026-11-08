// The built-in browser's Draw button against the exported UI and the real Excalidraw editor. The Electron side is faked
// in the page (a scripted screenshot command, recorded layouts); the chat endpoints are synthetic. No model is called.
// Screenshots go to $ELPIS_SHOTS when it is set.
import type { Page } from 'playwright-core';
import type { TestContext } from 'node:test';
import type { BrowserState, BrowserTab } from '../lib/desktop.ts';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { chromium }: typeof import('playwright-core') = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore, widenSidePanel }: { guardDesktopStore(target: Page): Promise<void>; widenSidePanel(page: Page, width: number): Promise<void> } = require('./controls.cts');
type DrawingWindow = typeof window & { __state: BrowserState; __log: string[]; __shot: string; __jpeg: string; EXCALIDRAW_ASSET_PATH?: string };
type Attachment = { name: string; text: string; dataUrl: string };
const staticOut = process.env.ELPIS_TEST_OUT || path.join(__dirname, '../out');
const shots = process.env.ELPIS_SHOTS;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHsKbOQAAAABJRU5ErkJggg==', 'base64');

async function eventually(check: () => unknown | Promise<unknown>, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

// A page tab, and a captured screenshot that is plainly green so marks drawn over it can be told apart.
function fakeDesktop() {
  const target = window as DrawingWindow;
  const tab: BrowserTab = { id: 't1', url: 'https://example.com/pricing', title: 'Example pricing', loading: false, error: null, failure: null, security: 'secure', zoom: 100, comments: 0, canGoBack: false, canGoForward: false };
  target.__state = { visible: true, activeId: 't1', focusAddress: 0, tabs: [tab], annotating: false, markersVisible: true, annotations: [], draft: null, find: { open: false, text: '', matches: 0, active: 0, focus: 0 } };
  target.__log = []; target.__shot = 'ok'; const listeners = new Set();
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500;
  const ctx = canvas.getContext('2d'); if (!ctx) throw Error('Canvas context missing'); ctx.fillStyle = '#20a060'; ctx.fillRect(0, 0, 800, 500); ctx.fillStyle = '#fff'; ctx.fillRect(40, 40, 200, 60);
  target.__jpeg = canvas.toDataURL('image/jpeg', 0.9);
  window.elpisDesktop = {
    setTheme: () => {},
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), onError: () => () => {} },
    browser: {
      command: async action => {
        target.__log.push(action);
        if (action === 'screenshot') { if (target.__shot === 'throw') throw new Error('The page has no visible view.'); return { ...target.__state, result: target.__shot === 'empty' ? {} : { image: target.__jpeg } }; }
        return target.__state;
      },
      layout: value => target.__log.push(value.obscured ? 'obscured' : 'visible'),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
}

async function fixture(t: TestContext, { colorScheme = 'light', width = 1320, height = 860, images = true }: { colorScheme?: 'light' | 'dark'; width?: number; height?: number; images?: boolean } = {}) {
  const posts: { path: string; body: { attachments: Attachment[] } }[] = [], errors: string[] = [], scripts: string[] = [];
  const thread = { id: 'a', name: 'Chat A', cwd: '/tmp/browser-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } };
  const server = http.createServer((req, res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://fixture'), pathname = url.pathname;
    const json = (data: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk; posts.push({ path: pathname, body: raw ? JSON.parse(raw) : {} });
      if (pathname === '/api/threads') return json({ thread: { ...thread, id: 'fresh', name: 'New chat' } });
      if (/\/resume$/.test(pathname)) return json({ thread, activeTurnId: null });
      if (/\/turns$/.test(pathname)) return json({ turn: { id: 'turn-1' } });
      return json({});
    }
    if (pathname === '/api/health') return json({ connected: true, cwd: '/tmp/browser-fixture' });
    if (pathname === '/api/threads') return json({ data: [thread], nextCursor: null });
    if (pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol', inputModalities: images ? ['text', 'image'] : ['text'] }], nextCursor: null });
    if (pathname === '/api/settings') return json({ version: 'v1', main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], write: { available: true }, background: { model: 'sol', provider: 'openai' }, memory: { generate: true, use: true, extractionModel: 'sol', consolidationModel: null } });
    if (pathname === '/api/providers') return json({ openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'fixture@example.invalid' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] });
    if (pathname.startsWith('/api/')) return json({});
    const file = path.join(staticOut, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    res.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  })().catch(error => { res.destroy(error); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ELPIS_CHROMIUM ? { executablePath: process.env.ELPIS_CHROMIUM } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width, height }, colorScheme });
  page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().endsWith('.js')) scripts.push(response.url()); });
  await guardDesktopStore(page);
  await page.addInitScript(fakeDesktop);
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByRole('button', { name: 'Annotate this page' }).waitFor(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
  const log = () => page.evaluate(() => (window as DrawingWindow).__log.slice());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  return { page, posts, errors, scripts, log, shoot };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Draw on the page' });
// Excalidraw's tools are radio inputs inside a label; people click the label.
const tool = (page: Page, name: string) => page.locator(`label:has([data-testid="toolbar-${name}"])`);
const draw = (page: Page, name: string, from: { x: number; y: number }, to: { x: number; y: number }) => tool(page, name).click().then(async () => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); });
async function open(f: Awaited<ReturnType<typeof fixture>>) {
  await f.page.getByRole('button', { name: 'Draw on this page' }).click();
  await dialog(f.page).waitFor(); await f.page.locator('.excalidraw canvas').first().waitFor();
  await f.page.evaluate(() => document.fonts.ready);
  const area = await f.page.locator('.excalidraw canvas.interactive').first().boundingBox(); assert.ok(area); return area;
}
// The marked picture as the chat holds it: size and how many of its pixels are no longer the screenshot's green.
const inspect = (page: Page, dataUrl: string) => page.evaluate(async url => {
  const image = new Image(); image.src = url; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw Error('Canvas context missing'); ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let marked = 0, green = 0;
  for (let i = 0; i < data.length; i += 4) { const r = data[i], g = data[i + 1], b = data[i + 2]; if (r === undefined || g === undefined || b === undefined) throw Error('Incomplete pixel'); const near = Math.abs(r - 32) < 40 && Math.abs(g - 160) < 40 && Math.abs(b - 96) < 40; if (near) green++; else if (!(r > 215 && g > 215 && b > 215)) marked++; }
  return { width: image.width, height: image.height, marked, green: green / (data.length / 4) };
}, dataUrl);
const chips = (page: Page) => page.getByRole('list', { name: 'Message attachments' });

test('Draw loads the editor only when used, captures before hiding the page, and adds the marked picture to the composer', async t => {
  const f = await fixture(t), { page } = f;
  assert.equal(await page.evaluate(() => typeof (window as DrawingWindow).EXCALIDRAW_ASSET_PATH), 'undefined', 'the editor and its assets are not loaded with the panel');
  assert.equal(await page.locator('.excalidraw').count(), 0);
  const before = f.scripts.length;
  await page.getByRole('button', { name: 'Draw on this page' }).waitFor();
  await f.shoot('draw-button-light');
  // A217 opens the browser small; widen it before using several drawing tools.
  await widenSidePanel(page, 700);
  await eventually(async () => assert.equal((await f.log()).at(-1), 'visible'));
  await page.evaluate(() => (window as DrawingWindow).__log.length = 0);
  const area = await open(f), log = await f.log();
  assert.ok(f.scripts.length > before, 'the editor chunk is fetched on Draw');
  assert.equal(await page.evaluate(() => (window as DrawingWindow).EXCALIDRAW_ASSET_PATH), '/love-spot-assets/');
  assert.ok(log.indexOf('screenshot') !== -1 && log.indexOf('screenshot') < log.indexOf('obscured'), `screenshot first, then the native page hides: ${log}`);
  for (const name of ['selection', 'rectangle', 'arrow', 'freedraw', 'text', 'eraser']) await tool(page, name).waitFor();
  await f.shoot('draw-modal-empty-light');
  const add = page.getByRole('button', { name: 'Add to message' });
  assert.equal(await add.isDisabled(), true, 'nothing is marked yet');

  const point = (x: number, y: number) => ({ x: area.x + area.width * x, y: area.y + area.height * y });
  await draw(page, 'arrow', point(0.3, 0.4), point(0.6, 0.5));
  await draw(page, 'freedraw', point(0.35, 0.6), point(0.65, 0.64));
  await draw(page, 'rectangle', point(0.55, 0.3), point(0.7, 0.42));
  await tool(page, 'text').click(); const text = point(0.3, 0.67); await page.mouse.click(text.x, text.y);
  await page.locator('.excalidraw-wysiwyg').waitFor();
  await page.keyboard.type('Make this bigger'); await page.keyboard.press('Escape');
  await f.shoot('draw-modal-marked-light');
  await eventually(async () => assert.equal(await add.isDisabled(), false));

  // The screenshot is a locked backdrop: clicking it, select-all and Delete cannot remove it.
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
  await eventually(async () => assert.equal(await add.isDisabled(), true, 'select-all + Delete removes the marks'));
  await page.keyboard.press('Control+z');
  await eventually(async () => assert.equal(await add.isDisabled(), false, 'undo brings the marks back'));
  await add.click();
  await dialog(page).waitFor({ state: 'detached' });
  await page.getByText('Drawing added to your message').waitFor();
  await chips(page).getByText('Page drawing.jpg').waitFor(); assert.equal(await chips(page).getByText('Page drawing context').count(), 0, 'the note for the model is not shown');
  assert.equal((await f.log()).includes('obscured') && (await f.log()).at(-1), 'visible', 'the page returns when the drawing closes');
  assert.equal(f.posts.filter(post => /\/turns$/.test(post.path)).length, 0, 'adding does not send');
  await f.shoot('draw-added-to-composer-light');

  const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await input.fill('Please make the highlighted block bigger'); await input.press('Enter');
  await eventually(() => assert.ok(f.posts.find(post => /\/turns$/.test(post.path))));
  const sent = f.posts.find(post => /\/turns$/.test(post.path)); assert.ok(sent); const [note, image] = sent.body.attachments; assert.ok(note && image);
  assert.equal(note.name, 'Page drawing context'); assert.match(note.text, /https:\/\/example\.com\/pricing/); assert.match(note.text, /Example pricing/); assert.match(note.text, /800×500/);
  assert.equal(image.name, 'Page drawing.jpg'); assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  const picture = await inspect(page, image.dataUrl);
  assert.equal(picture.width, 800); assert.equal(picture.height, 500);
  assert.ok(picture.green > 0.8, `the screenshot is still underneath (${picture.green})`);
  assert.ok(picture.marked > 300, `the drawn marks are in the picture (${picture.marked} pixels)`);
  assert.deepEqual(f.errors, []);
});

test('Escape and Cancel keep a drawing until it is discarded; the editor keeps Escape while a tool is active', async t => {
  const f = await fixture(t), { page } = f;
  const area = await open(f), cx = area.x + area.width / 2, cy = area.y + area.height / 2;
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  assert.equal(await dialog(page).count(), 0, 'with nothing drawn Escape closes at once');
  assert.equal((await f.log()).filter(item => item === 'screenshot').length, 1);

  await open(f);
  await draw(page, 'rectangle', { x: cx - 100, y: cy - 60 }, { x: cx + 100, y: cy + 60 });
  await tool(page, 'arrow').click();
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'Escape first returns the editor to its selection tool');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').getByText('Discard this drawing?').waitFor();
  await f.shoot('draw-discard-confirm-light');
  await page.getByRole('button', { name: 'Keep drawing' }).click();
  await dialog(page).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add to message' }).isDisabled(), false, 'the mark is still there');

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('alertdialog').waitFor(); await page.getByRole('button', { name: 'Keep drawing' }).click();
  await dialog(page).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });
  await open(f);
  assert.equal((await f.log()).filter(item => item === 'screenshot').length, 3, 'after Discard a new Draw captures the page again');
  assert.equal(await page.getByRole('button', { name: 'Add to message' }).isDisabled(), true, 'and starts clean');
  assert.deepEqual(f.errors, []);
});

test('a failed attach keeps the drawing and can be retried; a drawing left behind can be resumed', async t => {
  const f = await fixture(t), { page } = f;
  // 19 small files leave room for one more; the drawing adds two parts, so the composer refuses it.
  await page.locator('input[type=file]').first().setInputFiles(Array.from({ length: 19 }, (_, i) => ({ name: `f${i}.png`, mimeType: 'image/png', buffer: PNG })));
  await chips(page).getByText('f18.png').waitFor();
  const area = await open(f), cx = area.x + area.width / 2, cy = area.y + area.height / 2;
  await draw(page, 'rectangle', { x: cx - 100, y: cy - 60 }, { x: cx + 100, y: cy + 60 });
  const add = page.getByRole('button', { name: 'Add to message' });
  await eventually(async () => assert.equal(await add.isDisabled(), false));
  await add.click();
  await page.getByRole('alert').filter({ hasText: 'could not be added to your message' }).waitFor();
  await f.shoot('draw-attach-failed-light');
  assert.equal(await dialog(page).count(), 1, 'the drawing stays open');
  assert.equal(await chips(page).getByText('Page drawing.jpg').count(), 0, 'nothing half-attached');
  // Free a slot behind the dialog, then the same drawing goes through.
  await chips(page).getByRole('button', { name: 'Remove f0.png' }).dispatchEvent('click');
  await chips(page).getByRole('button', { name: 'Remove f1.png' }).dispatchEvent('click');
  await add.click();
  await dialog(page).waitFor({ state: 'detached' });
  await chips(page).getByText('Page drawing.jpg').waitFor();
  assert.equal((await f.log()).filter(item => item === 'screenshot').length, 1, 'retry reused the held drawing, no second capture');
  assert.deepEqual(f.errors, []);
});

test('a screenshot failure is shown, leaves the page visible and can be retried', async t => {
  const f = await fixture(t), { page } = f;
  for (const mode of ['throw', 'empty']) {
    await page.evaluate(mode => { const target = window as DrawingWindow; target.__shot = mode; target.__log.length = 0; }, mode);
    await page.getByRole('button', { name: 'Draw on this page' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Drawing could not start' });
    await alert.waitFor();
    if (mode === 'throw') assert.match(await alert.innerText(), /no visible view/);
    assert.equal(await dialog(page).count(), 0);
    assert.ok(!(await f.log()).includes('obscured'), 'the native page is not hidden by a failed capture');
    if (mode === 'throw') await f.shoot('draw-capture-failed-light');
  }
  await page.evaluate(() => { (window as DrawingWindow).__shot = 'ok'; });
  await page.getByRole('button', { name: 'Retry' }).click();
  await dialog(page).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Drawing could not start' }).count(), 0);
  assert.deepEqual(f.errors, []);
});

test('Draw is unavailable for a text-only model, and never captures', async t => {
  const f = await fixture(t, { images: false }), { page } = f;
  await page.getByRole('button', { name: /Chat A/ }).first().click();
  const button = page.getByRole('button', { name: 'Draw on this page' });
  await eventually(async () => assert.equal(await button.isDisabled(), true));
  assert.equal(await button.getAttribute('title'), 'This model does not accept images');
  assert.ok(!(await f.log()).includes('screenshot'));
});

// The native title controls occupy the first 36 CSS pixels; the drawing must leave them free.
// The green page has a white landmark and is wider than this canvas, so its four edges must be fitted into view.
// The opacity value sits under the slider (at 100, its right end), not cut off at the panel's left edge.
const opacityUnderSlider = (page: Page) => page.evaluate(() => {
  const range = document.querySelector('.selected-shape-actions .range-input')?.getBoundingClientRect();
  const value = document.querySelector('.selected-shape-actions .value-bubble')?.getBoundingClientRect();
  return !!range && !!value && value.width > 0 && value.left >= range.left && value.right <= range.right + 8;
});

// Masih, 23 Oct: Style cannot close and drawing prevents returning to chat.
test('Style closes without losing marks and Chat pauses drawing for a lossless Resume', async t => {
  const f = await fixture(t), { page } = f;
  const area = await open(f);
  await draw(page, 'rectangle', { x: area.x + area.width / 2 - 60, y: area.y + area.height / 2 - 40 }, { x: area.x + area.width / 2 + 60, y: area.y + area.height / 2 + 40 });
  const style = page.getByRole('button', { name: 'Drawing style', exact: true });
  const properties = page.locator('.selected-shape-actions .App-menu__left, .App-mobile-menu');
  for (const width of [1320, 760]) {
    await page.setViewportSize({ width, height: 860 });
    // Excalidraw's narrow layout keeps its own palette button in its bottom bar.
    // Excalidraw redraws its layout for a new size only on its next render: a window resize event gives it one.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); resolve(); })));
    await page.waitForFunction(() => {
      const editor = document.querySelector('.excalidraw'); if (!editor) return false; const narrow = editor.classList.contains('excalidraw--mobile');
      return Number(narrow === (editor.getBoundingClientRect().width as unknown)) < 730 && narrow === !document.querySelector('[aria-label="Drawing style"]');
    });
    const narrow = await page.locator('.excalidraw--mobile').count() > 0;
    const toggle = narrow ? page.getByRole('button', { name: 'Edit', exact: true }) : style;
    assert.equal(await style.count(), narrow ? 0 : 1);
    if (!narrow) {
      assert.equal(await style.getAttribute('aria-pressed'), 'true');
      assert.equal(await style.evaluate(button => !!button.closest('.selected-shape-actions')), true, 'the style button sits in the style panel itself');
    } else if (!await properties.isVisible()) { await toggle.click(); await properties.waitFor({ state: 'visible' }); }
    await toggle.click();
    if (!narrow) assert.equal(await style.getAttribute('aria-pressed'), 'false');
    await properties.waitFor({ state: 'hidden', timeout: 2000 });
    if (!narrow) assert.equal(await style.isVisible(), true, 'a hidden panel keeps its toggle where it was');
    assert.equal(await page.getByRole('button', { name: 'Add to message' }).isEnabled(), true);
    await toggle.click();
    await properties.waitFor({ state: 'visible' });
    if (!narrow) assert.equal(await opacityUnderSlider(page), true, 'the opacity value sits under its slider after the panel reopens');
    await f.shoot(`style-on-${width}`);
  }
  await page.setViewportSize({ width: 1320, height: 860 });
  const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await input.click(); await input.fill('Still here with you.');
  assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await dialog(page).getByRole('button', { name: 'Chat', exact: true }).press('Enter');
  await dialog(page).waitFor({ state: 'detached' });
  assert.equal(await input.inputValue(), 'Still here with you.');
  assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await dialog(page).waitFor();
  assert.equal((await f.log()).filter(item => item === 'screenshot').length, 1);
  assert.equal(await page.getByRole('button', { name: 'Add to message' }).isEnabled(), true);
  await page.getByRole('button', { name: 'Add to message' }).click();
  await chips(page).getByText('Page drawing.jpg').waitFor();
  await f.shoot('style-chat-resume');
  assert.deepEqual(f.errors, []);
});
