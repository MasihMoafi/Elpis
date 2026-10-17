const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const bashNotice = 'Bash mode. Press Escape to return to chat.';
const side = page => page.getByRole('region', { name: 'Side chat', exact: true });
const sent = (f, suffix) => f.posts.filter(post => post.path.endsWith(suffix));
async function using(options, run) {
  const f = await fixture(options);
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); }
}
async function eventually(check) {
  const end = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (e) { if (Date.now() > end) throw e; await new Promise(r => setTimeout(r, 40)); } }
}

test('! at the start enters Bash mode; Escape and empty Backspace return to chat, without interrupting a reply', () => using({ running: true }, async f => {
  await f.composer.click(); await f.page.keyboard.type('!');
  await f.page.getByRole('status').filter({ hasText: bashNotice }).waitFor();
  assert.equal(await f.composer.inputValue(), '');
  await f.page.keyboard.type('printf hello'); await f.page.keyboard.press('Escape');
  assert.equal(await f.composer.inputValue(), 'printf hello');
  assert.equal(await f.page.getByText(bashNotice, { exact: true }).count(), 0);
  assert.equal(sent(f, '/interrupt').length, 0);
  await f.composer.fill('hello'); await f.page.keyboard.type('!');
  assert.equal(await f.page.getByText(bashNotice, { exact: true }).count(), 0, 'an exclamation inside chat text stays text');
  await f.composer.fill(''); await f.page.keyboard.type('!'); await f.page.keyboard.press('Backspace');
  assert.equal(await f.page.getByText(bashNotice, { exact: true }).count(), 0);
}));

test('the + menu enters Bash mode and Enter sends a shell command, never a model turn or steer', () => using({ routes: { '/api/threads/chat-a/shell': () => ({}) } }, async f => {
  await f.page.getByRole('button', { name: 'Add files and more', exact: true }).click();
  await f.page.getByRole('menuitem', { name: /^Run as a shell command/ }).click();
  await f.page.getByText(bashNotice, { exact: true }).waitFor();
  await f.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message Elpis');
  await f.page.keyboard.type("printf 'hello\\n' | head -1"); await f.page.keyboard.press('Enter');
  await eventually(() => assert.equal(sent(f, '/shell').length, 1));
  assert.deepEqual(sent(f, '/shell')[0].body, { command: "printf 'hello\\n' | head -1" });
  await eventually(async () => assert.equal(await f.composer.inputValue(), ''));
  assert.equal(sent(f, '/turns').length + sent(f, '/steer').length, 0);
}));

test('a refused shell command keeps its input and mode for retry', () => using({ routes: { '/api/threads/chat-a/shell': () => ({ __http: 409, error: 'Wait for the running command.' }) } }, async f => {
  await f.composer.click(); await f.page.keyboard.type('!pwd'); await f.page.keyboard.press('Enter');
  await f.page.getByText('Wait for the running command.', { exact: false }).waitFor();
  assert.equal(await f.composer.inputValue(), 'pwd');
  await f.page.getByText(bashNotice, { exact: true }).waitFor();
  assert.equal(sent(f, '/turns').length, 0);
}));

test('shell output streams into the transcript, including a failed exit, and a running chat is never steered', () => using({ running: true, routes: { '/api/threads/chat-a/shell': () => ({}) } }, async f => {
  await f.composer.click(); await f.page.keyboard.type('!printf output; exit 7');
  await f.page.getByRole('button', { name: 'Run shell command', exact: true }).click();
  await eventually(() => assert.equal(sent(f, '/shell').length, 1));
  f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 'shell-turn', item: { id: 'shell-output', type: 'commandExecution', source: 'userShell', command: 'printf output; exit 7', aggregatedOutput: 'NATIVE_SHELL_OUTPUT_731', exitCode: 7, status: 'completed' } } });
  await f.page.locator('.chat-scroll').getByText('NATIVE_SHELL_OUTPUT_731', { exact: true }).waitFor();
  await f.page.getByText('Exit code 7', { exact: true }).waitFor();
  assert.equal(sent(f, '/turns').length + sent(f, '/steer').length + sent(f, '/interrupt').length, 0);
}));

test('Escape closes side chat without stopping the main reply; a refused side question keeps its draft for retry', () => using({ running: true, routes: {
  '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
  '/api/side-chats/side-a/turns': () => ({ __http: 503, error: 'Side chat is temporarily unavailable.' }),
} }, async f => {
  await f.composer.click(); await f.page.keyboard.press('Control+;');
  const panel = side(f.page), box = panel.getByRole('textbox', { name: 'Side question', exact: true });
  await box.fill('Keep this side question.'); await box.press('Enter');
  await panel.getByRole('alert').waitFor();
  assert.equal(await box.inputValue(), 'Keep this side question.');
  await box.press('Enter'); await eventually(() => assert.equal(sent(f, '/side-chats/side-a/turns').length, 2));
  await box.press('Escape'); await panel.waitFor({ state: 'hidden' });
  assert.equal(sent(f, '/interrupt').length, 0);
  await f.page.keyboard.press('Control+;');
  assert.equal(await box.inputValue(), 'Keep this side question.');
}));

