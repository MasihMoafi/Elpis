const { openSettings } = require('./controls.cjs');
// Settings navigation fits the window, with a short-window fallback. Synthetic fixture; no engine or provider calls.
const test = require('node:test'), assert = require('node:assert/strict');

test('desktop settings navigation fits without scrolling and retains a short-window fallback', async () => {
  const { fixture } = require('./parity-fixture.cjs');
  for (const [width, height] of [[1280, 900], [1280, 760]]) {
    const f = await fixture({ width, height });
    try {
      const { page } = f; await openSettings(page);
      const nav = page.getByRole('navigation', { name: 'Settings navigation' });
      const geometry = await nav.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll('[role="tab"], .back-link, input')];
        return { client: element.clientHeight, scroll: element.scrollHeight, controls: controls.map(node => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top - bounds.top, bottom: bounds.bottom - rect.bottom, font: parseFloat(getComputedStyle(node).fontSize) };
        }) };
      });
      assert.equal(await nav.getByRole('tab').count(), 17);
      assert.equal(await nav.getByRole('button', { name: 'Back to app' }).count(), 1);
      assert.equal(await nav.getByLabel('Search settings', { exact: true }).count(), 1);
      assert.ok(geometry.scroll <= geometry.client + 1, `${width}×${height}: navigation scrolls (${geometry.scroll} > ${geometry.client})`);
      assert.ok(geometry.controls.every(item => item.top >= -1 && item.bottom >= -1 && item.font >= 12), `${width}×${height}: controls must fit and remain legible`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
  const short = await fixture({ width: 1280, height: 540 });
  try {
    await openSettings(short.page);
    const nav = short.page.getByRole('navigation', { name: 'Settings navigation' });
    const result = await nav.evaluate(element => { element.scrollTop = element.scrollHeight; return { overflow: element.scrollHeight > element.clientHeight, bottom: element.scrollTop + element.clientHeight, total: element.scrollHeight }; });
    assert.ok(result.overflow && result.bottom >= result.total - 1, 'short windows retain reachable navigation via scrolling');
    await nav.getByRole('tab', { name: 'About', exact: true }).click();
    assert.deepEqual(short.errors, []);
  } finally { await short.close(); }
});
