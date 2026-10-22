// The built-in browser's Draw button against the exported UI and the real Excalidraw editor. The Electron side is faked
// in the page (a scripted screenshot command, recorded layouts); the chat endpoints are synthetic. No model is called.
// Screenshots go to $ELPIS_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const staticOut = path.join(__dirname, '../out');
const shots = process.env.ELPIS_SHOTS;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHsKbOQAAAABJRU5ErkJggg==', 'base64');

async function eventually(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

// A page tab, and a captured screenshot that is plainly green so marks drawn over it can be told apart.
function fakeDesktop() {
  const tab = { id: 't1', url: 'https://example.com/pricing', title: 'Example pricing', loading: false, error: null, failure: null, security: 'secure', zoom: 100, comments: 0, canGoBack: false, canGoForward: false };
  window.__state = { visible: true, activeId: 't1', focusAddress: 0, tabs: [tab], annotating: false, markersVisible: true, annotations: [], draft: null, find: { open: false, text: '', matches: 0, active: 0, focus: 0 } };
  window.__log = []; window.__shot = 'ok'; const listeners = new Set();
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#20a060'; ctx.fillRect(0, 0, 800, 500); ctx.fillStyle = '#fff'; ctx.fillRect(40, 40, 200, 60);
  window.__jpeg = canvas.toDataURL('image/jpeg', 0.9);
  window.elpisDesktop = {
    setTheme: () => {},
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), onError: () => () => {} },
    browser: {
      command: async action => {
        window.__log.push(action);
        if (action === 'screenshot') { if (window.__shot === 'throw') throw new Error('The page has no visible view.'); return { ...window.__state, result: window.__shot === 'empty' ? {} : { image: window.__jpeg } }; }
        return window.__state;
      },
      layout: value => window.__log.push(value.obscured ? 'obscured' : 'visible'),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
}

async function fixture(t, { colorScheme = 'light', width = 1320, height = 860, images = true } = {}) {
  const posts = [], errors = [], scripts = [];
  const thread = { id: 'a', name: 'Chat A', cwd: '/tmp/browser-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
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
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ELPIS_CHROMIUM || undefined });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width, height }, colorScheme });
  page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().endsWith('.js')) scripts.push(response.url()); });
  await guardDesktopStore(page);
  await page.addInitScript(fakeDesktop);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: 'Annotate this page' }).waitFor(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
  const log = () => page.evaluate(() => window.__log.slice());
  const shoot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  return { page, posts, errors, scripts, log, shoot };
}

const dialog = page => page.getByRole('dialog', { name: 'Draw on the page' });
// Excalidraw's tools are radio inputs inside a label; people click the label.
const tool = (page, name) => page.locator(`label:has([data-testid="toolbar-${name}"])`);
const draw = (page, name, from, to) => tool(page, name).click().then(async () => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); });
async function open(f) {
  await f.page.getByRole('button', { name: 'Draw on this page' }).click();
  await dialog(f.page).waitFor(); await f.page.locator('.excalidraw canvas').first().waitFor();
  await f.page.evaluate(() => document.fonts.ready);
  return f.page.locator('.excalidraw canvas.interactive').first().boundingBox();
}
// The marked picture as the chat holds it: size and how many of its pixels are no longer the screenshot's green.
const inspect = (page, dataUrl) => page.evaluate(async url => {
  const image = new Image(); image.src = url; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let marked = 0, green = 0;
  for (let i = 0; i < data.length; i += 4) { const near = Math.abs(data[i] - 32) < 40 && Math.abs(data[i + 1] - 160) < 40 && Math.abs(data[i + 2] - 96) < 40; if (near) green++; else if (!(data[i] > 215 && data[i + 1] > 215 && data[i + 2] > 215)) marked++; }
  return { width: image.width, height: image.height, marked, green: green / (data.length / 4) };
}, dataUrl);
const chips = page => page.getByRole('list', { name: 'Message attachments' });

