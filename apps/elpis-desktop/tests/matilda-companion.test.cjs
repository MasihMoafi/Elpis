const test = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

// Fitting her into a narrow window is temporary: it never rewrites where she was put (27 Oct: she "jumps from top
// right to that position when I opened something").
test('a narrow window keeps Matilda on screen, then she returns to her place', { timeout: 60000 }, async t => {
  const f = await loveSpotFixture({ colorScheme: 'light' });
  t.after(() => f.close());
  const page = f.page;
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('.app-menus').waitFor();
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true });
  await presence.waitFor();
  const home = await presence.boundingBox();
  await page.setViewportSize({ width: 300, height: 760 });
  await page.waitForFunction(() => { const r = document.querySelector('[aria-label="Pinned Matilda"]').getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth + 1; });
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(250);
  const back = await presence.boundingBox();
  assert.ok(Math.abs(back.x - home.x) < 1 && Math.abs(back.y - home.y) < 1, `she returns to her place: ${JSON.stringify({ home, back })}`);
  assert.deepEqual(f.errors ?? [], []);
});

for (const colorScheme of ['light', 'dark']) test(`Matilda floats out of the title bar and stays put across app pages, with global Unpin (${colorScheme})`, { timeout: 60000 }, async t => {
  const f = await loveSpotFixture({ colorScheme });
  t.after(() => f.close());
  const page = f.page;
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('.app-menus').waitFor();
  const pin = page.getByRole('button', { name: 'Pin Matilda', exact: true });
  await pin.waitFor({ timeout: 3000 });
  const start = await pin.boundingBox();
  assert.ok(start.y < 36, JSON.stringify(start));
  await pin.click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true });
  await presence.waitFor();
  // 28 Oct: "I don't like this to be here" (the title bar). She floats at the bottom right until moved.
  const placed = await presence.boundingBox();
  assert.ok(placed.y > 36 && placed.x + placed.width > 1000 - 120 && placed.y + placed.height > 800 - 120, JSON.stringify(placed));
  for (const name of ['Workflows', 'Customize', 'Love Spot']) {
    await page.locator('.nav-list').getByRole('button', { name, exact: true }).click();
    assert.deepEqual(await presence.boundingBox(), placed, name);
  }
  const before = (await f.scene()).elements.filter(e => !e.isDeleted).map(e => e.id).sort();
  const avatar = presence.getByRole('button', { name: 'Chat with Matilda', exact: true });
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  await avatar.click(); await mini.waitFor();
  await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).fill('Keep this unsent');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  assert.equal(await avatar.evaluate(el => el === document.activeElement), true);
  await avatar.click(); await mini.waitFor();
  assert.equal(await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).inputValue(), 'Keep this unsent');
  await page.locator('.love-spot-editor').click({ position: { x: 40, y: 300 } });
  await mini.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await presence.waitFor();
  await page.reload();
  await page.locator('.app-menus').waitFor();
  await presence.waitFor();
  await page.setViewportSize({ width: 360, height: 760 });
  const box = await presence.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 360 && box.y > 36 && box.y + box.height <= 760, JSON.stringify(box));
  await page.getByRole('button', { name: 'Unpin Matilda', exact: true }).focus();
  await page.keyboard.press('Enter');
  await pin.waitFor();
  assert.equal(await presence.count(), 0);
  const tucked = await pin.boundingBox();
  assert.ok(tucked.x >= 0 && tucked.x + tucked.width <= 360 && tucked.y < 36, JSON.stringify(tucked));
  assert.deepEqual((await f.scene()).elements.filter(e => !e.isDeleted).map(e => e.id).sort(), before);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.reload();
  await page.locator('.app-menus').waitFor();
  await pin.waitFor();
  assert.equal(await presence.count(), 0);
  assert.equal(f.requests.some(url => /\/agents\/run|\/turn\/interrupt/.test(url)), false);
});


