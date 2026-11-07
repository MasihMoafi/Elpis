// The chat as Claude's desktop app has it: Back and Forward between chats and pages, a message menu (copy, rewind,
// edit, fork), a rail of ticks that marks each prompt, a side panel whose header lines up with the chat tabs while the
// message box keeps one row, and a tight gap under each reply. Local bridge fixture with a fake desktop; no engine.
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
type Locator = {
  locator(selector: string, options?: object): Locator;
  getByRole(role: string, options?: object): Locator;
  filter(options: object): Locator;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  waitFor(options?: object): Promise<void>;
  click(options?: object): Promise<void>;
  hover(): Promise<void>;
  focus(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  count(): Promise<number>;
  isDisabled(): Promise<boolean>;
  allInnerTexts(): Promise<string[]>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  scrollIntoViewIfNeeded(): Promise<void>;
  evaluate<T>(fn: (element: HTMLElement) => T): Promise<T>;
};
type Page = {
  locator(selector: string, options?: object): Locator;
  getByRole(role: string, options?: object): Locator;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void>; press(key: string): Promise<void>; type(text: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
  clock: { install(): Promise<void>; pauseAt(time: number): Promise<void>; runFor(ms: number): Promise<void> };
  context(): { newCDPSession(page: Page): Promise<{ send(method: string, params: object): Promise<void> }> };
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: object): Promise<void>;
  reload(): Promise<void>;
};
type Fixture = { page: Page; composer: Locator; turns: string[][]; errors: unknown[]; open(id: string): Promise<void>; close(): Promise<void>; shown(): Promise<string | null>; copied(): Promise<string> };
const { fixture }: { fixture(options: object): Promise<Fixture> } = require('./parity-fixture.cjs');
const { oranges }: { oranges(page: Page): Promise<string[]> } = require('./controls.cts');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
const { dragMessageText }: { dragMessageText(page: Page, message: Locator, fragment: string): Promise<void> } = require('./message-copy.cts');

async function using(options: object, run: (fixture: Fixture) => Promise<void>) {
  const f = await fixture(options);
  try { await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); }
}
const eventually = async (check: () => void | Promise<void>) => { const end = Date.now() + 4000; for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } } };

test('Back and Forward walk the chats and pages visited: the buttons, Alt+Left and Alt+Right, and the mouse side buttons', () => using({}, async f => {
  const { page } = f;
  const back = page.getByRole('button', { name: 'Back', exact: true }), forward = page.getByRole('button', { name: 'Forward', exact: true });
  await back.waitFor();
  assert.equal(await back.isDisabled(), true); assert.equal(await forward.isDisabled(), true);
  await f.open('chat-a'); await f.open('chat-b'); await f.open('chat-c');
  assert.equal(await back.isDisabled(), false); assert.equal(await forward.isDisabled(), true);
  await back.click(); await eventually(async () => assert.equal(await f.shown(), 'chat-b'));
  const keys = async (key: string) => { await page.keyboard.down('Alt'); await page.keyboard.press(key); await page.keyboard.up('Alt'); };
  await keys('ArrowLeft'); await eventually(async () => assert.equal(await f.shown(), 'chat-a'));
  const cdp = await page.context().newCDPSession(page);
  const side = async (button: 'back' | 'forward') => { for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: 640, y: 300, button, buttons: type === 'mousePressed' ? (button === 'back' ? 8 : 16) : 0, clickCount: 1 }); };
  await side('back'); await eventually(async () => assert.equal(await f.shown(), null, 'back to the empty new chat they started in'));
  assert.equal(await back.isDisabled(), true);
  await side('forward'); await eventually(async () => assert.equal(await f.shown(), 'chat-a'));
  await keys('ArrowRight'); await eventually(async () => assert.equal(await f.shown(), 'chat-b'));
  await forward.click(); await eventually(async () => assert.equal(await f.shown(), 'chat-c'));
  assert.equal(await forward.isDisabled(), true);
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await page.getByRole('heading', { name: 'Lab', exact: true }).first().waitFor();
  await back.click(); await eventually(async () => assert.equal(await f.shown(), 'chat-c'));
  assert.equal(await forward.isDisabled(), false, 'the page left is still ahead');
  await back.click(); await eventually(async () => assert.equal(await f.shown(), 'chat-b'));
  await f.open('chat-a');
  assert.equal(await forward.isDisabled(), true, 'a new visit drops what was ahead');
  await back.click(); await eventually(async () => assert.equal(await f.shown(), 'chat-b'));
}));

