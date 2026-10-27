const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
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
