// Queue or steer, per message, as Claude's desktop app has it (read from its source): while a turn runs, Enter sends the
// message into the run and Ctrl+Enter queues it for later (Settings → General → Follow-up behavior swaps the two); the
// send button's tooltip names both keys and its "More send options" menu does the other one with the mouse; queued
// messages wait above the box, count themselves ("2 messages queued"), collapse into a stack, and can be sent now,
// edited in the composer or removed. Real key presses. Local bridge fixture; no engine or model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { leaveSettings, openSettings } = require('./controls.cjs');
type Locator = { waitFor(options?: object): Promise<void>; click(): Promise<void>; fill(text: string): Promise<void>; inputValue(): Promise<string>; getAttribute(name: string): Promise<string | null>; count(): Promise<number>; getByText(text: string, options?: object): Locator; getByRole(role: string, options?: object): Locator };
type Page = { getByRole(role: string, options?: object): Locator; getByText(text: string | RegExp, options?: object): Locator; keyboard: { press(key: string): Promise<void> }; waitForFunction(fn: () => boolean): Promise<void>; evaluate<T>(fn: () => T): Promise<T> };
type Fixture = { page: Page; composer: Locator; posts: { path: string; body: { text: string } }[]; errors: unknown[]; open(id: string): Promise<void>; close(): Promise<void>; emit(name: string, data: object): void };

async function using(options: object, run: (f: Fixture) => Promise<void>) {
  const f: Fixture = await fixture({ running: true, ...options });
  try {
    await f.open('chat-a');
    await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await run(f);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}
const steered = (f: Fixture) => f.posts.filter(post => post.path === '/api/threads/chat-a/steer').map(post => post.body.text);
const queueList = (page: Page) => page.getByRole('list', { name: 'Queued follow-ups', exact: true });
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send follow-up', exact: true });
/** Types like a person, then presses the key. */
async function type(f: Fixture, text: string, key: string) {
  await f.composer.click(); await f.composer.fill(text); await f.page.keyboard.press(key);
}
/** Chooses Queue or Steer in Settings → General, the way a person does, and returns to the chat. */
async function choose(f: Fixture, name: string) {
  await openSettings(f.page);
  await f.page.getByRole('radio', { name, exact: true }).click();
  await leaveSettings(f.page);
}
const queueMany = async (f: Fixture, ...texts: string[]) => { for (const text of texts) await type(f, text, 'Control+Enter'); };

test('Enter sends into the running turn, Ctrl+Enter queues that one message, and the send button names both keys', () => using({}, async f => {
  const { page, composer } = f;
  assert.equal(await composer.getAttribute('placeholder'), 'Enter to send, Ctrl+Enter to queue for later');
  await composer.fill('anything');
  assert.equal(await sendButton(page).getAttribute('title'), 'Send (Enter)\nQueue for later (Ctrl+Enter)', 'the tooltip lists both keys, as Claude\'s does');
  await composer.fill('');

  await type(f, 'steer this', 'Enter');
  await page.waitForFunction(() => { const box = document.querySelector('[aria-label="Message Elpis"]'); return box instanceof HTMLTextAreaElement && !box.value; });
  assert.deepEqual(steered(f), ['steer this']);
  await type(f, 'later please', 'Control+Enter');
  await queueList(page).getByText('later please', { exact: true }).waitFor();
  assert.deepEqual(steered(f), ['steer this'], 'Ctrl+Enter did not steer');
  assert.equal(await page.getByText('1 message queued', { exact: true }).count(), 1, 'the tray counts its messages');

  await choose(f, 'Queue');
  assert.equal(await composer.getAttribute('placeholder'), 'Enter to queue for later, Ctrl+Enter to send now');
  await composer.fill('anything');
  assert.equal(await sendButton(page).getAttribute('title'), 'Queue for later (Enter)\nSend now (Ctrl+Enter)');
}));

test('one queued message: Send now, Edit in composer and Remove from queue', () => using({}, async f => {
  const { page, composer } = f;
  await queueMany(f, 'first draft of it');
  const tray = queueList(page);
  await tray.getByText('1 message queued', { exact: true }).waitFor();
  await tray.getByText('first draft of it', { exact: true }).waitFor();

  await tray.getByRole('button', { name: 'Edit in composer', exact: true }).click();
  await tray.waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), 'first draft of it', 'the message is back in the box');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Message Elpis');

  // With a draft already typed, the queued text goes above it and nothing is lost.
  await composer.fill('draft'); await page.keyboard.press('Control+Enter');
  await composer.fill('typed meanwhile');
  await tray.getByRole('button', { name: 'Edit in composer', exact: true }).click();
  assert.equal(await composer.inputValue(), 'draft\n\ntyped meanwhile');
  await composer.fill('');

  await queueMany(f, 'send me now');
  await tray.getByRole('button', { name: 'Send now', exact: true }).click();
  await tray.waitFor({ state: 'detached' });
  assert.deepEqual(steered(f), ['send me now']);

  await queueMany(f, 'never mind');
  await tray.getByRole('button', { name: 'Remove from queue', exact: true }).click();
  await tray.waitFor({ state: 'detached' });
  assert.deepEqual(steered(f), ['send me now'], 'removing sends nothing');
}));

test('a message sent while the chat compacts its history waits in the queue and goes when compaction ends', () => using({ routes: { '/api/threads/chat-a/steer': () => ({ compacting: true }) } }, async f => {
  const { page } = f;
  await type(f, 'after the compaction', 'Enter');
  await queueList(page).getByText('after the compaction', { exact: true }).waitFor();
  assert.deepEqual(steered(f), ['after the compaction'], 'it tried to steer first');
  assert.equal(await page.getByText(/cannot steer a compact turn/).count(), 0, 'no error is shown');
  const sent = () => f.posts.filter(post => post.path === '/api/threads/chat-a/turns').map(post => post.body.text);
  assert.deepEqual(sent(), []);
  f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 't4', status: 'completed', items: [] } } });
  await queueList(page).waitFor({ state: 'detached' });
  assert.deepEqual(sent(), ['after the compaction'], 'the compaction\'s end sends it as a new turn');
}));
