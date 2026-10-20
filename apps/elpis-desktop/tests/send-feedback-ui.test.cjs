const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`Enter immediately shows the message and preserves an identical next draft (${colorScheme})`, async () => {
  let acknowledge;
  const waiting = new Promise(resolve => { acknowledge = resolve; });
  const f = await fixture({ colorScheme, routes: { '/api/threads/chat-a/turns': async () => {
    await waiting;
    return { turn: { id: 't-new' } };
  } } });
  try {
    await f.open('chat-a');
    const text = 'Show that Enter sent this.';
    await f.page.locator('.chat-scroll').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await f.composer.fill(text);
    await f.composer.press('Enter');
    await f.page.waitForTimeout(200);
    assert.equal(await f.composer.inputValue(), '', 'composer clears before acknowledgement');
    const sent = f.page.locator('.message.user').filter({ hasText: text });
    assert.equal(await sent.count(), 1, 'the submitted bubble appears before acknowledgement');
    assert.ok(await sent.isVisible());
    const box = await sent.boundingBox(), viewport = await f.page.locator('.chat-scroll').boundingBox();
    assert.ok(box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height, 'sending brings the bubble into view');
    await f.composer.fill(text);
    acknowledge();
    await f.page.waitForTimeout(300);
    assert.equal(await f.composer.inputValue(), text, 'acknowledgement keeps the next draft');
    assert.deepEqual(f.errors, []);
  } finally { acknowledge(); await f.close(); }
});

test('a refused send restores the draft and removes the unacknowledged bubble', async () => {
  let acknowledge;
  const waiting = new Promise(resolve => { acknowledge = resolve; });
  const f = await fixture({ routes: { '/api/threads/chat-a/turns': async () => { await waiting; return {}; } } });
  try {
    await f.open('chat-a');
    const text = 'Keep this if sending fails.';
    await f.composer.fill(text);
    await f.composer.press('Enter');
    await f.page.waitForTimeout(200);
    assert.equal(await f.page.locator('.message.user').filter({ hasText: text }).count(), 1);
    acknowledge();
    await f.page.getByRole('alert').filter({ hasText: 'did not acknowledge' }).waitFor();
    assert.equal(await f.composer.inputValue(), text);
    assert.equal(await f.page.locator('.message.user').filter({ hasText: text }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { acknowledge(); await f.close(); }
});