// Delete from here (an older prompt) and Delete message (the newest): b30ebb5c7, 3 Nov.
const MENU = { user: ['Reply', 'Copy text', 'Copy as Markdown', 'Edit and retry', 'Rewind to here', 'Delete from here'], reply: ['Reply', 'Copy text', 'Copy as Markdown', 'Fork chat from here'] };
const menuItems = async (page: Page) => { const menu = page.getByRole('menu'); await menu.getByRole('menuitem').first().waitFor(); return (await menu.getByRole('menuitem').allInnerTexts()).map(text => { const [first = ''] = text.split('\n'); return first.trim(); }); };
const closeMenu = async (page: Page) => { await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' }); };

test('right-click on a message keeps the hover … actions and appends Change this…', () => using({}, async f => {
  const { page } = f;
  await f.open('chat-a');
  // The newest prompt ("Run them.") has no Rewind (Masih, 29 Oct, of Rewind on the last message: "rewind what?"; 054e332a6),
  // so the full prompt menu is read on an earlier prompt.
  const prompt = page.locator('.message.user', { hasText: 'Add tests.' }), reply = page.locator('.message.agent', { hasText: 'two passes' });
  await prompt.click({ button: 'right' });
  assert.deepEqual(await menuItems(page), [...MENU.user, 'Change this…']);
  await closeMenu(page);
  const turn = page.locator('.user-turn', { hasText: 'Add tests.' });
  await turn.hover(); await turn.getByRole('button', { name: 'More message actions', exact: true }).click();
  assert.deepEqual(await menuItems(page), MENU.user, 'the … holds the message actions');
  await closeMenu(page);
  await page.locator('.message.user', { hasText: 'Run them.' }).click({ button: 'right' });
  assert.deepEqual(await menuItems(page), [...MENU.user.filter(name => name !== 'Rewind to here' && name !== 'Delete from here'), 'Delete message', 'Change this…'], 'the newest prompt has no Rewind and deletes only itself');
  await closeMenu(page);
  await reply.click({ button: 'right' });
  assert.deepEqual(await menuItems(page), [...MENU.reply, 'Change this…']);
  await closeMenu(page);
  await reply.hover(); await reply.getByRole('button', { name: 'More message actions', exact: true }).click();
  assert.deepEqual(await menuItems(page), MENU.reply);
  await closeMenu(page);
  await page.locator('.message.agent', { hasText: 'All green.' }).click({ button: 'right' });
  assert.ok((await menuItems(page)).includes('Regenerate reply'), 'the last reply can still be regenerated');
}));

// A112: exercise the browser clipboard, not the fixture's writeText recorder.
const COPY_PROMPTS = [
  'First message: copy exactly these words.',
  '  این چند کلمه فارسی را انتخاب کن.\nخط دوم با نیم‌فاصله و  دو فاصله\n\n```js\nconst متن = "سلام";\n  console.log(متن);\n```\n  ',
  `Long message: ${'متن بلند با فارسی و English. '.repeat(50)}\nLast line.`,
  '',
];
for (const colorScheme of ['light']) {
  const copyOptions = {
    nativeClipboard: true, colorScheme, width: 1280, height: 1000,
    chat: COPY_PROMPTS.map((prompt, index) => [`copy-${index}`, prompt, `Copy control reply ${index}.`]),
  };
  const shot = async (page: Page, name: string) => {
    if (!process.env.ELPIS_A112_SHOTS) return;
    await fs.mkdir(process.env.ELPIS_A112_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ELPIS_A112_SHOTS, `${name}-${colorScheme}.png`) });
  };
  test(`own-message mouse selection copies and pastes exact text · ${colorScheme}`, () => using(copyOptions, async f => {
    const { page, composer } = f;
    await f.open('chat-a');
    for (const [index, fragment] of ['exactly these words', 'چند کلمه فارسی', 'Long message'].entries()) {
      const turn = page.locator('.user-turn').nth(index), message = turn.locator('.message.user');
      await dragMessageText(page, message, fragment);
      if (index === 1) await shot(page, 'farsi-selection');
      await page.keyboard.press('Control+c');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fragment, 'Ctrl+C copies just the mouse selection');
      await composer.fill(''); await composer.press('Control+v');
      assert.equal(await composer.inputValue(), fragment, 'selected words paste elsewhere');
    }
    await shot(page, 'selection');
  }));
  test(`own-message visible Copy preserves exact source and feedback · ${colorScheme}`, () => using(copyOptions, async f => {
    const { page, composer } = f;
    await f.open('chat-a');
    for (const index of COPY_PROMPTS.keys()) {
      const turn = page.locator('.user-turn').nth(index);
      const copy = turn.getByRole('button', { name: 'Copy message', exact: true });
      await copy.scrollIntoViewIfNeeded();
      await page.mouse.move(4, 4); await composer.focus();
      await page.waitForTimeout(160); // Let the existing hover fade finish.
      await shot(page, 'copy-at-rest');
      assert.equal(await copy.evaluate(element => { const actions = element.closest('.message-actions'); if (!actions) throw Error('Message actions unavailable'); return getComputedStyle(actions).opacity; }), '1', 'Copy message is visible without discovering a hover-only action row');
      await copy.click();
      await turn.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), COPY_PROMPTS[index], 'Copy preserves source, spaces, newlines, Farsi and code fences');
      if (index === 1) await shot(page, 'farsi-copied');
      await composer.fill(''); await composer.press('Control+v');
      assert.equal(await composer.inputValue(), COPY_PROMPTS[index], 'the whole message pastes exactly');
    }
    await page.reload(); await f.open('chat-a');
    const turn = page.locator('.user-turn').nth(1);
    await turn.getByRole('button', { name: 'Copy message', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), COPY_PROMPTS[1], 'copy still works after reload');
  }));

  test(`reply Copy keeps its source, feedback and hover behavior · ${colorScheme}`, () => using({
    nativeClipboard: true, colorScheme, width: 1280, height: 1000,
    chat: [['copy-control', 'Question for the negative control.', '**Original reply**\n\nمتن فارسی\n\n```js\n  const x = 1;\n```\n']],
  }, async f => {
    const { page } = f;
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    const reply = page.locator('.message.agent'), copy = reply.getByRole('button', { name: 'Copy reply', exact: true });
    await copy.waitFor();
    await page.mouse.move(4, 4);
    assert.equal(await copy.evaluate(element => { const actions = element.closest('.message-actions'); if (!actions) throw Error('Message actions unavailable'); return getComputedStyle(actions).opacity; }), '0', 'reply hover behavior stays unchanged');
    await reply.hover(); await copy.click();
    await reply.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '**Original reply**\n\nمتن فارسی\n\n```js\n  const x = 1;\n```\n');
    assert.equal(await reply.getByRole('button', { name: 'Copy message', exact: true }).count(), 0);
    await eventually(async () => assert.equal(await reply.locator('.message-actions .copy-status').innerText(), '', 'the same success feedback resets'));
  }));
}

