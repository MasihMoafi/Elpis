// Canvas keeps its side panel and Auto-arrange choices in the desktop store. On 18 Oct the store refused both keys,
// and each click showed "Error invoking remote method 'elpis:state:write': Error: Unsupported workspace value".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

test('folding the side panel and switching Auto-arrange save without a store error', async () => {
  const f = await openCanvas({ desktop: true });
  try {
    for (const name of ['Side panel', 'Auto-arrange']) {
      const button = f.canvas.getByRole('button', { name, exact: true }), before = await button.getAttribute('aria-pressed');
      await button.click(); await f.page.waitForTimeout(100);
      assert.notEqual(await button.getAttribute('aria-pressed'), before, `${name} switched`);
    }
    const saved = await f.page.evaluate(() => [localStorage.getItem('elpis-canvas-panel'), localStorage.getItem('elpis-canvas-auto')]);
    assert.deepEqual(saved, ['closed', 'off']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
