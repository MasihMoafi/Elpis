// The message box as Claude's desktop app has it: an @ opens a picker of the project's files and the person's other
// chats (arrows, Enter or Tab, Escape); the "+" menu offers what Elpis can do and nothing that does nothing; and the
// send button is a cut-corner button inside the box, whatever the theme. Local bridge fixture; no engine or model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

async function using(options, run) {
  const f = await fixture(options);
  try { await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); }
}
const picker = page => page.getByRole('listbox', { name: 'Mentions' });
const listed = list => list.locator('.slash-name').allInnerTexts();
const chosen = list => list.getByRole('option', { selected: true }).locator('.slash-name').innerText();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const sent = (f, suffix) => f.posts.filter(post => post.path === `/api/threads/chat-a/${suffix}`);
const eventually = async check => { const end = Date.now() + 4000; for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } } };

test('typing @ lists the project files and the other chats; arrows move, Enter inserts, Escape closes', () => using({}, async f => {
  const { page, composer } = f;
  await f.open('chat-a'); await composer.click();
  await page.keyboard.type('@');
  const list = picker(page); await list.waitFor();
  const all = await listed(list);
  for (const name of ['README.md', 'src/app.ts', 'src/lib/parser.ts', 'Write the docs', 'Plan the release']) assert.ok(all.includes(name), `${name} is offered: ${all}`);
  assert.ok(!all.includes('Fix the parser'), 'the chat on screen is not offered');
  await page.keyboard.press('ArrowDown'); assert.equal(await chosen(list), 'package.json');
  await page.keyboard.press('ArrowUp'); assert.equal(await chosen(list), 'README.md');
  await page.keyboard.press('ArrowUp'); assert.equal(await chosen(list), 'Plan the release', 'the list wraps');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('app');
  assert.equal((await listed(list))[0], 'src/app.ts', 'typing narrows the list');
  await page.keyboard.press('Enter');
  await list.waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), '@src/app.ts ', 'Enter inserts the choice and does not send');
  assert.equal(sent(f, 'turns').length, 0);
  await page.keyboard.type('@lex'); await list.waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await composer.inputValue(), '@src/app.ts @src/lib/lexer.ts ', 'Tab inserts too');
  await page.keyboard.type('@par'); await list.waitFor();
  await page.keyboard.press('Escape'); await list.waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), '@src/app.ts @src/lib/lexer.ts @par', 'Escape closes the list and leaves the text');
}));

test('a chosen file travels as a native mention beside the @name in the text', () => using({}, async f => {
  const { page, composer } = f;
  await f.open('chat-a'); await composer.click();
  await page.keyboard.type('look at @app'); await picker(page).waitFor(); await page.keyboard.press('Enter');
  await page.keyboard.type('now'); await page.keyboard.press('Enter');
  const [turn] = await eventually(async () => { const posts = sent(f, 'turns'); assert.equal(posts.length, 1); return posts; });
  assert.equal(turn.body.text, 'look at @src/app.ts now');
  assert.deepEqual(turn.body.mentions, [{ name: 'src/app.ts', path: `${CWD}/src/app.ts` }]);
}));

test('a chosen chat travels as a mention too, and a mention whose @name was deleted is not sent', () => using({}, async f => {
  const { page, composer } = f;
  await f.open('chat-a'); await composer.click();
  await page.keyboard.type('compare with @Write'); await picker(page).waitFor(); await page.keyboard.press('Enter');
  assert.equal(await composer.inputValue(), 'compare with @Write the docs ');
  await page.keyboard.press('Enter');
  const [turn] = await eventually(async () => { const posts = sent(f, 'turns'); assert.equal(posts.length, 1); return posts; });
  assert.deepEqual(turn.body.mentions, [{ name: 'Write the docs', path: 'thread://chat-b' }]);
}));

test('deleting the @name from the text drops its mention', () => using({}, async f => {
  const { page, composer } = f;
  await f.open('chat-a'); await composer.click();
  await page.keyboard.type('@readme'); await picker(page).waitFor(); await page.keyboard.press('Enter');
  await composer.fill('plain words');
  await page.keyboard.press('Enter');
  const [turn] = await eventually(async () => { const posts = sent(f, 'turns'); assert.equal(posts.length, 1); return posts; });
  assert.equal(turn.body.text, 'plain words'); assert.equal('mentions' in turn.body, false);
}));

