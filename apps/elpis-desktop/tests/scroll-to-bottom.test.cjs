// ChatGPT's round "scroll to bottom" button (Masih's chatgpt-superior-chat-design screenshots, 20 October): it appears only
// when the chat is scrolled away from its newest message, and one click returns there and keeps following.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('the scroll-to-bottom button shows only away from the newest message and returns there', async () => {
  const chat = Array.from({ length: 10 }, (_, i) => [`t${i + 1}`, `Prompt ${i + 1}`, `Reply ${i + 1}.\n\nA second paragraph.\n\nA third paragraph.`]);
  for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ chat, width: 1280, height: 760, colorScheme });
    try {
      await f.open('chat-a');
      const scroller = f.page.locator('.chat-scroll'), button = f.page.getByRole('button', { name: 'Scroll to bottom', exact: true });
      await f.page.waitForTimeout(300);
      assert.equal(await button.count(), 0, `${colorScheme}: hidden at the newest message`);
      await scroller.evaluate(node => { node.scrollTop = 0; });
      await button.waitFor();
      const [box, composer] = await Promise.all([button.boundingBox(), f.composer.boundingBox()]);
      assert.ok(box.y + box.height <= composer.y, `${colorScheme}: sits above the composer`);
      assert.ok(Math.abs(box.x + box.width / 2 - (composer.x + composer.width / 2)) <= 2, `${colorScheme}: centred on the composer`);
      await button.click();
      await button.waitFor({ state: 'detached' });
      assert.ok(await scroller.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 80), `${colorScheme}: back at the newest message`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
