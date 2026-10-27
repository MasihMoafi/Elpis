const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`three messages appear immediately during a turn and keep their position after acknowledgement (${colorScheme})`, { timeout: 30000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const f = await fixture({ running: true, colorScheme, routes: { '/api/threads/chat-a/steer': async body => { delivered.push(body.text); await gate; return { turnId: 't4' }; } } });
  t.after(async () => { release(); await f.close(); });
  await f.open('chat-a');
  for (const text of ['First live message', 'Second live message', 'Third live message']) {
    await f.composer.fill(text); await f.composer.press('Enter');
    await f.page.locator('.message.user').getByText(text, { exact: true }).waitFor({ timeout: 500 });
    assert.equal(await f.composer.inputValue(), '', 'Enter clears only the submitted text');
  }
  assert.deepEqual(delivered, ['First live message', 'Second live message', 'Third live message']);
  const items = delivered.map((text, index) => ({ id: `echo-${index}`, type: 'userMessage', content: [{ type: 'text', text }] }));
  for (const item of items) f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't4', item } });
  release();
  f.turns.at(-1)[3] = items;
  await f.page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await f.page.getByText('Third live message', { exact: true }).waitFor();
  const order = await f.page.locator('.message.user, .message.agent').allTextContents();
  assert.ok(order.findIndex(s => s.includes('All green.')) < order.findIndex(s => s.includes('First live message')), order.join('\n'));
  assert.ok(order.findIndex(s => s.includes('First live message')) < order.findIndex(s => s.includes('Second live message')));
  assert.ok(order.findIndex(s => s.includes('Second live message')) < order.findIndex(s => s.includes('Third live message')));
  for (const text of delivered) assert.equal(await f.page.getByText(text, { exact: true }).count(), 1);
});
