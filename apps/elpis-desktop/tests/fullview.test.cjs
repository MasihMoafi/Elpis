// The side panel's full view with the chat floating over it (the ChatGPT app's "Exit full view" and floating chat), and
// the browser toolbar that must keep its address field. The exported UI against a scripted desktop bridge
// (tests/fake-desktop.cjs: it records every layout message the page sends for the native Electron view);
// synthetic HTTP/SSE, no shell, engine or provider. Screenshots go to $ELPIS_FULLVIEW_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore, oranges } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_FULLVIEW_SHOTS;
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}
const near = (actual, expected, message, slack = 1.5) => assert.ok(Math.abs(actual - expected) <= slack, `${message}: ${actual} is not within ${slack} of ${expected}`);
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const rect = box => ({ x: box.x, y: box.y, width: box.width, height: box.height });

async function fixture(run, { width = 1320, height = 860, colorScheme = 'light' } = {}) {
  const thread = { id: 'chat-one', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/work/parser', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } };
  const plan = 'Here is the plan:\n\n1. Read the grammar\n2. Add a test\n3. Fix the **lexer**\n4. Run the suite\n\n```js\nfunction parse(tokens) { return tokens.reduce((tree, token) => insert(tree, token), root); }\n```\n\nA long line of text that has to wrap inside a narrow card without making it scroll sideways, and then some more words after it.';
  const history = [
    { turnId: 'turn-2', turnStatus: 'completed', item: { id: 'reply-2', type: 'agentMessage', text: plan } },
    { turnId: 'turn-2', turnStatus: 'completed', item: { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Now plan the fix and explain each step in some detail so that I can follow it.' }] } },
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'reply-1', type: 'agentMessage', text: 'The parser now handles nested lists.' } },
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Fix the nested list bug' }] } },
  ];
  const clients = new Set(), posts = [];
  const emit = (method, params) => { for (const client of clients) client.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true, cwd: '/work/parser' });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : [thread], nextCursor: null });
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (url.pathname.endsWith('/turns')) return json({ turn: { id: 'turn-2' } });
    if (url.pathname === '/api/threads/chat-one') return json({ thread, data: history, nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(fakeDesktop, { tabs: [{ url: 'https://example.com/docs', title: 'Example docs', security: 'secure', canGoBack: true }] });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').waitFor();
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').click();
    await page.getByText('Run the suite').waitFor();
    const side = page.getByRole('region', { name: 'Side panel' }), card = page.getByRole('region', { name: 'Floating chat', exact: true });
    const pill = page.getByRole('button', { name: 'Restore floating chat: Fix the parser', exact: true });
    const enter = side.getByRole('button', { name: 'Enter full view', exact: true }), exit = side.getByRole('button', { name: 'Exit full view', exact: true });
    const layouts = () => page.evaluate(() => window.__layouts.slice());
    const lastLayout = () => layouts().then(list => list.at(-1));
    const area = () => page.locator('.workspace-body').boundingBox();
    const openPanel = async () => { await page.getByRole('button', { name: 'Show side panel' }).click(); await side.waitFor(); await side.getByRole('textbox', { name: 'Search or enter a URL' }).waitFor(); };
    const shoot = async name => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, side, card, pill, enter, exit, layouts, lastLayout, area, openPanel, shoot, posts, emit, port: server.address().port });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}