test('a newer scroll to the end wins over a prompt jump still settling', () => using({}, async f => {
  const { page } = f;
  await f.open('chat-a');
  await page.clock.install(); await page.clock.pauseAt(Date.now() + 1000);
  const rail = page.getByRole('navigation', { name: 'User messages' });
  await rail.locator('[data-slot="prompt-mark"]').nth(2).click();
  await page.clock.runFor(16);
  await page.locator('.chat-scroll').evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
  // Chromium delivers native scroll events outside the mocked animation clock.
  // Advance frames while awaiting that event and React's resulting render.
  const atEnd = async () => {
    await page.clock.runFor(32);
    assert.equal(await rail.locator('[aria-current="true"]').getAttribute('aria-label'), 'Jump to user message 4');
    assert.ok(await page.locator('.chat-scroll').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 4), 'the old jump never pulls the transcript back');
  };
  await eventually(atEnd);
  await page.clock.runFor(512);
  await atEnd();
}));

for (const colorScheme of ['light']) {
  test(`with the side panel open the panel header lines up with the chat tabs and the message box keeps one row at 1130 px (${colorScheme})`, () => using({ colorScheme }, async f => {
    const { page } = f;
    await f.open('chat-a');
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await page.locator('.side-panel').waitFor();
    await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Terminal' }).click();
    await page.locator('.side-header .task-tab').waitFor();
    const rows = await page.evaluate(() => { const box = (selector: string) => { const element = document.querySelector(selector); if (!element) throw Error('Header unavailable'); const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, height: r.height }; };
      return { header: box('.workspace-header'), side: box('.side-header'), chatTab: box('.workspace-header .task-tab'), sideTab: box('.side-header .task-tab') }; });
    assert.ok(Math.abs(rows.header.top - rows.side.top) <= 1 && Math.abs(rows.header.bottom - rows.side.bottom) <= 1, `the header rows share their top and bottom: ${JSON.stringify([rows.header, rows.side])}`);
    assert.ok(Math.abs(rows.chatTab.mid - rows.sideTab.mid) <= 1 && Math.abs(rows.chatTab.height - rows.sideTab.height) <= 1, `the tabs line up: ${JSON.stringify([rows.chatTab, rows.sideTab])}`);
    const bar = await page.evaluate(() => {
      const composer = document.querySelector('.composer'), pill = document.querySelector('.composer-pill');
      if (!composer || !pill) throw Error('Composer unavailable');
      const outer = composer.getBoundingClientRect(), controls = [...document.querySelectorAll('.composer-controls button, .composer-controls [role="combobox"], .composer-controls select')].filter(node => node.getClientRects().length);
      const tops = controls.map(node => node.getBoundingClientRect().top);
      const label = (selector: string) => { const node = document.querySelector(selector); return node ? Math.round(node.getBoundingClientRect().width) : 0; };
      const visibleWidth = (selector: string) => Math.round(Math.max(0, ...[...document.querySelectorAll(selector)].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().width)));
      return { count: controls.length, spread: Math.max(...tops) - Math.min(...tops), inside: controls.every(node => { const r = node.getBoundingClientRect(); return r.left >= outer.left && r.right <= outer.right; }),
        permission: visibleWidth('.composer-pill span'), words: [...document.querySelectorAll('.composer-pill span')].filter(node => node.getClientRects().length).map(node => node.textContent).join(''), size: getComputedStyle(pill).fontSize, model: label('.model-picker-trigger') };
    });
    assert.ok(bar.count >= 5 && bar.spread <= 4, `one row of ${bar.count} controls, spread ${bar.spread}px`);
    assert.ok(bar.inside, 'every control inside the box');
    assert.ok(bar.permission >= 16 && bar.words.length > 0, `the permission label is shrunk, not hidden: ${bar.permission}px “${bar.words}”`);
    assert.ok(bar.model >= 40, `the model name stays: ${bar.model}px`);
    assert.equal(bar.size, '12px', 'the text is not made smaller');
  }));
}

