// A sidebar chat shows one focus ring, round its whole row, and only for the keyboard: on 17 Oct a clicked chat drew a
// second box round its title inside the highlighted row. Local bridge fixture (tests/parity-fixture.cjs); no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const rings = page => page.evaluate(() => [...document.querySelectorAll('aside.sidebar .thread-row')].flatMap(row => {
  const link = row.querySelector('.thread-link'), drawn = element => getComputedStyle(element).outlineStyle !== 'none' && getComputedStyle(element).outlineWidth !== '0px';
  if (!link) return [];
  return [drawn(row) && `row ${row.dataset.threadId}`, drawn(link) && `title ${row.dataset.threadId}`].filter(Boolean);
}));

test('a clicked chat has no focus ring; the keyboard shows one, round the row', async () => {
  const f = await fixture();
  try {
    const { page } = f;
    await page.locator('aside.sidebar .thread-row[data-thread-id="chat-b"] .thread-link').click();
    await page.locator('aside.sidebar .thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.deepEqual(await rings(page), [], 'a mouse click draws no ring');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.closest('.thread-row')?.dataset.threadId === 'chat-c');
    assert.deepEqual(await rings(page), ['row chat-c'], 'the keyboard draws one ring, round the row');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
