// A scrollbar appears only when content needs it (Masih, 31 Oct: "these scrollbars shouldn't exist when they can not exist").
// A box that overflows by a few pixels is trailing space or a rounding error, not content: it must not scroll.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

const idleScrollers = page => page.evaluate(() => [...document.querySelectorAll('*')].flatMap(el => {
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  if (style.display === 'none' || style.visibility === 'hidden' || !box.width || !box.height) return [];
  const found = [];
  if (style.overflowY === 'scroll' || style.overflowX === 'scroll') found.push('always shows a scrollbar');
  const extraY = el.scrollHeight - el.clientHeight, extraX = el.scrollWidth - el.clientWidth;
  if (style.overflowY === 'auto' && extraY > 0 && extraY <= 16) found.push(`scrolls for ${extraY}px`);
  if (style.overflowX === 'auto' && extraX > 0 && extraX <= 16) found.push(`scrolls sideways for ${extraX}px`);
  return found.map(why => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ').slice(0, 3).join('.')} ${el.getAttribute('aria-label') ?? ''}: ${why}`);
}));

for (const [width, height] of [[1000, 700]]) test(`no box scrolls for a few pixels of space (${width}x${height})`, async () => {
  const f = await fixture({ width, height }), { page } = f;
  try {
    await f.open('chat-a');
    const found = { chat: await idleScrollers(page) };
    for (const name of ['Workflows', 'Love Spot', 'Customize', 'Lab']) {
      const nav = page.locator(`button[aria-label="${name}"]`).first();
      if (!await nav.count()) continue;
      await nav.click(); await page.waitForTimeout(600);
      found[name] = await idleScrollers(page);
    }
    // Settings too (Masih, 27 Oct: "the settings should be not scrollable."): every section, the navigation included.
    await openSettings(page);
    const tabs = page.getByRole('tablist', { name: 'Settings sections' });
    for (const name of (await tabs.getByRole('tab').allInnerTexts()).map(text => text.trim())) {
      await tabs.getByRole('tab', { name, exact: true }).click(); await page.waitForTimeout(300);
      found[`Settings › ${name}`] = await idleScrollers(page);
    }
    for (const [where, list] of Object.entries(found)) assert.deepEqual(list, [], `${where} at ${width}x${height}`);
  } finally { await f.close(); }
});

test('the check catches a box that scrolls for a few pixels', async () => {
  const f = await fixture({ width: 1000, height: 700 }), { page } = f;
  try {
    await f.open('chat-a');
    await page.evaluate(() => { const box = document.createElement('div'); box.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:100px;overflow:auto'; box.innerHTML = '<div style="height:108px"></div>'; document.body.append(box); });
    assert.equal((await idleScrollers(page)).length, 1);
  } finally { await f.close(); }
});
