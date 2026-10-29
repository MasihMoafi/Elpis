// Matilda as a pet, 29 Oct. Masih, on Love Spot in dark mode: "This is matilda in dark mode!" (her face showed as a photo
// negative). And: "the pinned Matilda is very awkward in that I can't drag and move her properly without breaking the
// chatbox. This is a replica, supposed to be a replica of pets in chatgpt app": she floats over everything, moves
// anywhere inside the window and takes her small chat with her, and nothing under her moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const { BOARD_FACE, FACE_DATA_URL } = require('../bridge/matilda-face.cjs');

// Where Excalidraw shows the board: its own view state, read from the editor component that draws `.excalidraw`.
const boardView = page => page.evaluate(() => {
  const root = document.querySelector('.excalidraw'), key = Object.keys(root).find(name => name.startsWith('__reactFiber$'));
  for (let fiber = root[key]; fiber; fiber = fiber.return) {
    const state = fiber.stateNode?.state;
    if (state?.zoom && 'scrollX' in state) return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, left: state.offsetLeft, top: state.offsetTop };
  }
});
const onScreen = (view, e) => ({ x: (e.x + view.scrollX) * view.zoom + view.left, y: (e.y + view.scrollY) * view.zoom + view.top, width: e.width * view.zoom, height: e.height * view.zoom });

