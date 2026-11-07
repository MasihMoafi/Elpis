const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
type Locator = { getByRole(role: string, options?: object): Locator; getByText(text: string, options?: object): Locator; locator(selector: string): Locator; filter(options: object): Locator; waitFor(options?: object): Promise<void>; count(): Promise<number>; fill(text: string): Promise<void>; press(key: string): Promise<void>; click(): Promise<void>; inputValue(): Promise<string> };
type Page = Locator & { keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> }; waitForFunction(fn: () => boolean): Promise<void>; screenshot(options: object): Promise<void> };
type Fixture = { page: Page; composer: Locator; posts: { path: string; body: { text: string } }[]; errors: unknown[]; open(id: string): Promise<void>; close(): Promise<void>; emit(type: string, data: object): void };
const bashNotice = 'Bash mode. Press Escape to return to chat.';
const side = (page: Page) => page.getByRole('region', { name: 'Side chat', exact: true });
const recap = (page: Page) => page.getByRole('region', { name: 'Recap', exact: true });
const sent = (f: Fixture, suffix: string) => f.posts.filter(post => post.path.endsWith(suffix));
async function using(options: object, run: (f: Fixture) => Promise<void>) {
  const f = await fixture(options);
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); }
}
async function eventually(check: () => void | Promise<void>) {
  const end = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (e) { if (Date.now() > end) throw e; await new Promise(r => setTimeout(r, 40)); } }
}

for (const colorScheme of ['light']) {
  test(`/recap summarizes this chat in a fresh side panel (${colorScheme})`, () => {
    let forks = 0;
    return using({ colorScheme, staticDir: process.env.ELPIS_RECAP_TEST_OUT, routes: {
      '/api/threads/chat-a/side-chat': () => ({ threadId: `recap-${++forks}` }),
      '/api/side-chats/recap-1/turns': () => ({ turn: { id: 'recap-turn-1' } }),
      '/api/side-chats/recap-2/turns': () => ({ turn: { id: 'recap-turn-2' } }),
    } }, async f => {
      await f.composer.fill('/recap'); await f.composer.press('Enter');
      const panel = recap(f.page); await panel.waitFor();
      await eventually(() => assert.equal(sent(f, '/side-chats/recap-1/turns').length, 1));
      assert.match(sent(f, '/side-chats/recap-1/turns')[0]?.body.text, /summari[sz]e|recap/i);
      assert.equal(sent(f, '/threads/chat-a/turns').length + sent(f, '/steer').length + sent(f, '/interrupt').length, 0);
      f.emit('sideChat', { method: 'item/completed', params: { threadId: 'recap-1', turnId: 'recap-turn-1', item: { id: 'recap-answer', type: 'agentMessage', text: 'Parser recap: lexer repaired; next verify Unicode input.' } } });
      f.emit('sideChat', { method: 'turn/completed', params: { threadId: 'recap-1', turn: { id: 'recap-turn-1', status: 'completed' } } });
      await panel.getByText('Parser recap: lexer repaired; next verify Unicode input.', { exact: true }).waitFor();
      assert.equal(await f.page.locator('.chat-scroll').getByText('Parser recap: lexer repaired; next verify Unicode input.', { exact: true }).count(), 0);
      await assertUiFit(panel, 'Recap fits beside the conversation');
      if (process.env.ELPIS_RECAP_SHOTS) { await fs.mkdir(process.env.ELPIS_RECAP_SHOTS, { recursive: true }); await f.page.screenshot({ path: path.join(process.env.ELPIS_RECAP_SHOTS, `recap-${colorScheme}.png`) }); }
      await f.composer.fill('/recap'); await f.composer.press('Enter');
      await eventually(() => assert.equal(forks, 2, 'A second recap must fork the current history again'));
      await eventually(() => assert.equal(sent(f, '/side-chats/recap-1/close').length, 1));
      await eventually(() => assert.equal(sent(f, '/side-chats/recap-2/turns').length, 1));
      await f.open('chat-b'); await panel.waitFor({ state: 'detached' });
      await eventually(() => assert.equal(sent(f, '/side-chats/recap-2/close').length, 1));
    });
  });
}

test('/recap shows a generation error without sending to the main conversation', () => using({ staticDir: process.env.ELPIS_RECAP_TEST_OUT, routes: {
  '/api/threads/chat-a/side-chat': () => ({ __http: 503, error: 'Recap is temporarily unavailable.' }),
} }, async f => {
  await f.composer.fill('/recap'); await f.composer.press('Enter');
  await recap(f.page).getByRole('alert').getByText('Recap is temporarily unavailable.', { exact: true }).waitFor();
  assert.equal(sent(f, '/threads/chat-a/turns').length + sent(f, '/steer').length + sent(f, '/interrupt').length, 0);
}));

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
  assert.deepEqual(sent(f, '/shell')[0]?.body, { command: "printf 'hello\\n' | head -1" });
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
  assert.deepEqual(sent(f, '/side-chats/side-a/turns')[0]?.body, { text: 'What does the parser return?' });
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
  assert.equal(sent(f, '/side-chats/side-a/turns')[0]?.body.text, 'What is a token?');
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
  assert.equal(sent(f, '/side-chats/side-a/turns')[0]?.body.text, 'What is a token?');
  assert.equal(sent(f, '/threads/chat-a/turns').length, 0);
}));

test('Forward sends a finished side-chat answer to the working agent, and is absent until then (A38)', () => using({ routes: {
  '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
  '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
} }, async f => {
  await f.composer.click(); await f.page.keyboard.press('Control+;');
  const panel = side(f.page), box = panel.getByRole('textbox', { name: 'Side question', exact: true });
  const forward = panel.getByRole('button', { name: 'Forward', exact: true });
  await box.fill('Which file owns the parser?'); await box.press('Enter');
  await eventually(() => assert.equal(sent(f, '/side-chats/side-a/turns').length, 1));
  f.emit('sideChat', { method: 'item/completed', params: { threadId: 'side-a', turnId: 'side-turn', item: { id: 'answer', type: 'agentMessage', text: 'lib/parser.ts owns it.' } } });
  await panel.getByText('lib/parser.ts owns it.', { exact: true }).waitFor();
  assert.equal(await forward.count(), 0, 'no Forward while the side answer is still running');
  f.emit('sideChat', { method: 'turn/completed', params: { threadId: 'side-a', turn: { id: 'side-turn', status: 'completed' } } });
  await forward.waitFor();
  assert.equal(sent(f, '/threads/chat-a/turns').length, 0, 'nothing reaches the main chat before Forward');
  await forward.click();
  await eventually(() => assert.equal(sent(f, '/threads/chat-a/turns').length, 1));
  assert.match(sent(f, '/threads/chat-a/turns')[0]?.body.text, /From the side chat:\s+lib\/parser\.ts owns it\./);
}));