test('full view: the header button and Ctrl+Shift+F fill the work area with the panel; Escape does not leave it', () => fixture(async ({ page, side, card, enter, exit, area, openPanel }) => {
  await openPanel();
  assert.equal(await enter.getAttribute('aria-pressed'), 'false');
  const split = await side.boundingBox(), chat = await page.locator('.chat-view').boundingBox();
  assert.ok(chat.x + chat.width <= split.x + 1, 'split view: the chat is left of the panel');
  assert.equal(await card.count(), 0, 'split view: no floating chat');

  await enter.click(); await exit.waitFor();
  assert.equal(await exit.getAttribute('aria-pressed'), 'true');
  const work = await area(), full = await side.boundingBox();
  near(full.x, work.x, 'the panel starts at the work area'); near(full.width, work.width, 'the panel is as wide as the work area'); near(full.height, work.height, 'and as tall');
  assert.equal(await page.getByRole('separator', { name: 'Resize side panel' }).isVisible(), false, 'nothing to resize in full view');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  assert.equal(await exit.count(), 1, 'Escape belongs to pages: it does not leave full view');
  await page.getByLabel('Message Elpis').press('Escape');
  assert.equal(await exit.count(), 1, 'nor from the message box');

  await page.keyboard.press('Control+Shift+F'); await enter.waitFor();
  near((await side.boundingBox()).width, split.width, 'split view returns to the width it had');
  const back = await page.locator('.chat-view').boundingBox();
  assert.ok(back.x + back.width <= (await side.boundingBox()).x + 1 && back.width > 300, 'the chat is left of the panel again');
  await page.getByLabel('Message Elpis').press('Control+Shift+F'); await exit.waitFor();
  await exit.click(); await enter.waitFor();

  // The header buttons share one size; the shortcut is listed where the others are.
  const [closeBox, enterBox] = [await side.getByRole('button', { name: 'Close side panel' }).boundingBox(), await enter.boundingBox()];
  near(enterBox.width, closeBox.width, 'full-view button width as the close button'); near(enterBox.height, closeBox.height, 'and height');
  await page.keyboard.press('Control+/');
  await page.getByRole('alertdialog').getByText('Toggle full view', { exact: true }).waitFor();
  await page.keyboard.press('Escape');

  // Closing the panel leaves full view; the shortcut opens a closed panel straight into it.
  await enter.click(); await exit.waitFor();
  await side.getByRole('button', { name: 'Close side panel' }).click();
  await side.waitFor({ state: 'detached' });
  assert.equal(await card.count(), 0, 'no card without the panel');
  assert.ok((await page.locator('.chat-view').boundingBox()).width > 600, 'the chat has the whole work area again');
  await page.keyboard.press('Control+Shift+F'); await exit.waitFor();
  await card.waitFor();
  // Leaving the chat page (Settings) leaves full view too.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await enter.waitFor();
  assert.equal(await card.count(), 0);
}));

