const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const { scrollToLoadEarlier } = require('./controls.cjs');
const { PORTRAIT_INSTRUCTIONS } = require('../bridge/matilda-face.cjs');

for (const colorScheme of ['light', 'dark']) test(`automatic portrait guidance does not duplicate a live message (${colorScheme})`, async t => {
  const text = 'Keep the taller message box. ';
  const f = await fixture({ running: true, colorScheme, routes: {
    '/api/threads/chat-a/steer': () => ({ turnId: 't4' }),
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  await f.composer.fill(text); await f.composer.press('Enter');
  const users = f.page.locator('.message.user').filter({ hasText: text.trim() });
  await users.waitFor();
  const note = `File: Reply portrait.txt\n${PORTRAIT_INSTRUCTIONS}`;
  const echo = { id: 'portrait-echo', type: 'userMessage', content: [
    { type: 'text', text }, { type: 'text', text: note, text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(note) }, placeholder: 'Attachment: Reply portrait.txt' }] },
  ] };
  f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't4', item: echo } });
  await f.page.locator('.user-turn[data-message-reference*="portrait-echo"]').waitFor();
  assert.equal(await users.getByText('Reply portrait.txt', { exact: true }).count(), 0, 'internal portrait guidance stays out of the message');
  assert.equal(await users.count(), 1, 'the enriched engine echo replaces the temporary bubble');
  f.turns.at(-1)[3] = [echo];
  await f.page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await f.page.waitForTimeout(150);
  assert.equal(await users.count(), 1, 'history refresh keeps one complete user message');
  assert.equal(await users.getByText('Reply portrait.txt', { exact: true }).count(), 0, 'history keeps internal guidance hidden');
  const realNote = 'File: Reply portrait.txt\nThese are my own portrait notes.';
  const realFile = { id: 'real-portrait-file', type: 'userMessage', content: [{ type: 'text', text: realNote, text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(realNote) }, placeholder: 'Attachment: Reply portrait.txt' }] }] };
  f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't4', item: realFile } });
  await f.page.getByText('Reply portrait.txt', { exact: true }).waitFor();
  await f.page.getByText('Reply portrait.txt', { exact: true }).click();
  await f.page.getByText('These are my own portrait notes.', { exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
  if (process.env.ELPIS_LIVE_EVIDENCE) {
    await fs.mkdir(process.env.ELPIS_LIVE_EVIDENCE, { recursive: true });
    await f.page.screenshot({ path: path.join(process.env.ELPIS_LIVE_EVIDENCE, `portrait-echo-${colorScheme}.png`) });
  }
});