test('Draw loads the editor only when used, captures before hiding the page, and adds the marked picture to the composer', async t => {
  const f = await fixture(t), { page } = f;
  assert.equal(await page.evaluate(() => typeof window.EXCALIDRAW_ASSET_PATH), 'undefined', 'the editor and its assets are not loaded with the panel');
  assert.equal(await page.locator('.excalidraw').count(), 0);
  const before = f.scripts.length;
  await page.getByRole('button', { name: 'Draw on this page' }).waitFor();
  await f.shoot('draw-button-light');
  await page.evaluate(() => window.__log.length = 0);
  const area = await open(f), log = await f.log();
  assert.ok(f.scripts.length > before, 'the editor chunk is fetched on Draw');
  assert.equal(await page.evaluate(() => window.EXCALIDRAW_ASSET_PATH), '/love-spot-assets/');
  assert.ok(log.indexOf('screenshot') !== -1 && log.indexOf('screenshot') < log.indexOf('obscured'), `screenshot first, then the native page hides: ${log}`);
  for (const name of ['selection', 'rectangle', 'arrow', 'freedraw', 'text', 'eraser']) await tool(page, name).waitFor();
  await f.shoot('draw-modal-empty-light');
  const add = page.getByRole('button', { name: 'Add to message' });
  assert.equal(await add.isDisabled(), true, 'nothing is marked yet');

  const cx = area.x + area.width / 2, cy = area.y + area.height / 2;
  await draw(page, 'arrow', { x: cx - 150, y: cy - 100 }, { x: cx + 100, y: cy });
  await draw(page, 'freedraw', { x: cx - 120, y: cy + 60 }, { x: cx + 120, y: cy + 90 });
  await draw(page, 'rectangle', { x: cx + 20, y: cy - 150 }, { x: cx + 160, y: cy - 60 });
  await tool(page, 'text').click(); await page.mouse.click(cx - 200, cy + 130); await page.keyboard.type('Make this bigger'); await page.keyboard.press('Escape');
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
  await chips(page).getByText('Page drawing.jpg').waitFor(); await chips(page).getByText('Page drawing context').waitFor();
  assert.equal((await f.log()).includes('obscured') && (await f.log()).at(-1), 'visible', 'the page returns when the drawing closes');
  assert.equal(f.posts.filter(post => /\/turns$/.test(post.path)).length, 0, 'adding does not send');
  await f.shoot('draw-added-to-composer-light');

  const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await input.fill('Please make the highlighted block bigger'); await input.press('Enter');
  await eventually(() => assert.ok(f.posts.find(post => /\/turns$/.test(post.path))));
  const [note, image] = f.posts.find(post => /\/turns$/.test(post.path)).body.attachments;
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
    await page.evaluate(mode => { window.__shot = mode; window.__log.length = 0; }, mode);
    await page.getByRole('button', { name: 'Draw on this page' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Drawing could not start' });
    await alert.waitFor();
    if (mode === 'throw') assert.match(await alert.innerText(), /no visible view/);
    assert.equal(await dialog(page).count(), 0);
    assert.ok(!(await f.log()).includes('obscured'), 'the native page is not hidden by a failed capture');
    if (mode === 'throw') await f.shoot('draw-capture-failed-light');
  }
  await page.evaluate(() => { window.__shot = 'ok'; });
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

for (const colorScheme of ['light', 'dark']) test(`the drawing modal follows the theme and fits at a narrow width (${colorScheme})`, async t => {
  const f = await fixture(t, { colorScheme, width: 760, height: 640 }), { page } = f;
  await open(f);
  await tool(page, 'arrow').waitFor();
  const shade = await dialog(page).evaluate(element => { const [r, g, b] = getComputedStyle(element).backgroundColor.match(/\d+/g).map(Number); return (r + g + b) / 3; });
  assert.equal(shade < 100, colorScheme === 'dark', `modal background shade ${shade}`);
  assert.equal(await page.locator('.excalidraw').evaluate(element => element.classList.contains('theme--dark')), colorScheme === 'dark');
  const box = await dialog(page).boundingBox();
  const panel = await page.locator('.browser-panel').boundingBox();
  assert.deepEqual([box.x, box.y, box.width, box.height], [panel.x, panel.y, panel.width, panel.height], 'the drawing fills the browser panel it opened from, which does not move');
  for (const name of ['Cancel', 'Add to message']) { const b = await page.getByRole('button', { name, exact: true }).boundingBox(); assert.ok(b.x >= 0 && b.x + b.width <= 760 && b.y >= 0, `${name} stays inside the window`); }
  await assertUiFit(dialog(page), 'the drawing header fits the window');
  await f.shoot(`draw-modal-narrow-${colorScheme}`);
  await page.getByTestId('main-menu-trigger').click(); await page.getByTestId('dropdown-menu').waitFor();
  assert.equal(await page.getByTestId('dropdown-menu').locator('a').count(), 0, 'the menu carries no links to other sites');
  await f.shoot(`draw-menu-${colorScheme}`);
  assert.deepEqual(f.errors, []);
});

// The native title controls occupy the first 36 CSS pixels; the drawing must leave them free.
// The green page has a white landmark and is wider than this canvas, so its four edges must be fitted into view.
test('drawing stays below the desktop title bar and fits the whole captured page on first open', async t => {
  const f = await fixture(t, { colorScheme: 'dark', width: 760, height: 640 }), { page } = f;
  await open(f);
  const title = await page.locator('.title-bar').boundingBox();
  const box = await dialog(page).boundingBox();
  await f.shoot('drawing-desktop-first-open');
  assert.ok(box.y >= title.y + title.height, 'the drawing does not cover the native window controls');
  const canvas = await page.locator('.excalidraw canvas').first().screenshot();
  const bounds = await page.evaluate(async png => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] < 60 && data[i + 1] > 100 && data[i + 1] < 190 && data[i + 2] > 60 && data[i + 2] < 130) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return { left, right, top, bottom, width: canvas.width, height: canvas.height };
  }, canvas.toString('base64'));
  assert.ok(bounds.right > bounds.left, 'the captured page is visible');
  assert.ok(bounds.left > 0 && bounds.right < bounds.width - 1 && bounds.top > 0 && bounds.bottom < bounds.height - 1,
    `all four screenshot edges fit on first open: ${JSON.stringify(bounds)}`);
  assert.deepEqual(f.errors, []);
});