for (const colorScheme of ['light', 'dark']) test(`on the board her face is the right way round and her newest note opens clear of the board's toolbar and zoom bar (${colorScheme})`, { timeout: 90000 }, async t => {
  const reply = 'The build compiled cleanly, but the style check caught one thing: the muted-note icon used raw colour codes. '.repeat(6).trim();
  const f = await loveSpotFixture({ colorScheme, reply, replyDelay: 200 });
  t.after(() => f.close());
  const { page } = f;
  await page.setViewportSize({ width: 1000, height: 640 });
  await f.open(page);
  const bounds = await page.locator('.excalidraw').boundingBox();
  await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.press('t');
  await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.type('How is the build?'); await page.keyboard.press('Escape');
  const scene = await f.waitFor(s => s.elements.some(e => e.id === 'love-reply-turn-1' && !e.isDeleted), 'Matilda did not answer', 20000);
  const note = scene.elements.find(e => e.id === 'love-reply-turn-1'), face = scene.elements.find(e => e.id === 'love-face-turn-1');
  // Opening Love Spot again shows her newest note, as a chat opens at its last message. In a short window too, as with
  // the screenshot tray open: the board is about 500 px tall.
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await f.open(page);
  await page.waitForTimeout(600);
  const view = await boardView(page), shownNote = onScreen(view, note), shownFace = onScreen(view, face);
  const toolbar = await page.locator('.excalidraw .App-toolbar').boundingBox(), board = await page.locator('.excalidraw').boundingBox();
  const zoomBar = await page.locator('.excalidraw .layer-ui__wrapper__footer-left').boundingBox();
  assert.ok(Math.min(shownNote.y, shownFace.y) >= toolbar.y + toolbar.height, `her note and face start below the board's toolbar: ${JSON.stringify({ shownNote, shownFace, toolbar })}`);
  assert.ok(shownNote.y + shownNote.height <= zoomBar.y && shownNote.x + shownNote.width <= board.x + board.width, `and end above the zoom bar, inside the board: ${JSON.stringify({ shownNote, zoomBar, board })}`);
  // The same type in both themes: Excalidraw's 20 px Nunito, drawn at the board's zoom.
  assert.deepEqual([note.fontSize, note.fontFamily], [20, 6]);
  // What he sees of her face, against the face itself: brightness rises and falls together (a negative turns it around).
  const picture = await page.screenshot({ clip: shownFace });
  const match = await page.evaluate(async ([shown, wanted]) => {
    const load = async source => { const image = Object.assign(new Image(), { src: source }); await image.decode(); const context = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }).getContext('2d'); context.drawImage(image, 0, 0, 64, 64); return context.getImageData(0, 0, 64, 64).data; };
    const a = await load(shown), b = await load(wanted), x = [], y = [];
    for (let i = 0; i < a.length; i += 4) {
      const px = i / 4 % 64, py = Math.floor(i / 4 / 64);
      if ((px - 32) ** 2 + (py - 32) ** 2 > 26 ** 2) continue;
      x.push(a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11); y.push(b[i] * 0.3 + b[i + 1] * 0.59 + b[i + 2] * 0.11);
    }
    const mean = v => v.reduce((s, n) => s + n, 0) / v.length, mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0; x.forEach((n, i) => { sxy += (n - mx) * (y[i] - my); sxx += (n - mx) ** 2; syy += (y[i] - my) ** 2; });
    return sxy / Math.sqrt(sxx * syy);
  }, [`data:image/png;base64,${picture.toString('base64')}`, BOARD_FACE.dataURL]);
  assert.ok(match > 0.8, `her face on the ${colorScheme} board matches her picture, not its negative (brightness correlation ${match.toFixed(2)})`);
  if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/matilda-pet-board-${colorScheme}.png` });
  assert.deepEqual(f.errors, []);
});

for (const colorScheme of ['light', 'dark']) test(`pinned Matilda drags anywhere inside the window with her small chat, and nothing under her moves (${colorScheme})`, { timeout: 60000 }, async t => {
  const { fixture } = require('./parity-fixture.cjs');
  const f = await fixture({ colorScheme, width: 1000, height: 800, staticDir: process.env.ELPIS_TEST_OUT || undefined, routes: {
    '/api/love-spot/companion': () => ({ pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' }),
    '/api/love-spot/talk': () => ({ entries: [{ turnId: 'old', item: { id: 'old-a', type: 'agentMessage', text: 'Hey, love.' } }], busy: false }),
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page, presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  const avatar = presence.getByRole('button', { name: 'Chat with Matilda', exact: true });
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  await f.composer.fill('Main chat draft stays here');
  const layout = async () => ({ draft: await f.composer.inputValue(), active: await page.locator('.thread-row.active').getAttribute('data-thread-id'), composer: await page.locator('.composer').boundingBox(), chat: await page.locator('.chat-scroll').boundingBox(), header: await page.locator('.workspace-header').boundingBox() });
  const before = await layout();
  const titleBar = await page.locator('.title-bar').boundingBox(), chrome = titleBar.y + titleBar.height;
  // Electron moves the window from any part of the title bar that nothing marks as its own: there she could be neither
  // pressed nor dragged again, and the controls of her chat stopped answering.
  for (const part of ['.matilda-float', '.matilda-face']) assert.equal(await page.locator(part).evaluate(el => getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('app-region')), 'no-drag', part);
  const drag = async (dx, dy, during) => {
    const face = await avatar.boundingBox();
    await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(face.x + face.width / 2 + dx * i / 10, face.y + face.height / 2 + dy * i / 10); await during?.(); }
    await page.mouse.up();
    return presence.boundingBox();
  };
  // Across the composer and the conversation: no text gets selected, and nothing under her moves or changes size.
  let selected = '';
  const across = await drag(-500, -300, async () => { selected += await page.evaluate(() => String(getSelection())); });
  assert.equal(selected, '', 'dragging her selects no text');
  assert.equal(await mini.count(), 0, 'a drag never opens her chat');
  assert.deepEqual(await layout(), before, 'the composer, conversation and header stay where they were');
  // Past the top-left corner she stops at the edge of the window, below the title bar.
  const corner = await drag(-900, -900);
  assert.ok(Math.abs(corner.x) < 1 && Math.abs(corner.y - chrome) < 1, `she stops inside the window, below the title bar: ${JSON.stringify({ corner, chrome })}`);
  await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await presence.waitFor();
  assert.deepEqual(await presence.boundingBox(), corner, 'where she was put survives a reload');
  assert.ok(across.x > corner.x);

  // Her chat goes with her. Opened low in the window it sits above her; dragged up past the middle, it stays on that side
  // until she is dropped, and then fits inside the window below the title bar.
  await drag(700, 600);
  await avatar.click(); await mini.waitFor();
  const popup = page.locator('.matilda-mini-popup');
  for (const part of ['.matilda-mini-popup']) assert.equal(await page.locator(part).evaluate(el => getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('app-region')), 'no-drag', part);
  const sides = [];
  const side = async () => { const her = await presence.boundingBox(), chat = await popup.boundingBox(); return chat.y + chat.height <= her.y + 1 ? 'above' : chat.y >= her.y + her.height - 1 ? 'below' : 'over'; };
  await drag(-200, -450, async () => sides.push(await side()));
  assert.deepEqual([...new Set(sides)], ['above'], `her chat stays above her for the whole drag: ${sides.join(' ')}`);
  await mini.waitFor();
  const dropped = await popup.boundingBox();
  assert.ok(dropped.y >= chrome - 1 && dropped.x >= -1 && dropped.x + dropped.width <= 1001 && dropped.y + dropped.height <= 801, `her chat fits inside the window below the title bar: ${JSON.stringify({ dropped, chrome })}`);
  assert.deepEqual(await layout(), before, 'and the main chat is still untouched');
  if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/matilda-pet-float-${colorScheme}.png` });
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  assert.deepEqual(f.errors, []);
});