test('a follow-up stays after earlier work when the loaded history starts mid-turn', async t => {
  const turnId = 't4';
  const thread = { ...THREADS[0], status: { type: 'active' } };
  const entry = item => ({ turnId, item });
  const entries = [
    entry({ id: 'command-before', type: 'commandExecution', command: 'echo first', status: 'completed' }),
    entry({ id: 'reply-before', type: 'agentMessage', text: 'Earlier reply.' }),
    entry({ id: 'command-next', type: 'commandExecution', command: 'echo second', status: 'completed' }),
    entry({ id: 'compaction', type: 'contextCompaction' }),
    entry({ id: 'reply-latest', type: 'agentMessage', text: 'All green.' }),
  ];
  const f = await fixture({ running: true, routes: {
    '/api/threads/chat-a': (_body, url) => url.searchParams.has('cursor')
      ? { thread, data: [entry({ id: 'first-prompt', type: 'userMessage', content: [{ type: 'text', text: 'First prompt.' }] })], nextCursor: null }
      : { thread, data: [...entries].reverse(), nextCursor: 'earlier' },
    '/api/threads/chat-a/steer': () => ({ turnId }),
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  await f.page.locator('.load-earlier-messages').waitFor({ state: 'attached' });
  const order = () => f.page.locator('.activity-group, .message.user, .message.agent, .context-event').allTextContents();
  const checkOrder = async expected => {
    const rows = await order();
    let previous = -1;
    for (const text of expected) {
      const next = rows.findIndex((row, index) => index > previous && row.includes(text));
      assert.ok(next > previous, `Missing or reordered ${text}: ${rows.join(' | ')}`);
      previous = next;
    }
  };
  const earlier = ['Ran', 'Earlier reply.', 'Ran', 'Compacted the context', 'All green.'];
  await checkOrder(earlier);
  await f.composer.fill('Follow up now.');
  await f.composer.press('Enter');
  await f.page.locator('.message.user').getByText('Follow up now.', { exact: true }).waitFor();
  await checkOrder([...earlier, 'Follow up now.']);

  const echo = { id: 'follow-up-echo', type: 'userMessage', content: [{ type: 'text', text: 'Follow up now.' }] };
  const later = { id: 'reply-after', type: 'agentMessage', text: 'Later reply.' };
  for (const item of [echo, later]) {
    entries.push(entry(item));
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId, item } });
  }
  await f.page.getByText('Later reply.', { exact: true }).waitFor();
  await checkOrder([...earlier, 'Follow up now.', 'Later reply.']);
  const refreshed = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/threads/chat-a' && response.request().method() === 'GET');
  await f.page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await refreshed;
  await checkOrder([...earlier, 'Follow up now.', 'Later reply.']);
  assert.equal(await f.page.getByText('Follow up now.', { exact: true }).count(), 1);
  assert.equal(f.posts.filter(post => post.path === '/api/threads/chat-a/steer').length, 1);
  await scrollToLoadEarlier(f.page);
  await f.page.getByText('First prompt.', { exact: true }).waitFor();
  await checkOrder(['First prompt.', ...earlier, 'Follow up now.', 'Later reply.']);
  await f.page.reload();
  await f.open('chat-a');
  await f.page.getByText('Later reply.', { exact: true }).waitFor();
  await checkOrder([...earlier, 'Follow up now.', 'Later reply.']);
  assert.equal(await f.page.getByText('Follow up now.', { exact: true }).count(), 1);
  assert.equal(f.posts.filter(post => post.path === '/api/threads/chat-a/steer').length, 1);
  assert.deepEqual(f.errors, []);
});

for (const colorScheme of ['light', 'dark']) test(`three messages appear immediately during a turn and keep their position after acknowledgement (${colorScheme})`, { timeout: 30000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const f = await fixture({ running: true, colorScheme, routes: { '/api/threads/chat-a/steer': async body => { delivered.push(body.text); await gate; return { turnId: 't4' }; } } });
  t.after(async () => { release(); await f.close(); });
  await f.open('chat-a');
  for (const text of ['First live message', 'Second live message', 'Third live message']) {
    await f.composer.fill(text); await f.composer.press('Enter');
    const bubble = f.page.locator('.message.user').getByText(text, { exact: true });
    await bubble.waitFor({ timeout: 500 });
    const bounds = await bubble.boundingBox(), viewport = await f.page.locator('.chat-scroll').boundingBox();
    assert.ok(bounds.y >= viewport.y - 1 && bounds.y + bounds.height <= viewport.y + viewport.height + 1, 'The sent message is visible in the chat viewport');
    assert.equal(await f.composer.inputValue(), '', 'Enter clears only the submitted text');
  }
  assert.deepEqual(delivered, ['First live message', 'Second live message', 'Third live message']);
  const items = delivered.map((text, index) => ({ id: `echo-${index}`, type: 'userMessage', content: [{ type: 'text', text }] }));
  for (const item of items) f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't4', item } });
  release();
  f.turns.at(-1)[3] = items;
  const refreshed = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/threads/chat-a' && response.request().method() === 'GET');
  await f.page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await refreshed;
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await f.page.getByText('Third live message', { exact: true }).waitFor();
  const order = await f.page.locator('.message.user, .message.agent').allTextContents();
  assert.ok(order.findIndex(s => s.includes('All green.')) < order.findIndex(s => s.includes('First live message')), order.join('\n'));
  assert.ok(order.findIndex(s => s.includes('First live message')) < order.findIndex(s => s.includes('Second live message')));
  assert.ok(order.findIndex(s => s.includes('Second live message')) < order.findIndex(s => s.includes('Third live message')));
  for (const text of delivered) assert.equal(await f.page.getByText(text, { exact: true }).count(), 1);
  if (process.env.ELPIS_LIVE_EVIDENCE) {
    await fs.mkdir(process.env.ELPIS_LIVE_EVIDENCE, { recursive: true });
    await f.page.screenshot({ path: path.join(process.env.ELPIS_LIVE_EVIDENCE, `chat-${colorScheme}.png`) });
  }
});