// Focus is checked on the real element: inside the drawing dialog, or (for the discard question) its own alert dialog.
const focusedInside = page => page.evaluate(() => { const a = document.activeElement; return !!a && !!(a.closest('[role=dialog][aria-label="Draw on the page"]') || a.closest('[role=alertdialog]')); });
const focusLabel = page => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}:${a.getAttribute('aria-label') || a.textContent?.trim().slice(0, 30) || a.className}` : 'none'; });

test('keyboard focus starts in the drawing, stays there through Tab, Shift+Tab and Excalidraw menus, and returns to Draw on close', async t => {
  const f = await fixture(t), { page } = f;
  const draw = page.getByRole('button', { name: 'Draw on this page' });
  await draw.focus(); await draw.press('Enter');
  await dialog(page).waitFor(); await page.locator('.excalidraw canvas.interactive').first().waitFor();
  await eventually(async () => assert.equal(await focusedInside(page), true, `initial focus: ${await focusLabel(page)}`));
  const seen = new Set();
  for (let i = 0; i < 60; i++) { await page.keyboard.press(i < 30 ? 'Tab' : 'Shift+Tab'); assert.equal(await focusedInside(page), true, `focus escaped on press ${i}: ${await focusLabel(page)}`); seen.add(await focusLabel(page)); }
  assert.ok(seen.size > 5, `Tab really moves through the editor's controls (${seen.size} stops)`);
  assert.ok([...seen].some(label => /Add to message|Cancel/.test(label)), 'and through the dialog\'s own buttons');
  // An open Excalidraw menu keeps focus too.
  await page.getByTestId('main-menu-trigger').click(); await page.getByTestId('dropdown-menu').waitFor();
  for (let i = 0; i < 12; i++) { await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab'); assert.equal(await focusedInside(page), true, `focus escaped from the menu on press ${i}: ${await focusLabel(page)}`); }
  // In the browser panel's width Excalidraw uses its phone layout, whose menu Escape does not close; its button does.
  await page.keyboard.press('Escape');
  if (await page.getByTestId('dropdown-menu').count()) await page.getByTestId('main-menu-trigger').click();
  await page.getByTestId('dropdown-menu').waitFor({ state: 'detached' });
  assert.equal(await dialog(page).count(), 1, 'Escape closed only the menu');
  // The discard question takes focus and gives it back.
  await page.locator('label:has([data-testid="toolbar-rectangle"])').click();
  const area = await page.locator('.excalidraw canvas.interactive').first().boundingBox();
  await page.mouse.move(area.x + 400, area.y + 300); await page.mouse.down(); await page.mouse.move(area.x + 500, area.y + 380, { steps: 5 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('alertdialog').waitFor();
  assert.equal(await focusedInside(page), true, 'the discard question holds focus');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await draw.evaluate(element => element === document.activeElement), true, `Draw regains focus: ${await focusLabel(page)}`));
  assert.deepEqual(f.errors, []);

  // After a successful add the chat's composer, not the hidden page or the button, has the cursor.
  await open(f);
  await page.locator('label:has([data-testid="toolbar-rectangle"])').click();
  const again = await page.locator('.excalidraw canvas.interactive').first().boundingBox();
  await page.mouse.move(again.x + 400, again.y + 300); await page.mouse.down(); await page.mouse.move(again.x + 500, again.y + 380, { steps: 5 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Add to message' }).click(); await dialog(page).waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Message Elpis'));
});