for (const colorScheme of ['light', 'dark']) test(`Matilda mini chat, mute and dragging leave the main conversation unchanged (${colorScheme})`, { timeout: 60000 }, async t => {
  const { fixture } = require('./parity-fixture.cjs');
  const { FACE_DATA_URL } = require('../bridge/matilda-face.cjs');
  let music = { title: 'Linkin Park masterpiece', artist: 'Linkin Park', uri: 'file:///favorite.m4a', status: 'Playing', canMute: true, muted: false };
  let entries = [], replyMode = 'ok', release, slowArrived;
  const slowStarted = new Promise(resolve => { slowArrived = resolve; });
  const talk = () => ({ entries, busy: false });
  const f = await fixture({ colorScheme, nativeClipboard: true, width: 1000, height: 800, routes: {
    '/api/love-spot/companion': body => {
      if (body?.action === 'toggle-mute') music = { ...music, muted: !music.muted };
      return { pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: { ...music }, music, reason: '' };
    },
    '/api/love-spot/talk': async body => {
      if (!body) return talk();
      if (replyMode === 'failure') return { __http: 503, error: 'Matilda could not send this message.' };
      if (replyMode === 'slow') await new Promise(resolve => { release = resolve; slowArrived(); });
      const id = `mini-${entries.length}`;
      // Recorded as the engine records it: what was typed, then each attached file as its own tagged text part.
      const notes = 'File: Love Spot notes.txt\nCurrent Love Spot board notes (by colour):\n[]';
      entries = [...entries, { turnId: id, item: { id, type: 'userMessage', content: [{ type: 'text', text: body.text }, { type: 'text', text: notes, text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(notes) }, placeholder: 'Attachment: Love Spot notes.txt' }] }] } }, { turnId: id, item: { id: `${id}-reply`, type: 'agentMessage', text: 'Matilda heard you.' } }];
      return talk();
    },
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page, presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  const avatar = presence.getByRole('button', { name: 'Chat with Matilda', exact: true });
  assert.equal(await avatar.getByAltText('Matilda', { exact: true }).count(), 1, 'the avatar itself opens the mini chat');
  assert.equal(await presence.getByRole('button').count(), 4, 'avatar, resize, mute and unpin; no separate chat or music-menu button');
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  const field = mini.getByRole('textbox', { name: 'Message Matilda', exact: true });
  const sends = () => f.posts.filter(post => post.path === '/api/love-spot/talk');
  await f.composer.fill('Main chat draft stays here');
  const mainState = async () => ({ url: page.url(), active: await page.locator('.thread-row.active').getAttribute('data-thread-id'), draft: await f.composer.inputValue(), composer: await page.locator('.composer').boundingBox(), chat: await page.locator('.chat-scroll').boundingBox() });
  const mainBefore = await mainState();
  await presence.getByRole('button', { name: 'Mute music', exact: true }).click();
  await presence.getByRole('button', { name: 'Unmute music', exact: true }).waitFor();
  assert.equal(await mini.count(), 0, 'mute opens no panel');
  await presence.getByRole('button', { name: 'Unmute music', exact: true }).click();
  await presence.getByRole('button', { name: 'Mute music', exact: true }).waitFor();
  assert.deepEqual(f.posts.filter(post => post.path === '/api/love-spot/companion').map(post => post.body.action), ['toggle-mute', 'toggle-mute']);
  assert.deepEqual(await mainState(), mainBefore);

  await avatar.click(); await mini.waitFor();
  await page.evaluate(() => navigator.clipboard.writeText('Pasted message'));
  await field.focus(); await page.keyboard.press('Control+V');
  await field.press('End'); await field.pressSequentially(' and typed text');
  assert.equal(await field.inputValue(), 'Pasted message and typed text');
  await page.waitForTimeout(650);
  assert.equal(sends().length, 0, 'paste, typing and pause never auto-send');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await avatar.click(); await mini.waitFor();
  assert.equal(await field.inputValue(), 'Pasted message and typed text', 'dismissal preserves unsent text');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('Matilda heard you.', { exact: true }).waitFor();
  assert.equal(await mini.getByText('Pasted message and typed text', { exact: true }).count(), 1, 'the small chat shows what was typed');
  assert.equal(await mini.getByText(/Love Spot notes|board notes/).count(), 0, 'attached board notes are not shown as part of the message');
  assert.equal(sends().length, 1, 'explicit Send posts exactly once');
  assert.equal(sends()[0].body.text, 'Pasted message and typed text');
  assert.equal(await field.inputValue(), '');
  assert.deepEqual(await mainState(), mainBefore);

  replyMode = 'failure'; await field.fill('Keep failed message');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByRole('alert').filter({ hasText: 'Matilda could not send' }).waitFor();
  assert.equal(await field.inputValue(), 'Keep failed message');
  assert.equal(sends().length, 2);
  replyMode = 'slow'; await field.fill('Slow message');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.matilda-mini-status'));
  await field.fill('New text while waiting');
  assert.equal(sends().length, 3);
  await slowStarted; release();
  await mini.getByRole('status').waitFor({ state: 'hidden' });
  assert.equal(await field.inputValue(), 'New text while waiting', 'a slow acknowledgement cannot erase later typing');
  assert.deepEqual(await mainState(), mainBefore);
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });

  const before = await presence.boundingBox(), face = await avatar.boundingBox();
  await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2);
  await page.mouse.down(); await page.mouse.move(face.x - 180, face.y - 140, { steps: 8 }); await page.mouse.up();
  const dragged = await presence.boundingBox();
  assert.ok(dragged.x < before.x - 150 && dragged.y < before.y - 100, JSON.stringify({ before, dragged }));
  assert.equal(await mini.count(), 0, 'a drag never opens the mini chat');
  const hit = await avatar.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
  assert.equal(hit, true, 'the moved avatar stays visible and usable above the page');
  await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await presence.waitFor();
  assert.deepEqual(await presence.boundingBox(), dragged, 'position survives a reload');
  await avatar.focus(); await page.keyboard.press('Shift+ArrowLeft');
  const keyed = await presence.boundingBox(); assert.equal(Math.round(dragged.x - keyed.x), 30);
  assert.equal(await mini.count(), 0, 'keyboard movement never opens the mini chat');
  // 28 Oct: "I should be able to increase its size just like I could with Dot". Her corner grows her up and left.
  const handle = presence.getByRole('button', { name: 'Resize Matilda', exact: true });
  await avatar.hover(); const corner = await handle.boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
  await page.mouse.move(corner.x - 60, corner.y - 60, { steps: 6 }); await page.mouse.up();
  const big = await presence.boundingBox();
  assert.ok(big.width - keyed.width > 50 && big.width === big.height, JSON.stringify({ keyed, big }));
  assert.ok(Math.abs(big.x + big.width - keyed.x - keyed.width) < 2 && Math.abs(big.y + big.height - keyed.y - keyed.height) < 2, 'her bottom-right corner stays put');
  await handle.focus(); await page.keyboard.press('-');
  const sized = await presence.boundingBox(); assert.equal(Math.round(big.width - sized.width), 8, 'the minus key makes her smaller');
  assert.equal(await mini.count(), 0, 'resizing never opens the mini chat');
  await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await presence.waitFor();
  assert.deepEqual(await presence.boundingBox(), sized, 'size survives a reload');
  await page.evaluate(() => window.__push({ visible: true, activeId: 'page-proof', fullView: 0, tabs: [{ id: 'page-proof', url: 'https://example.invalid/', title: 'Native page', comments: 0, zoom: 100 }] }));
  const viewport = page.locator('.browser-viewport'); await viewport.waitFor();
  const browser = await viewport.boundingBox(), grip = await avatar.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(browser.x + browser.width / 2, browser.y + browser.height / 2, { steps: 8 }); await page.mouse.up();
  const kept = await presence.boundingBox();
  assert.ok(kept.y + kept.height <= browser.y || kept.x + kept.width <= browser.x || kept.x >= browser.x + browser.width, JSON.stringify({ kept, browser }));
  assert.equal(await mini.count(), 0);
  await page.evaluate(() => window.__push({ fullView: 1 }));
  await page.getByRole('button', { name: 'Collapse floating chat', exact: true }).click();
  assert.equal(await f.composer.isVisible(), false);
  await avatar.click(); await mini.waitFor();
  assert.equal(await f.composer.isVisible(), false, 'mini chat does not reopen the main floating conversation');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.__push({ visible: false, activeId: null, tabs: [] }));
  await viewport.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 360, height: 400 });
  await page.waitForFunction(() => { const r = document.querySelector('[aria-label="Pinned Matilda"]').getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight; });
  await avatar.click(); await mini.waitFor();
  const small = await mini.boundingBox(); assert.ok(small.x >= 0 && small.x + small.width <= 361, JSON.stringify(small));
  await page.keyboard.press('Escape');
  const fs = require('node:fs/promises'), path = require('node:path');
  const evidence = '/home/masih/.cache/elpis-tests/avatar-proof'; await fs.mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.screenshot({ path: path.join(evidence, `drag-${colorScheme}.png`) });
  assert.deepEqual(f.errors, []);
});