test('in full view the chat floats: the same message box with its draft, the conversation, a pill with the chat’s status and back', () => fixture(async ({ page, side, card, pill, enter, exit, area, openPanel, posts, emit }) => {
  const composer = page.getByLabel('Message Elpis');
  await composer.fill('half-written thought');
  const splitFont = await composer.evaluate(element => getComputedStyle(element).fontSize);
  await composer.evaluate(element => { element.dataset.probe = 'kept'; });
  await openPanel(); await enter.click(); await card.waitFor();

  const box = await card.boundingBox(), work = await area();
  near(box.width, 400, 'the card is about 400 wide', 2); near(box.height, 520, 'and 520 tall', 2);
  near(box.x + box.width, work.x + work.width - 16, 'bottom-right: right edge', 2); near(box.y + box.height, work.y + work.height - 16, 'bottom-right: bottom edge', 2);
  await card.getByText('Run the suite').waitFor();
  const atBottom = () => page.locator('.chat-scroll').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2);
  await eventually(async () => assert.equal(await atBottom(), true, 'a chat that was at its end is still at its end in the card'));
  const inCard = card.getByLabel('Message Elpis');
  assert.equal(await inCard.inputValue(), 'half-written thought', 'the draft came along');
  assert.equal(await inCard.getAttribute('data-probe'), 'kept', 'the very same element, not a copy');
  assert.equal(await page.getByLabel('Message Elpis').count(), 1, 'one message box on the page');
  assert.equal(await inCard.evaluate(element => getComputedStyle(element).fontSize), splitFont, 'the text is not shrunk to fit the card');

  // Every control of the card's bar and message box fits inside the card.
  const outside = await card.evaluate(element => { const bounds = element.getBoundingClientRect(); return [...element.querySelectorAll('.float-chat-bar, .composer, .composer-meta')].flatMap(part => [...part.querySelectorAll('button, textarea, [role="combobox"]')]).filter(control => control.getClientRects().length).map(control => [control, control.getBoundingClientRect()]).filter(([, r]) => r.left < bounds.left - 0.5 || r.right > bounds.right + 0.5 || r.bottom > bounds.bottom + 0.5 || r.top < bounds.top - 0.5).map(([control]) => control.getAttribute('aria-label') || control.textContent); });
  assert.deepEqual(outside, [], 'no control leaves the card');
  assert.equal(await card.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the card does not scroll sideways');
  // None of their labels is cut short ("Default effort" must not become "Defa").
  const cut = await card.evaluate(element => [...element.querySelectorAll('.composer-controls *')].filter(node => node.clientWidth > 1 && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== 'visible').map(node => `${node.getAttribute('aria-label') || node.textContent.trim()} (${node.scrollWidth}px in ${node.clientWidth}px)`));
  assert.deepEqual(cut, [], 'no label of the message box is cut short');
  await page.getByLabel('Reasoning effort').waitFor();

  // The draft keeps working there: type, send.
  await inCard.fill('also check tables'); await inCard.press('Enter');
  await eventually(async () => assert.ok(posts.some(post => /\/turns$/.test(post.path) && JSON.stringify(post.body).includes('also check tables')), 'Enter in the card sends the message'));

  // Collapse to the pill, which shows the chat's state; clicking it restores the card.
  await card.getByRole('button', { name: 'Collapse floating chat', exact: true }).click();
  await pill.waitFor(); await card.waitFor({ state: 'hidden' });
  assert.match(await pill.innerText(), /Working/, 'the sent message started a turn');
  emit('turn/completed', { threadId: 'chat-one', turn: { id: 'turn-2', status: 'completed' } });
  await eventually(async () => assert.match(await pill.innerText(), /Idle/));
  emit('turn/started', { threadId: 'chat-one', turn: { id: 'turn-3' } });
  await eventually(async () => assert.match(await pill.innerText(), /Working/));
  const pillBox = await pill.boundingBox();
  near(pillBox.x + pillBox.width, work.x + work.width - 16, 'the pill sits bottom-right', 2); assert.ok(pillBox.y > work.y + work.height - 70, 'at the bottom');
  await pill.click(); await card.waitFor(); await pill.waitFor({ state: 'detached' });
  assert.equal(await card.getByLabel('Message Elpis').getAttribute('data-probe'), 'kept', 'the same message box after collapsing and restoring');
  emit('turn/completed', { threadId: 'chat-one', turn: { id: 'turn-3', status: 'completed' } });

  // Back to split view: the same box in the chat column, the draft intact.
  await card.getByLabel('Message Elpis').fill('typed in the card'); await exit.click(); await enter.waitFor();
  assert.equal(await card.count(), 0);
  assert.equal(await composer.getAttribute('data-probe'), 'kept');
  assert.equal(await composer.inputValue(), 'typed in the card');
  assert.equal(await composer.evaluate(element => getComputedStyle(element).fontSize), splitFont);
  await eventually(async () => assert.equal(await atBottom(), true, 'and back in the column'));
}));