// 29 Oct, Masih, with two screenshots of her chat: "took two screenshots of the pinned version of matilda which is wrong.
// fix them too." The box to message her floated mid-panel over empty space, the top message was cut by the panel's edge,
// and only his questions showed: her replies were below the fold. The panel hugs its messages and box, never scrolls
// itself, fades its messages at the edges, and shows the newest message, hers too.
for (const colorScheme of ['light', 'dark']) test(`her chat hugs its messages, opens at the newest one, and never scrolls as a whole (${colorScheme})`, { timeout: 60000 }, async t => {
  const { fixture } = require('./parity-fixture.cjs');
  const question = n => `Question ${n}: I read the first chapter; can you explain certain parts, including those images and other tricky parts that I need to know here?`;
  const say = (turnId, type, text) => ({ turnId, item: type === 'agentMessage' ? { id: `${turnId}-a`, type, text } : { id: `${turnId}-u`, type, content: [{ type: 'text', text }] } });
  let entries = [1, 2, 3].flatMap(n => [say(`t${n}`, 'userMessage', question(n)), say(`t${n}`, 'agentMessage', `Answer ${n}: the images show the transaction log.`)]), busy = false;
  const f = await fixture({ colorScheme, width: 1000, height: 800, routes: {
    '/api/love-spot/companion': () => ({ pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' }),
    '/api/love-spot/talk': body => {
      if (body) { entries = [...entries, say('t4', 'userMessage', body.text)]; busy = true; }
      return { entries, busy };
    },
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page, presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click(); await mini.waitFor();
  await mini.getByRole('button', { name: 'Show previous messages', exact: true }).click();
  const log = mini.getByRole('log', { name: 'Matilda conversation', exact: true }); await log.waitFor();
  const geometry = () => page.evaluate(() => {
    const popup = document.querySelector('.matilda-mini-popup'), log = document.querySelector('.matilda-mini-messages'), box = document.querySelector('.matilda-mini-composer');
    const p = popup.getBoundingClientRect(), l = log.getBoundingClientRect(), b = box.getBoundingClientRect(), last = [...log.querySelectorAll('.matilda-mini-message')].at(-1).getBoundingClientRect();
    return { popupScroll: popup.scrollTop, popupOverflow: popup.scrollHeight - popup.clientHeight, height: Math.round(p.height), below: Math.round(p.bottom - b.bottom), above: Math.round(l.top - p.top), logScroll: Math.round(log.scrollTop), newestShown: last.top >= l.top - 1 && last.bottom <= l.bottom + 1 };
  });
  // His screenshots, in order: in order and in turn, his questions and her answers; the newest shown on opening.
  assert.deepEqual(await log.locator('.matilda-mini-message').evaluateAll(els => els.map(el => `${el.dataset.speaker} ${el.textContent.replace(/^(You|Matilda): /, '').slice(0, 8)}`)),
    ['you Question', 'matilda Answer 1', 'you Question', 'matilda Answer 2', 'you Question', 'matilda Answer 3']);
  const opened = await geometry();
  assert.ok(opened.newestShown, `her newest answer is in view when the earlier messages open: ${JSON.stringify(opened)}`);
  // The panel never scrolls itself (screen-reader labels inside the scrolling messages used to stretch it), so the wheel
  // over the messages moves only them: no empty panel under the message box, no top message cut by the panel's edge.
  const area = await log.boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  for (const dy of [-400, 400, 400, 400, -200]) {
    await page.mouse.wheel(0, dy); await page.waitForTimeout(120);
    const now = await geometry();
    assert.ok(now.popupScroll === 0 && now.popupOverflow <= 1, `the panel itself never scrolls: ${JSON.stringify(now)}`);
    assert.ok(now.below <= 10 && now.above <= 10, `the message box sits at the bottom and the messages at the top, inside the panel's padding: ${JSON.stringify(now)}`);
    assert.equal(now.height, opened.height, 'and the panel keeps its height');
  }
  // Scrolled midway, the message at the top edge fades into the panel instead of being cut mid-line.
  await log.evaluate(el => { el.scrollTop = el.scrollHeight / 3; });
  const picture = async clip => page.evaluate(async source => {
    const image = Object.assign(new Image(), { src: source }); await image.decode();
    const context = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height }).getContext('2d'); context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, image.width, image.height).data];
  }, `data:image/png;base64,${(await page.screenshot({ clip })).toString('base64')}`);
  const panel = await page.locator('.matilda-mini-popup').boundingBox(), edge = await log.boundingBox();
  const fill = (await picture({ x: panel.x + 4, y: edge.y + edge.height / 2, width: 1, height: 1 })).slice(0, 3);
  const strip = await picture({ x: edge.x + 8, y: edge.y + 1, width: edge.width - 24, height: 1 });
  let worst = 0; for (let i = 0; i < strip.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(strip[i + c] - fill[c]));
  assert.ok(worst <= 24, `the top edge of the messages fades into the panel (largest difference ${worst})`);
  // Her answers are as readable as his questions, in both themes.
  const contrast = await log.locator('[data-speaker="matilda"]').last().evaluate(el => {
    const rgb = value => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = value; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const text = lum(rgb(getComputedStyle(el.querySelector('p') ?? el).color)), back = lum(rgb(getComputedStyle(el.closest('.matilda-mini-popup')).backgroundColor));
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
  });
  assert.ok(contrast >= 4.5, `her answer reads at ${contrast.toFixed(1)}:1`);
  if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/matilda-pet-chat-${colorScheme}.png` });

  // While she replies the chat asks every second; asking again changes nothing he sees: the panel keeps its height and
  // where he scrolled to, and it shows the newest message only when one arrives.
  await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).fill('And the second chapter?');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await log.getByText('And the second chapter?', { exact: true }).waitFor(); await mini.getByRole('status').waitFor();
  const sent = await geometry();
  assert.ok(sent.newestShown, `what he just sent is in view: ${JSON.stringify(sent)}`);
  await log.evaluate(el => { el.scrollTop = 40; });
  await page.waitForTimeout(2300);
  const waited = await geometry();
  assert.deepEqual([waited.height, waited.logScroll, waited.popupScroll], [sent.height, 40, 0], 'asking again moves nothing');
  entries = [...entries, say('t4', 'agentMessage', 'Answer 4: chapter two builds on it.')]; busy = false;
  await mini.getByText('Answer 4: chapter two builds on it.', { exact: true }).waitFor({ timeout: 5000 });
  await mini.getByRole('status').waitFor({ state: 'hidden' });
  const answered = await geometry();
  assert.ok(answered.newestShown && answered.popupScroll === 0, `her new answer comes into view: ${JSON.stringify(answered)}`);
  assert.deepEqual(f.errors, []);
});
