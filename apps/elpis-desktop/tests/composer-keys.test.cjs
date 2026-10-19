// The message box's keyboard basics as Claude's desktop app has them (read from its source): Esc stops the reply,
// Esc Esc in an empty box edits your last message, ↑/↓ step through the messages you sent, and Ctrl+R searches them.
// Real key presses. Local bridge fixture; no engine or model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

async function using(options, run) {
  const f = await fixture(options);
  try {
    await f.open('chat-a');
    if (options.running) await f.page.getByRole('button', { name: 'Stop generation', exact: true }).waitFor();
    await run(f);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}
const interrupts = f => f.posts.filter(post => post.path === '/api/threads/chat-a/interrupt');
const turnsSent = f => f.posts.filter(post => post.path === '/api/threads/chat-a/turns');
const editForm = page => page.getByRole('form', { name: 'Edit message', exact: true });
const status = (page, text) => page.getByRole('status').filter({ hasText: text });
const value = f => f.composer.inputValue();
const press = (f, ...keys) => keys.reduce((done, key) => done.then(() => f.page.keyboard.press(key)), Promise.resolve());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Esc stops the running reply from the message box and from the chat, and leaves menus and other fields their own Esc', () => using({ running: true }, async f => {
  const { page, composer } = f;
  await composer.click(); await page.keyboard.press('Escape');
  await eventually(() => assert.equal(interrupts(f).length, 1));
  assert.deepEqual(interrupts(f)[0].body, { turnId: 't4' });

  await page.getByText('Detail 3 of the explanation, in a sentence of its own.').first().click(); // focus in the chat, not the box
  await page.keyboard.press('Escape');
  await eventually(() => assert.equal(interrupts(f).length, 2));

  await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await sleep(300);
  assert.equal(interrupts(f).length, 2, 'Esc closed the menu and did not stop the reply');

  await page.getByLabel('Search conversations', { exact: true }).click(); await page.keyboard.press('Escape');
  await sleep(300);
  assert.equal(interrupts(f).length, 2, 'Esc in the sidebar search is the search\'s own');
}));

test('Esc does nothing to an idle chat', () => using({}, async f => {
  await f.composer.click(); await f.page.keyboard.press('Escape');
  await sleep(300);
  assert.equal(interrupts(f).length, 0);
}));

test('Esc Esc in an empty message box opens your last message for editing; other keys, a pause or a draft stop it', () => using({}, async f => {
  const { page, composer } = f;
  await composer.click();
  await press(f, 'Escape');
  await sleep(900); await press(f, 'Escape'); await sleep(900);
  await press(f, 'Escape', 'ArrowLeft', 'Escape'); await sleep(900);
  assert.equal(await editForm(page).count(), 0, 'one Esc, a late Esc, or Esc with a key between is not Esc Esc');
  await composer.fill('draft'); await press(f, 'Escape', 'Escape');
  assert.equal(await editForm(page).count(), 0, 'a message box with a draft keeps its Esc');
  await composer.fill('');

  await press(f, 'Escape', 'Escape');
  const box = page.getByRole('textbox', { name: 'Edited message', exact: true });
  await box.waitFor();
  assert.equal(await box.inputValue(), 'Run them.', 'the newest message you sent');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Edited message');
  await page.keyboard.press('Escape');
  await editForm(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Message Elpis', 'Esc leaves the edit and the box has the focus again');
  assert.equal(turnsSent(f).length, 0);
}));

test('↑ and ↓ step through the messages you sent; ↓ past the newest gives the empty box back', () => using({}, async f => {
  const { page, composer } = f;
  await composer.click();
  assert.equal(await status(page, 'History').count(), 0);
  await press(f, 'ArrowUp');
  assert.equal(await value(f), 'Run them.');
  await status(page, 'History 4/4').waitFor();
  await press(f, 'ArrowUp'); assert.equal(await value(f), 'Add tests.'); await status(page, 'History 3/4').waitFor();
  await press(f, 'ArrowUp', 'ArrowUp'); assert.equal(await value(f), 'Explain the parser.'); await status(page, 'History 1/4').waitFor();
  await press(f, 'ArrowUp'); assert.equal(await value(f), 'Explain the parser.', 'the oldest stays');
  await press(f, 'ArrowDown'); assert.equal(await value(f), 'Rename the lexer.'); await status(page, 'History 2/4').waitFor();
  await press(f, 'ArrowDown', 'ArrowDown'); assert.equal(await value(f), 'Run them.');
  await press(f, 'ArrowDown'); assert.equal(await value(f), '', 'past the newest: the empty box');
  assert.equal(await status(page, 'History').count(), 0);

  await press(f, 'ArrowUp'); assert.equal(await value(f), 'Run them.');
  await page.keyboard.type('!');
  assert.equal(await status(page, 'History').count(), 0, 'typing ends the stepping');
  await press(f, 'ArrowUp');
  assert.equal(await value(f), 'Run them.!', 'an edited message is not replaced');

  await composer.fill('a draft'); await press(f, 'ArrowUp');
  assert.equal(await value(f), 'a draft', 'a box with text keeps ↑ for the caret');
  assert.equal(turnsSent(f).length, 0, 'nothing was sent');
}));

test('↑ moves through the lines of a recalled message before it reaches the one before', () => using({ chat: [['t1', 'first', 'ok one'], ['t2', 'line one\nline two', 'ok two']] }, async f => {
  const { page, composer } = f;
  await composer.click(); await press(f, 'ArrowUp');
  assert.equal(await value(f), 'line one\nline two');
  assert.equal(await composer.evaluate(box => box.selectionStart), 'line one\nline two'.length, 'the caret is at the end');
  await press(f, 'ArrowUp');
  assert.equal(await value(f), 'line one\nline two', 'the caret moved up a line');
  assert.equal(await composer.evaluate(box => box.selectionStart <= 8), true);
  await status(page, 'History 2/2').waitFor();
  await press(f, 'ArrowUp'); assert.equal(await value(f), 'first');
  await press(f, 'ArrowDown'); assert.equal(await value(f), 'line one\nline two', 'back down to the multi-line message');
}));

test('Ctrl+R searches the messages you sent: type to narrow, Ctrl+R or ↑ for the next, Esc brings the draft back, Enter keeps the match', () => using({}, async f => {
  const { page, composer } = f;
  await page.evaluate(() => { window.__stay = true; });
  await composer.fill('my draft'); await composer.click();
  await press(f, 'Control+r');
  await status(page, 'Search history:').first().waitFor();
  assert.equal(await page.evaluate(() => window.__stay), true, 'Ctrl+R did not reload the page');
  await page.keyboard.type('rename');
  assert.equal(await value(f), 'Rename the lexer.');
  await status(page, 'Search history: rename — match 3 of 4').waitFor();
  await press(f, 'Control+r');
  await status(page, 'Search history: rename — no match').waitFor();
  assert.equal(await value(f), 'Rename the lexer.', 'a failed search leaves the last match');
  await press(f, 'Backspace');
  await status(page, 'Search history: renam — match 3 of 4').waitFor();
  await press(f, 'Escape');
  assert.equal(await value(f), 'my draft', 'Esc brings the draft back');
  assert.equal(await status(page, 'Search history').count(), 0);

  await press(f, 'Control+r'); await page.keyboard.type('e');
  assert.equal(await value(f), 'Run them.', 'the newest message with an e');
  await press(f, 'ArrowUp'); assert.equal(await value(f), 'Add tests.');
  await press(f, 'ArrowDown'); assert.equal(await value(f), 'Run them.');
  await press(f, 'Enter');
  assert.equal(await status(page, 'Search history').count(), 0);
  assert.equal(await value(f), 'Run them.', 'Enter keeps the match and does not send it');
  assert.equal(turnsSent(f).length, 0);
  await page.keyboard.type('!');
  assert.equal(await value(f), 'Run them.!', 'then it is an ordinary draft');

  await composer.fill(''); await press(f, 'Control+r'); await page.keyboard.type('zzz');
  await status(page, 'Search history: zzz — no match').waitFor();
  await press(f, 'Backspace', 'Backspace', 'Backspace', 'Backspace');
  assert.equal(await status(page, 'Search history').count(), 0, 'Backspace on an empty search ends it');
}));

async function eventually(check) {
  const end = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await sleep(50); } }
}