test('the native page never sits under the floating chat: the bounds sent for it leave the card and the pill clear', () => fixture(async ({ page, side, card, pill, enter, exit, layouts, openPanel }) => {
  await openPanel();
  const settled = async () => { await page.waitForTimeout(200); const list = await layouts(), last = list.at(-1); assert.equal(last.obscured, false, 'the page is shown'); return { list, last: last.bounds }; };
  const split = (await settled()).last;
  // Every layout sent from now on, not only the final one, must keep clear of the card.
  const checkClear = async (target, label, since) => {
    const { list, last } = await settled(), rectangle = rect(await target.boundingBox());
    for (const message of list.slice(since)) if (!message.obscured && message.bounds.width && overlap(message.bounds, rectangle)) assert.fail(`${label}: the page was sent over it ${JSON.stringify(message.bounds)} vs ${JSON.stringify(rectangle)}`);
    assert.ok(last.width > 250 && last.height > 250, `${label}: the page keeps a usable size ${JSON.stringify(last)}`);
    return last;
  };
  let mark = (await layouts()).length;
  await enter.click(); await card.waitFor();
  const withCard = await checkClear(card, 'card open', mark);
  assert.ok(withCard.width > split.width, 'full view gives the page more room than split view');
  const cardBox = await card.boundingBox();
  assert.ok(withCard.x + withCard.width <= cardBox.x, 'the page ends before the card begins');

  mark = (await layouts()).length;
  await card.getByRole('button', { name: 'Collapse floating chat' }).click(); await pill.waitFor();
  const withPill = await checkClear(pill, 'pill', mark);
  assert.ok(withPill.width > withCard.width, 'with only the pill the page is wider than beside the card');

  mark = (await layouts()).length;
  await pill.click(); await card.waitFor();
  await checkClear(card, 'card restored', mark);

  // The annotation bar below the page keeps clear of the card too.
  mark = (await layouts()).length;
  await page.evaluate(() => window.__push({ annotating: true, draft: { id: 'p1', number: 1, kind: 'element', label: 'button “Sign in”', body: '', editing: false } }));
  await page.locator('.annotation-dock').waitFor();
  assert.equal(overlap(rect(await page.locator('.annotation-dock').boundingBox()), rect(await card.boundingBox())), false, 'the annotation bar does not run under the card');
  await checkClear(card, 'annotating', mark);
  await page.evaluate(() => window.__push({ annotating: false, draft: null }));
  await settled();

  mark = (await layouts()).length;
  await page.setViewportSize({ width: 1000, height: 720 });
  await checkClear(card, 'narrow window', mark);
  await page.setViewportSize({ width: 1320, height: 860 });

  // A shell is HTML, but it keeps clear of the card the same way.
  await side.getByRole('button', { name: 'New side panel tab' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await page.locator('.terminal-body').waitFor(); await page.waitForTimeout(150);
  const terminal = rect(await page.locator('.terminal-body').boundingBox()), cardNow = rect(await card.boundingBox());
  assert.equal(overlap(terminal, cardNow), false, 'the shell does not run under the card');
  await side.getByRole('tab', { name: 'Example docs' }).click();

  await exit.click(); await enter.waitFor();
  const after = (await settled()).last;
  near(after.x, split.x, 'back to split view: page left', 2); near(after.width, split.width, 'page width', 2); near(after.height, split.height, 'page height', 2);
}));

test('Ctrl+Shift+F works from inside a shell: the terminal passes the key to the window instead of typing it', () => fixture(async ({ page, side, enter, exit, openPanel }) => {
  await openPanel();
  await side.getByRole('button', { name: 'New side panel tab' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  const input = page.locator('.xterm-helper-textarea'); await input.waitFor({ state: 'attached' }); await input.focus();
  await page.keyboard.press('Control+Shift+F'); await exit.waitFor();
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'the shell keeps the focus');
  await page.keyboard.press('Control+Shift+F'); await enter.waitFor();
  assert.deepEqual((await page.evaluate(() => window.__terminal.input)).filter(([, text]) => /\x06/.test(text)), [], 'the shell never received Ctrl+F');
}));

test('the toolbar keeps an address field of 180px at every panel width, and the panel cannot be dragged narrower than that needs', () => fixture(async ({ page, side, openPanel }) => {
  await openPanel();
  const address = side.getByRole('textbox', { name: 'Search or enter a URL' }), toolbar = side.getByRole('form', { name: 'Browser navigation' });
  const handle = page.getByRole('separator', { name: 'Resize side panel' });
  async function dragTo(wanted) {
    const edge = await handle.boundingBox(), panel = await side.boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200); await page.mouse.down();
    await page.mouse.move(panel.x + panel.width - wanted, edge.y + 200, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(60);
  }
  const measure = async () => toolbar.evaluate(form => {
    const bounds = form.getBoundingClientRect(), field = form.querySelector('input').getBoundingClientRect();
    const hidden = [...form.querySelectorAll('button')].filter(button => button.getClientRects().length).filter(button => button.getBoundingClientRect().right > bounds.right + 0.5);
    return { field: field.width, overflow: form.scrollWidth - form.clientWidth, cut: hidden.map(button => button.getAttribute('aria-label')), annotate: form.querySelector('[aria-label="Annotate this page"]').getBoundingClientRect().width, external: !!form.querySelector('[aria-label="Open in external browser"]')?.getClientRects().length };
  });
  const seen = [];
  for (const wanted of [740, 640, 560, 500, 470, 450, 430, 410, 390, 370, 350, 330, 300, 200, 100]) {
    await dragTo(wanted);
    const panel = (await side.boundingBox()).width, now = await measure();
    seen.push([wanted, Math.round(panel), Math.round(now.field)]);
    assert.ok(now.field >= 179.5, `panel ${Math.round(panel)}px (asked ${wanted}): the address field is ${Math.round(now.field)}px`);
    assert.ok(now.overflow <= 0 && now.cut.length === 0, `panel ${Math.round(panel)}px: the toolbar overflows (${now.overflow}px, cut: ${now.cut})`);
  }
  const narrowest = seen.at(-1)[1];
  assert.ok(narrowest >= 330 && narrowest <= 460, `the narrowest panel is ${narrowest}px`);
  near(seen[1][1], 640, 'the handle still drags to a width it is given', 1);
  // Keyboard resizing stops at the same floor.
  await dragTo(740); await handle.focus(); for (let step = 0; step < 20; step++) await page.keyboard.press('ArrowRight');
  assert.equal(Math.round((await side.boundingBox()).width), narrowest, 'arrow keys stop at the floor too');

  // At the floor, lower-priority controls collapse: Annotate to its icon, open-externally into the … menu.
  const now = await measure();
  assert.ok(now.annotate <= 36, `Annotate is an icon at ${narrowest}px (${now.annotate}px wide)`);
  assert.equal(now.external, false, 'the open-externally button gives way');
  await side.getByRole('button', { name: 'Browser options' }).click();
  await page.getByRole('menuitem', { name: 'Open in external browser' }).click();
  assert.ok((await page.evaluate(() => window.__commands.map(item => item.action))).includes('external'), 'the … menu opens the page elsewhere');
  await page.keyboard.press('Escape');
  // Wide again: the label and the button are back.
  await dragTo(740);
  const wide = await measure();
  assert.ok(wide.annotate > 60 && wide.external, 'with room, Annotate shows its label and the button is there');
  assert.equal(await side.getByRole('button', { name: 'Annotate this page' }).innerText(), 'Annotate');

  // A blank tab shows the whole placeholder; a plain-HTTP, zoomed page still leaves room to read its address.
  await dragTo(100);
  await page.evaluate(() => window.__push({ tabs: [{ ...window.__browser.tabs[0], url: 'about:blank', title: 'New tab' }] }));
  const room = () => address.evaluate(input => { const style = getComputedStyle(input), context = document.createElement('canvas').getContext('2d'); context.font = style.font; return { text: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), placeholder: context.measureText(input.placeholder).width }; });
  const blank = await room();
  assert.ok(blank.text >= blank.placeholder, `the placeholder fits: ${Math.round(blank.text)}px for ${Math.round(blank.placeholder)}px`);
  await page.evaluate(() => window.__push({ tabs: [{ ...window.__browser.tabs[0], url: 'http://example.com/a/long/path', title: 'Example', security: 'insecure', zoom: 125 }] }));
  await side.getByRole('button', { name: '125%' }).waitFor();
  const insecure = await room(), field = await address.boundingBox();
  assert.ok(field.width >= 179.5, 'still 180px with the warning and the zoom chip');
  assert.ok(insecure.text >= 80, `${Math.round(insecure.text)}px are left to read the address beside the warning and the zoom chip`);
}));

test('the toolbar keeps its address field at the panel’s default width in smaller windows', () => fixture(async ({ page, side, openPanel }) => {
  await openPanel();
  for (const width of [1001, 1100, 1200]) {
    await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(120);
    const field = await side.getByRole('textbox', { name: 'Search or enter a URL' }).boundingBox();
    assert.ok(field.width >= 179.5, `window ${width}px: the address field is ${Math.round(field.width)}px`);
  }
}));

test('sizes and styles match the split view, and the light theme has no orange', () => fixture(async ({ page, side, card, pill, enter, exit, openPanel }) => {
  await openPanel();
  const look = () => page.evaluate(() => {
    const px = (selector, property) => { const element = document.querySelector(selector); return element ? getComputedStyle(element)[property] : null; };
    const size = selector => { const rectangle = document.querySelector(selector)?.getBoundingClientRect(); return rectangle ? [Math.round(rectangle.width), Math.round(rectangle.height)] : null; };
    return { tab: size('.side-header .task-tab'), tabFont: px('.side-header .task-tab > button[role="tab"]', 'fontSize'), action: size('.side-action'), composer: px('.composer textarea', 'fontSize'), message: px('.message.agent', 'fontSize'), annotate: size('.browser-annotate')?.[1], user: px('.message.user', 'fontSize') };
  });
  const splitLook = await look();
  assert.deepEqual(await oranges(page), [], 'light theme, split view: no orange');
  await enter.click(); await card.waitFor();
  assert.deepEqual(await look(), splitLook, 'full view with the card: tabs, buttons and text keep their sizes');
  assert.deepEqual(await oranges(page), [], 'light theme, full view with the card: no orange');
  await page.getByLabel('Message Elpis').focus();
  assert.deepEqual(await oranges(page), [], 'light theme, composer focused in the card: no orange');
  await card.getByRole('button', { name: 'Collapse floating chat' }).click(); await pill.waitFor();
  assert.deepEqual(await look(), splitLook, 'with the pill: the panel keeps its sizes');
  const pillBox = await pill.boundingBox();
  assert.equal(Math.round(pillBox.height), splitLook.annotate, 'the pill is as tall as the toolbar’s own buttons');
  assert.deepEqual(await oranges(page), [], 'light theme, collapsed pill: no orange');
  await pill.click(); await exit.click(); await enter.waitFor();
  assert.deepEqual(await look(), splitLook, 'back in split view nothing moved');
}));

test('screenshots: split view, full view with the card and the collapsed pill, light and dark', () => fixture(async ({ page, side, card, pill, enter, exit, openPanel, shoot, emit }) => {
  await openPanel();
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Use dark theme' }).click();
    await shoot(`split-view-${theme}`);
    await enter.click(); await card.waitFor();
    await shoot(`full-view-card-${theme}`);
    emit('turn/started', { threadId: 'chat-one', turn: { id: `turn-${theme}` } });
    await card.getByRole('button', { name: 'Collapse floating chat' }).click(); await pill.waitFor();
    await pill.getByText('Working').waitFor();
    await shoot(`full-view-pill-${theme}`);
    await pill.click(); await exit.click(); await enter.waitFor();
    emit('turn/completed', { threadId: 'chat-one', turn: { id: `turn-${theme}`, status: 'completed' } });
  }
}));