test('while a turn runs the mention rides the steer, and a queued follow-up keeps it until it is sent', () => using({ running: true }, async f => {
  const { page, composer } = f;
  await f.open('chat-a'); await composer.click();
  await page.keyboard.type('@app'); await picker(page).waitFor(); await page.keyboard.press('Enter'); await page.keyboard.type('first'); await page.keyboard.press('Enter');
  const [steer] = await eventually(async () => { const posts = sent(f, 'steer'); assert.equal(posts.length, 1); return posts; });
  assert.deepEqual(steer.body.mentions, [{ name: 'src/app.ts', path: `${CWD}/src/app.ts` }]);
  await eventually(async () => assert.equal(await composer.inputValue(), '')); await composer.click();
  await page.keyboard.type('@lex'); await picker(page).waitFor(); await page.keyboard.press('Tab'); await page.keyboard.type('second');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await page.getByRole('list', { name: 'Queued follow-ups' }).waitFor();
  assert.equal(sent(f, 'steer').length, 1, 'queued, not sent');
  await page.getByRole('button', { name: 'Send now', exact: true }).click();
  const posts = await eventually(async () => { const all = sent(f, 'steer'); assert.equal(all.length, 2); return all; });
  assert.deepEqual(posts[1].body.mentions, [{ name: 'src/lib/lexer.ts', path: `${CWD}/src/lib/lexer.ts` }]);
}));

test('the + menu offers Add files or photos, Mention, Slash commands and Plan mode, each doing its thing, and no folder item', () => using({}, async f => {
  const { page, composer } = f;
  await f.open('chat-a');
  const plus = page.getByRole('button', { name: 'Add files and more', exact: true });
  const items = async () => (await page.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0].trim());
  await plus.click(); await page.getByRole('menuitem').first().waitFor();
  assert.deepEqual(await items(), ['Add files or photos', 'Mention', 'Slash commands', 'Plan mode', 'Run as a shell command']);
  await page.keyboard.press('Escape');
  await plus.click(); await page.getByRole('menuitem', { name: /^Mention/ }).click();
  await picker(page).waitFor();
  assert.equal(await composer.inputValue(), '@');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message Elpis'); // the menu hands the focus back to the box
  await composer.fill('');
  await plus.click(); await page.getByRole('menuitem', { name: /^Slash commands/ }).click();
  await page.getByRole('listbox', { name: 'Slash commands' }).waitFor();
  assert.equal(await composer.inputValue(), '/');
  await composer.fill('some words');
  await plus.click();
  assert.equal(await page.getByRole('menuitem', { name: /^Slash commands/ }).getAttribute('aria-disabled'), 'true', 'a command starts a message, so it waits for an empty box');
  await page.keyboard.press('Escape');
}));

test('Add files or photos opens one chooser for pictures and documents alike; a picture lands in the message', () => using({}, async f => {
  const { page } = f;
  await f.open('chat-a');
  const plus = page.getByRole('button', { name: 'Add files and more', exact: true });
  await plus.click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: /^Add files or photos/ }).click()]);
  const accept = await chooser.element().getAttribute('accept');
  assert.match(accept, /application\/pdf/); assert.match(accept, /image\/png,image\/jpeg,image\/webp,image\/gif/);
  await chooser.setFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('list', { name: 'Message attachments' }).getByText('pic.png').waitFor();
}));

for (const colorScheme of ['light', 'dark']) for (const running of [false, true]) {
  test(`the send button is a cut-corner button inside the box (${colorScheme}, ${running ? 'a turn running' : 'idle'})`, () => using({ colorScheme, running }, async f => {
    const { page, composer } = f;
    await f.open('chat-a'); await composer.fill('a message');
    const button = page.getByRole('button', { name: running ? 'Send follow-up' : 'Send message', exact: true });
    await button.waitFor();
    const look = await button.evaluate(node => { const style = getComputedStyle(node), box = node.getBoundingClientRect(), outer = node.closest('.composer').getBoundingClientRect();
      return { clip: style.clipPath, radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius], shape: style.cornerTopLeftShape, right: outer.right - box.right, bottom: outer.bottom - box.bottom, left: box.left - outer.left, top: box.top - outer.top }; });
    assert.equal(look.clip, 'none', 'focus rings follow the native bevel without clipping');
    assert.deepEqual(look.radii, ['7px', '0px', '7px', '0px']);
    assert.match(look.shape, /bevel|superellipse\(0\)/);
    for (const side of ['right', 'bottom', 'left', 'top']) assert.ok(look[side] >= 6, `${side} edge sits inside the box with room: ${look[side]}px`);
  }));
}
