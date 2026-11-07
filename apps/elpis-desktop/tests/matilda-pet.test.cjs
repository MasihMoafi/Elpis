// Matilda as a pet, 29 Oct. Masih, on Love Spot in dark mode: "This is matilda in dark mode!" (her face showed as a photo
// negative). And: "the pinned Matilda is very awkward in that I can't drag and move her properly without breaking the
// chatbox. This is a replica, supposed to be a replica of pets in chatgpt app": she floats over everything, moves
// anywhere inside the window and takes her small chat with her, and nothing under her moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FACE_DATA_URL } = require('../bridge/matilda-face.cts');

// Where Excalidraw shows the board: its own view state, read from the editor component that draws `.excalidraw`.

// 29 Oct, Masih, with two screenshots of her chat: "took two screenshots of the pinned version of matilda which is wrong.
// fix them too." The box to message her floated mid-panel over empty space, the top message was cut by the panel's edge,
// and only his questions showed: her replies were below the fold. The panel hugs its messages and box, never scrolls
// itself, fades its messages at the edges, and shows the newest message, hers too.
for (const colorScheme of ['light']) test(`her chat hugs its messages, opens at the newest one, and never scrolls as a whole (${colorScheme})`, { timeout: 60000 }, async t => {
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
  const panelRgb = await page.locator('.matilda-mini-popup').evaluate(el => {
    const context = document.createElement('canvas').getContext('2d'); context.fillStyle = getComputedStyle(el).backgroundColor; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  if (colorScheme === 'light') assert.ok(panelRgb.every(value => value >= 240 && value < 255), `her light panel is slightly darker: ${panelRgb}`);
  else assert.deepEqual(panelRgb, [17, 19, 23], 'her dark panel is unchanged');
  // 1 Nov, Masih (commit 0a1e78459): like a pinned pet, the pop-up shows only what is said now; its history icon opens the
  // earlier messages. His 29 Oct screenshots were of those earlier messages, so they are opened first.
  const log = mini.getByRole('log', { name: 'Matilda conversation', exact: true });
  assert.equal(await log.count(), 0, 'no earlier messages until the history icon is pressed');
  await mini.getByRole('button', { name: 'Show earlier messages', exact: true }).click(); await log.waitFor();
  const geometry = () => page.evaluate(() => {
    const popup = document.querySelector('.matilda-mini-popup'), log = document.querySelector('.matilda-mini-messages'), box = document.querySelector('.matilda-mini-composer');
    const p = popup.getBoundingClientRect(), l = log.getBoundingClientRect(), b = box.getBoundingClientRect(), last = [...log.querySelectorAll('.matilda-mini-message')].at(-1).getBoundingClientRect();
    return { popupScroll: popup.scrollTop, popupOverflow: popup.scrollHeight - popup.clientHeight, height: Math.round(p.height), below: Math.round(p.bottom - b.bottom), above: Math.round(l.top - (popup.querySelector('.matilda-mini-bar')?.getBoundingClientRect().bottom ?? p.top)), logScroll: Math.round(log.scrollTop), newestShown: last.top >= l.top - 1 && last.bottom <= l.bottom + 1 };
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
    // The messages start right under the history icon's bar (1 Nov, commit 0a1e78459), or the panel's top without it.
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
  await log.getByText('And the second chapter?', { exact: true }).waitFor(); await mini.getByRole('status').filter({ hasText: 'Matilda is replying' }).waitFor();
  const sent = await geometry();
  assert.ok(sent.newestShown, `what he just sent is in view: ${JSON.stringify(sent)}`);
  await log.evaluate(el => { el.scrollTop = 40; });
  await page.waitForTimeout(2300);
  const waited = await geometry();
  assert.deepEqual([waited.height, waited.logScroll, waited.popupScroll], [sent.height, 40, 0], 'asking again moves nothing');
  entries = [...entries, say('t4', 'agentMessage', 'Answer 4: chapter two builds on it.')]; busy = false;
  await mini.getByText('Answer 4: chapter two builds on it.', { exact: true }).waitFor({ timeout: 5000 });
  await mini.getByRole('status').filter({ hasText: 'Matilda is replying' }).waitFor({ state: 'hidden' });
  const answered = await geometry();
  assert.ok(answered.newestShown && answered.popupScroll === 0, `her new answer comes into view: ${JSON.stringify(answered)}`);
  assert.deepEqual(f.errors, []);
});
