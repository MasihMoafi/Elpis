const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { uiFit, assertUiFit } = require('./ui-fit.cjs');
const { chooseTheme } = require('./controls.cjs');

for (const [width, height] of [[1280, 800], [900, 700]]) for (const theme of ['light', 'dark']) test(`text fits in both views, Add and settings: ${width}×${height} ${theme}`, async () => {
  const f = await openCanvas({ width, height }); const { page, canvas } = f;
  try {
    if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
    await page.waitForTimeout(350);
    for (const iso of [false, true]) {
      await canvas.getByRole('button', { name: iso ? 'Isometric' : 'Flat', exact: true }).click(); await f.fit();
      await assertUiFit(canvas, `${iso ? '3D' : '2D'} canvas`);
      if (iso) await canvas.locator('.iso-node[aria-label^="Part 1:"]').click(); else await f.node('Part 1').click();
      const panel = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
      await panel.getByRole('textbox', { name: 'Name', exact: true }).fill('A long agent name that needs a complete tooltip when the label is shortened');
      await f.fit(); await assertUiFit(panel, 'agent settings');
      await assertUiFit(canvas, `${iso ? '3D' : '2D'} long labels`);
      await fs.mkdir('/tmp/canvas-rebuild', { recursive: true }); await page.screenshot({ path: `/tmp/canvas-rebuild/fit-${width}-${theme}-${iso ? 'iso' : 'flat'}.png` });
      await panel.getByRole('textbox', { name: 'Name', exact: true }).fill('Part 1');
      await panel.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await canvas.getByRole('button', { name: /^Command/ }).click();
    const add = canvas.getByRole('dialog', { name: 'Add agents', exact: true });
    await add.getByRole('textbox', { name: 'Command', exact: true }).fill('astra xhigh @anthropic-credits claude-opus-5-5 with a long prompt that wraps across several visible lines\nA second line that must remain readable');
    await assertUiFit(add, 'Add agents');
    await page.screenshot({ path: `/tmp/canvas-rebuild/add-${width}-${theme}.png` });
  } finally { await f.close(); }
});

test('ui-fit rejects clipped text, overlapping text and content outside the viewport; accepts titled ellipsis', async () => {
  const f = await openCanvas();
  try {
    await f.page.evaluate(() => { const el = document.createElement('div'); el.id = 'fit-negative'; el.style = 'position:fixed;inset:0;z-index:99999;background:white'; el.innerHTML = '<div style="width:25px;overflow:hidden;white-space:nowrap">Clipped long words</div><span style="position:absolute;left:10px;top:60px">Overlap one</span><b style="position:absolute;left:10px;top:60px">Overlap two</b><p style="position:absolute;left:-10px;top:100px">Outside viewport</p><div title="Complete titled ellipsis" style="width:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:160px">Complete titled ellipsis</div>'; const button = document.createElement('button'); button.setAttribute('aria-label', 'Outside control'); button.style = 'position:absolute;left:-100px;top:240px;width:30px;height:30px'; el.append(button); document.body.append(el); });
    const issues = await uiFit(f.page.locator('#fit-negative'));
    assert.ok(issues.some(line => line.startsWith('clipped text:'))); assert.ok(issues.some(line => line.startsWith('text overlap:'))); assert.ok(issues.some(line => line.startsWith('outside viewport:'))); assert.ok(issues.some(line => line.startsWith('outside control:')));
    assert.ok(!issues.some(line => line.includes('Complete titled ellipsis')));
  } finally { await f.close(); }
});

test('the Add field shows wrapped provider/model text and its second line', async () => {
  const f = await openCanvas({ width: 900, height: 700 });
  try {
    await f.canvas.getByRole('button', { name: /^Command/ }).click();
    const add = f.canvas.getByRole('dialog', { name: 'Add agents', exact: true });
    await add.getByRole('textbox', { name: 'Command', exact: true }).fill('astra xhigh @anthropic-credits claude-opus-5-5 with a long prompt that wraps across several visible lines\nA second line that must remain readable');
    await assertUiFit(add, 'wrapped command');
  } finally { await f.close(); }
});
