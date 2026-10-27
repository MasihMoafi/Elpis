const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('the sidebar footer has a Settings button that opens General settings', async () => {
  const f = await fixture();
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.locator('aside.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await f.page.locator('.settings-title').waitFor();
    assert.equal(await f.page.locator('.settings-title').innerText(), 'Settings');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('sidebar scrolling settles on complete rows above the footer and reaches the last chat', async () => {
  const f = await fixture({ width: 1271, height: 800, threads: Array.from({ length: 35 }, (_, i) => ({ id: i ? `chat-${i}` : 'chat-a', name: `Conversation ${i}`, cwd: '/tmp/parity-fixture', status: { type: 'idle' } })) });
  try {
    const list = f.page.locator('.thread-list');
    await list.evaluate(el => { el.scrollTop = 120; });
    await f.page.waitForTimeout(500);
    const geometry = await list.evaluate(el => {
      const box = el.getBoundingClientRect();
      const visible = [...el.querySelectorAll('.thread-row')].map(row => row.getBoundingClientRect()).filter(r => r.top < box.bottom - 1 && r.bottom > box.top);
      return { lastBottom: visible.at(-1).bottom, boundary: box.bottom };
    });
    assert.ok(geometry.lastBottom <= geometry.boundary + 1, 'the bottom visible row is complete after scrolling');
    const last = list.locator('.thread-row').last(); await last.scrollIntoViewIfNeeded();
    const reached = await last.evaluate(el => {
      const row = el.getBoundingClientRect(), list = el.closest('.thread-list').getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom + 1;
    });
    assert.equal(reached, true, 'the last chat remains fully reachable');
  } finally { await f.close(); }
});