test('a stopped turn says so in the chat, whoever stopped it, so a stop is never silent', () => using({ running: true }, async f => {
  const { page } = f;
  for (let tries = 0; f.listening() < 1 && tries < 100; tries++) await sleep(50);
  f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 't4', status: 'interrupted' } } });
  await page.getByRole('button', { name: 'Stop generation', exact: true }).waitFor({ state: 'detached' });
  const note = page.getByRole('status').filter({ hasText: 'Stopped' });
  await note.waitFor();
  assert.match(await note.innerText(), /Stopped/);
  f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: 't5' } } });
  await note.waitFor({ state: 'detached' });
}));

test('a finished chat never keeps offering "Send follow-up": idle status or reopening clears a turn whose end was missed', () => using({ running: true }, async f => {
  const { page } = f;
  const followUp = page.getByRole('button', { name: 'Send follow-up', exact: true });
  await f.composer.fill('next');
  await followUp.waitFor();
  for (let tries = 0; f.listening() < 1 && tries < 100; tries++) await sleep(50);
  // The turn's own end never arrives (another window, a reconnect, a dropped stream); the engine says the chat is idle.
  f.emit('message', { method: 'thread/status/changed', params: { threadId: 'chat-a', status: { type: 'idle' } } });
  await followUp.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).count(), 1);
}));

test('a long chat draws only the turns on screen; off-screen turns skip layout and paint until scrolled to', async () => {
  const chat = Array.from({ length: 60 }, (_, index) => [`long-${index}`, `Question ${index}`, `Answer ${index}. ${'A sentence of the reply that takes some room. '.repeat(12)}`]);
  const f = await fixture({ chat });
  try {
    await f.open('chat-a');
    const last = f.page.getByText('Question 59', { exact: true });
    await last.waitFor();
    await f.page.waitForTimeout(300);
    const drawn = text => f.page.getByText(text, { exact: true }).evaluate(node => node.checkVisibility({ contentVisibilityAuto: true }));
    assert.equal(await drawn('Question 59'), true, 'the newest turn, on screen, is drawn');
    assert.equal(await drawn('Question 0'), false, 'the first turn, far above, is skipped');
    await f.page.getByText('Question 0', { exact: true }).scrollIntoViewIfNeeded();
    await f.page.waitForTimeout(200);
    assert.equal(await drawn('Question 0'), true, 'scrolled to, it is drawn');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