// 19 Oct (d9f2a0ff4): hover actions hang under a message, so the gap to the next one holds the 28px buttons plus air.
test('the new surfaces paint no orange in the light theme: the @ picker, the + menu, a message menu, the prompt rail, the back buttons and the side panel', () => using({ colorScheme: 'light', storage: { 'elpis-preferences-v1': JSON.stringify({ accent: 'blue' }) } }, async f => {
  const { page, composer } = f;
  await f.open('chat-a');
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  // A87 permits the selected amber accent; a blue accent exposes stray orange without excluding any surface.
  assert.deepEqual(await oranges(page), [], 'the chat with its rail and back buttons');
  await composer.click(); await page.keyboard.type('@'); await page.getByRole('listbox', { name: 'Mentions' }).waitFor();
  assert.deepEqual(await oranges(page), [], 'the @ picker');
  await composer.fill('');
  await page.getByRole('button', { name: 'Add files and more', exact: true }).click(); await page.getByRole('menu').getByRole('menuitem').first().waitFor();
  assert.deepEqual(await oranges(page), [], 'the + menu');
  await closeMenu(page);
  await page.locator('.message.agent', { hasText: 'two passes' }).click({ button: 'right' });
  assert.deepEqual(await oranges(page), [], 'a message menu'); await closeMenu(page);
  await page.getByRole('button', { name: 'Show side panel', exact: true }).click(); await page.locator('.side-panel').waitFor();
  assert.deepEqual(await oranges(page), [], 'the side panel beside the chat');
}));

// Long messages always render in full: no Collapse/Expand control (Masih, 29 Oct: "This collapse message is actually
// implemented in the wrong place. remove it. it's nonsensical!").
for (const colorScheme of ['light']) test(`long messages render in full with no fold control · ${colorScheme}`, () => using({
  colorScheme, width: 1100, height: 900,
  chat: [
    ['long', Array.from({ length: 45 }, (_, i) => `بند ${i + 1}: این متن فارسی برای بررسی کامل پیام است.`).join('\n\n'), Array.from({ length: 35 }, (_, i) => `**Section ${i + 1}**\n\nThe complete explanation stays available, including [this reference](https://example.invalid).`).join('\n\n')],
    ['short', 'A short message.', 'A short reply.'],
  ],
}, async f => {
  const { page } = f;
  await f.open('chat-a');
  for (const selector of ['.user-turn', '.message.agent']) {
    const area = page.locator(selector).first();
    await area.scrollIntoViewIfNeeded();
    assert.equal(await area.getByRole('button', { name: /^(?:Collapse|Expand) message$/ }).count(), 0, `${selector}: no fold control on a long message`);
    assert.equal(await area.locator('.message-body-preview, [inert]').count(), 0, `${selector}: nothing is hidden behind a preview`);
    assert.ok((await area.innerText()).includes(selector === '.user-turn' ? 'بند 45' : 'Section 35'), `${selector}: the last line is on the page`);
    await area.hover(); await area.getByRole('button', { name: selector === '.user-turn' ? 'Copy message' : 'Copy reply', exact: true }).click();
    const turn = f.turns[0]; assert.ok(turn);
    assert.equal(await f.copied(), turn[selector === '.user-turn' ? 1 : 2], 'Copy takes the whole message');
  }
}));