test('Ctrl+; toggles side chat, preserves the main draft, sends to an isolated conversation, and closes on navigation', () => using({ running: true, routes: {
  '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
  '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
} }, async f => {
  await f.composer.fill('main draft'); await f.composer.click(); await f.page.keyboard.press('Control+;');
  const panel = side(f.page); await panel.waitFor();
  const box = panel.getByRole('textbox', { name: 'Side question', exact: true });
  await box.fill('What does the parser return?'); await box.press('Enter');
  await eventually(() => assert.equal(sent(f, '/side-chats/side-a/turns').length, 1));
  assert.deepEqual(sent(f, '/side-chats/side-a/turns')[0].body, { text: 'What does the parser return?' });
  assert.equal(await f.composer.inputValue(), 'main draft');
  assert.equal(sent(f, '/threads/chat-a/turns').length + sent(f, '/steer').length + sent(f, '/interrupt').length, 0);
  // Real engine events arrive on the app's authenticated event stream, then travel to the side panel only.
  f.emit('sideChat', { method: 'item/completed', params: { threadId: 'side-a', turnId: 'side-turn', item: { id: 'answer', type: 'agentMessage', text: 'A syntax tree.' } } });
  await panel.getByText('A syntax tree.', { exact: true }).waitFor();
  assert.equal(await f.page.locator('.chat-scroll').getByText('A syntax tree.', { exact: true }).count(), 0);
  await f.page.keyboard.press('Control+;'); await panel.waitFor({ state: 'hidden' });
  await f.page.keyboard.press('Control+;'); await panel.getByText('A syntax tree.', { exact: true }).waitFor();
  await f.open('chat-b'); await panel.waitFor({ state: 'detached' });
  await eventually(() => assert.equal(sent(f, '/side-chats/side-a/close').length, 1));
}));

test('/btw opens the side panel and routes its argument to the side conversation', () => using({ routes: {
  '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
  '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
} }, async f => {
  await f.composer.click(); await f.page.keyboard.type('/btw What is a token?'); await f.page.keyboard.press('Enter');
  await side(f.page).waitFor();
  await eventually(() => assert.equal(sent(f, '/side-chats/side-a/turns').length, 1));
  assert.equal(sent(f, '/side-chats/side-a/turns')[0].body.text, 'What is a token?');
  assert.equal(sent(f, '/threads/chat-a/turns').length, 0);
  assert.equal(await f.composer.inputValue(), '');
}));

test('clicking Send on /btw routes a side question without sending a main-chat turn', () => using({ routes: {
  '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
  '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
} }, async f => {
  await f.composer.fill('/btw: What is a token?');
  await f.page.getByRole('button', { name: 'Send message', exact: true }).click();
  await side(f.page).waitFor();
  await eventually(() => assert.equal(sent(f, '/side-chats/side-a/turns').length, 1));
  assert.equal(sent(f, '/side-chats/side-a/turns')[0].body.text, 'What is a token?');
  assert.equal(sent(f, '/threads/chat-a/turns').length, 0);
}));

for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [900, 700]]) {
  test(`shell and side panel fit (${colorScheme}, ${width}×${height})`, () => using({ colorScheme, width, height, routes: {
    '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
    '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
  } }, async f => {
    await f.composer.click(); await f.page.keyboard.type('!printf hello');
    await f.page.getByText(bashNotice, { exact: true }).waitFor();
    await assertUiFit(f.page.locator('.composer-wrap'), 'Bash composer fits');
    await f.page.keyboard.press('Control+;'); await side(f.page).waitFor();
    const box = side(f.page).getByRole('textbox', { name: 'Side question', exact: true });
    await box.fill('What will this command print?'); await box.press('Enter');
    await eventually(() => assert.equal(sent(f, '/side-chats/side-a/turns').length, 1));
    f.emit('sideChat', { method: 'item/completed', params: { threadId: 'side-a', turnId: 'side-turn', item: { id: 'side-answer', type: 'agentMessage', text: 'It prints `hello` to standard output.\n\nThe main conversation keeps running while you ask this side question.' } } });
    f.emit('sideChat', { method: 'turn/completed', params: { threadId: 'side-a', turn: { id: 'side-turn', status: 'completed' } } });
    await side(f.page).getByText('The main conversation keeps running while you ask this side question.', { exact: true }).waitFor();
    await assertUiFit(side(f.page), 'Side chat fits');
    const dir = path.resolve(__dirname, '../.tmp/composer-shots'); await fs.mkdir(dir, { recursive: true });
    await f.page.screenshot({ path: path.join(dir, `${colorScheme}-${width}.png`) });
  }));
}
