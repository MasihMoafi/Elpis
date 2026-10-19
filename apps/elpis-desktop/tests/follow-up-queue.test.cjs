// Queue or steer, per message, as Claude's desktop app has it (read from its source): while a turn runs, Enter sends the
// message into the run and Ctrl+Enter queues it for later (Settings → General → Follow-up behavior swaps the two); the
// send button's tooltip names both keys and its "More send options" menu does the other one with the mouse; queued
// messages wait above the box, count themselves ("2 messages queued"), collapse into a stack, and can be sent now,
// edited in the composer or removed. Real key presses. Local bridge fixture; no engine or model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { leaveSettings, openSettings } = require('./controls.cjs');

async function using(options, run) {
  const f = await fixture({ running: true, ...options });
  try {
    await f.open('chat-a');
    await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await run(f);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}
const steered = f => f.posts.filter(post => post.path === '/api/threads/chat-a/steer').map(post => post.body.text);
const queueList = page => page.getByRole('list', { name: 'Queued follow-ups', exact: true });
const sendButton = page => page.getByRole('button', { name: 'Send follow-up', exact: true });
/** Types like a person, then presses the key. */
async function type(f, text, key) {
  await f.composer.click(); await f.composer.fill(text); await f.page.keyboard.press(key);
}
/** Chooses Queue or Steer in Settings → General, the way a person does, and returns to the chat. */
async function choose(f, name) {
  await openSettings(f.page);
  await f.page.getByRole('radio', { name, exact: true }).click();
  await leaveSettings(f.page);
}
const queueMany = async (f, ...texts) => { for (const text of texts) await type(f, text, 'Control+Enter'); };

test('Enter sends into the running turn, Ctrl+Enter queues that one message, and the send button names both keys', () => using({}, async f => {
  const { page, composer } = f;
  assert.equal(await composer.getAttribute('placeholder'), 'Enter to send, Ctrl+Enter to queue for later');
  await composer.fill('anything');
  assert.equal(await sendButton(page).getAttribute('title'), 'Send (Enter)\nQueue for later (Ctrl+Enter)', 'the tooltip lists both keys, as Claude\'s does');
  await composer.fill('');

  await type(f, 'steer this', 'Enter');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Message Elpis"]').value);
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

test('the send button\'s menu sends this one message the other way, with the mouse', () => using({}, async f => {
  const { page, composer } = f;
  const more = page.getByRole('button', { name: 'More send options', exact: true });
  assert.equal(await more.isDisabled(), true, 'nothing to send yet');
  await composer.fill('queued from the menu');
  await more.click();
  const item = page.getByRole('menuitem', { name: 'Queue for later', exact: true });
  assert.match(await item.innerText(), /Ctrl\+Enter/, 'the item shows its key');
  assert.equal(await page.getByRole('menuitem').count(), 1, 'only the other choice is offered');
  await item.click();
  await queueList(page).getByText('queued from the menu', { exact: true }).waitFor();
  assert.deepEqual(steered(f), []);
  assert.equal(await composer.inputValue(), '');

  await choose(f, 'Queue');
  await composer.fill('sent from the menu');
  await more.click();
  await page.getByRole('menuitem', { name: 'Send now', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Message Elpis"]').value);
  assert.deepEqual(steered(f), ['sent from the menu']);
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

test('several queued messages collapse into a stack that opens, sends one now, removes one, or clears all', () => using({}, async f => {
  const { page } = f;
  await queueMany(f, 'alpha', 'beta', 'gamma');
  const stack = page.getByRole('button', { name: /3 messages queued/ });
  await stack.waitFor();
  assert.match(await stack.innerText(), /Next: alpha/, 'the stack shows what goes first');
  assert.equal(await stack.getAttribute('aria-expanded'), 'false');
  assert.equal(await queueList(page).count(), 0, 'collapsed: no rows');

  await stack.click();
  const rows = queueList(page).getByRole('listitem');
  assert.deepEqual(await rows.allInnerTexts().then(texts => texts.map(text => text.trim())), ['alpha', 'beta', 'gamma']);
  const collapse = page.getByRole('button', { name: 'Collapse queued messages', exact: true });
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true');

  await rows.nth(1).getByRole('button', { name: 'Queued message actions', exact: true }).click();
  await page.getByRole('menu').waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allInnerTexts(), ['Edit in composer', 'Send now', 'Remove from queue']);
  await page.getByRole('menuitem', { name: 'Send now', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Queued follow-ups"] > li').length === 2);
  assert.deepEqual(steered(f), ['beta']);

  await rows.nth(0).getByRole('button', { name: 'Queued message actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from queue', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Queued follow-ups"] > li').length === 1);

  await queueMany(f, 'delta');
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await queueList(page).waitFor({ state: 'detached' });
  assert.deepEqual(steered(f), ['beta'], 'Clear all sends nothing');
  await collapse.waitFor({ state: 'detached' });
}));

test('Settings says how Follow-up behavior and the keys work together', () => using({}, async f => {
  const { page } = f;
  await openSettings(page);
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  const row = page.getByRole('tabpanel', { name: 'General', exact: true }).getByText(/^While Elpis runs, /);
  assert.equal(await row.innerText(), 'While Elpis runs, Enter sends the message into the current run and Ctrl+Enter queues it for later.');
  await page.getByRole('radio', { name: 'Queue', exact: true }).click();
  assert.equal(await row.innerText(), 'While Elpis runs, Enter queues the message for later and Ctrl+Enter sends it into the current run.');
}));
