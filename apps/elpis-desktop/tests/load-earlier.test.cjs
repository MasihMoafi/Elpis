// Masih, 24 Oct: "when I press load earlier messages it just loads one message". A page is 100 items, and one message can
// be followed by hundreds of tool steps, so a press keeps reading pages until ten more messages have arrived.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cjs');

const PAGE = 100, PAGES = 30;
const pageOf = n => Array.from({ length: PAGE }, (_, i) => i === 0
  ? { turnId: `turn-${n}`, item: { id: `user-${n}`, type: 'userMessage', content: [{ type: 'text', text: `Message ${n}` }] } }
  : { turnId: `turn-${n}`, item: { id: `cmd-${n}-${i}`, type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: '', exitCode: 0 } }).reverse();
const thread = { ...THREADS[1] };
const routes = { [`/api/threads/${thread.id}`]: (_body, url) => {
  const n = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : PAGES;
  return { thread, data: pageOf(n), nextCursor: n > 1 ? String(n - 1) : null };
} };

test('Load earlier messages brings ten more messages, however many tool steps lie between them', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    await f.open(thread.id);
    const messages = page.locator('.user-turn');
    await messages.first().waitFor();
    const before = await messages.count();
    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await page.waitForFunction(count => document.querySelectorAll('.user-turn').length >= count + 10, before, { timeout: 8000 }).catch(() => {});
    assert.ok(await messages.count() >= before + 10, `${await messages.count() - before} more messages after one press`);
    assert.ok(await page.getByRole('button', { name: 'Load earlier messages' }).count(), 'earlier ones remain to load');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
