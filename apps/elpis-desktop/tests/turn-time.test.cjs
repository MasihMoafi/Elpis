// ChatGPT's time separators (Masih's chatgpt-superior-chat-design screenshots, 20 October): a centred "Yesterday 8:41 PM"
// line heads a turn that starts an hour or more after the previous one, or on another day; close turns and the first get none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('a long pause or a new day puts a centred time above the next turn, and close turns get none', async () => {
  const day = 86_400_000, now = new Date(), evening = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 20, 41).getTime();
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5).getTime();
  const chat = [['t1', 'Old question', 'Old answer', undefined, evening - 3 * day], ['t2', 'Yesterday evening', 'Answer two', undefined, evening],
    ['t3', 'Two minutes later', 'Answer three', undefined, evening + 120_000], ['t4', 'After midnight', 'Answer four', undefined, morning]];
  for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ chat, width: 1280, height: 900, colorScheme });
    try {
      await f.open('chat-a');
      const times = f.page.locator('.turn-time');
      await times.first().waitFor();
      const labels = await times.allInnerTexts();
      assert.equal(labels.length, 2, `${colorScheme}: the evening three days on, and the next day; not the first turn or two minutes on: ${labels}`);
      assert.match(labels[0], /^Yesterday 8:41\s?PM$/i, `${colorScheme}: ${labels[0]}`);
      assert.match(labels[1], /^Today 12:05\s?AM$/i, `${colorScheme}: ${labels[1]}`);
      const [line, column] = await Promise.all([times.nth(0).boundingBox(), f.page.locator('.chat-content').boundingBox()]);
      assert.ok(Math.abs(line.x + line.width / 2 - (column.x + column.width / 2)) <= 2, `${colorScheme}: centred in the chat column`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