// 28 Oct: "that small chatbox shouldn't show previous messages; it's for quick new chats", like Dot's "Start new chat".
// And her reply had arrived while the small chat still said "Matilda is replying…": one failed read ended the asking.
test('the small chat starts fresh, keeps earlier turns behind a button, and asks until her reply arrives', { timeout: 60000 }, async t => {
  const { fixture } = require('./parity-fixture.cjs');
  const { FACE_DATA_URL } = require('../bridge/matilda-face.cjs');
  const say = (turnId, type, text) => ({ turnId, item: type === 'agentMessage' ? { id: `${turnId}-a`, type, text } : { id: `${turnId}-u`, type, content: [{ type: 'text', text }] } });
  let entries = [say('old', 'userMessage', 'An old question'), say('old', 'agentMessage', 'An old answer')], busy = false, reads = 0;
  const f = await fixture({ width: 1000, height: 800, routes: {
    '/api/love-spot/companion': () => ({ pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' }),
    '/api/love-spot/talk': body => {
      if (body) { entries = [...entries, say('new', 'userMessage', body.text)]; busy = true; reads = 0; return { entries, busy }; }
      if (busy && ++reads === 1) return { __http: 503, error: 'Temporarily disconnected' };
      if (busy && reads >= 3) { entries = [...entries, say('new', 'agentMessage', 'Hey, love.')]; busy = false; }
      return { entries, busy };
    },
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page, presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click(); await mini.waitFor();
  const earlier = mini.getByRole('button', { name: 'Show previous messages', exact: true }); await earlier.waitFor();
  assert.equal(await mini.getByText('An old answer', { exact: true }).count(), 0, 'a quick chat starts fresh');
  await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).fill('hey');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('Hey, love.', { exact: true }).waitFor({ timeout: 10000 });
  await mini.getByRole('status').waitFor({ state: 'hidden' });
  assert.equal(await mini.getByText('hey', { exact: true }).count(), 1, 'what was just said shows');
  await earlier.click();
  await mini.getByText('An old answer', { exact: true }).waitFor();
  // 28 Oct: "it should have some animation (some other shots of her)": a smile, a laugh and a kiss lie over her face.
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  const avatar = presence.getByRole('button', { name: 'Chat with Matilda', exact: true }), shown = () => avatar.locator('img[data-shown="true"]').evaluateAll(els => els.map(el => el.dataset.mood));
  assert.deepEqual(await avatar.locator('img.matilda-mood').evaluateAll(els => els.map(el => el.dataset.mood)), ['smile', 'laugh', 'kiss']);
  assert.equal(await avatar.getByAltText('Matilda', { exact: true }).count(), 1, 'her shots are decoration: one Matilda for a screen reader');
  await page.mouse.move(0, 400); await avatar.hover();
  assert.deepEqual(await shown(), ['smile'], 'she smiles while hovered');
  await page.mouse.move(0, 400);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Pinned Matilda"] img[data-shown="true"]'));
  assert.deepEqual(f.errors, []);
});
