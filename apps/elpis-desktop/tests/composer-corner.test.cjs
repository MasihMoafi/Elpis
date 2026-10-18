const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

// The composer's amber corner accent must sit on the outer corner of what the user sees as one box, spanning that
// corner's cut (the HUD's bevelled corners). On a new chat the environment bar sits on top of the composer and squares
// its top corners, so the bar's own cut carries the accent.
const corner = (page, selector) => page.locator(selector).first().evaluate(element => {
  const box = getComputedStyle(element), mark = getComputedStyle(element, '::before');
  const probe = document.createElement('i'); probe.style.color = 'var(--primary)'; element.append(probe);
  const primary = getComputedStyle(probe).color; probe.remove();
  return { display: mark.display, markSize: mark.width, cut: box.borderTopLeftRadius, shape: box.getPropertyValue('corner-shape'), top: mark.top, left: mark.left, line: mark.backgroundImage, primary };
});

for (const colorScheme of ['light', 'dark']) test(`the composer's corner accent marks the outer cut corner (${colorScheme})`, async t => {
  const f = await fixture({ width: 1280, height: 860, colorScheme });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f;
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.locator('.composer-tray').waitFor();
  const tray = await corner(page, '.composer-tray'), composer = await corner(page, '.composer');
  assert.equal(composer.display, 'none', 'Below the environment bar the composer has no top corner of its own to mark');
  assert.notEqual(tray.display, 'none', 'The accent marks the bar, the outer corner of the joined box');
  assert.equal(tray.markSize, tray.cut, 'The accent spans the bar\'s cut corner');
  assert.notEqual(tray.cut, '0px', 'The bar\'s top-left corner is cut');
  assert.deepEqual([tray.top, tray.left], ['-1px', '-1px'], 'The accent lies on the border, not inside it');
  // Masih (18 Oct): the gold accent "is not fit here"; the line is the composer's neutral grey, not the accent colour.
  for (const mark of [tray, await corner(page, '.composer').then(() => page.locator('.composer').first().evaluate(element => getComputedStyle(element, '::after').backgroundImage))])
    assert.ok(!String(mark.line ?? mark).includes(tray.primary), `The corner line is not the accent colour ${tray.primary}`);

  await page.locator('.thread-row .thread-link').first().click();
  await page.locator('.composer-tray').waitFor({ state: 'detached' });
  const alone = await corner(page, '.composer');
  assert.notEqual(alone.display, 'none');
  assert.equal(alone.markSize, alone.cut, 'In a chat the accent spans the composer\'s own cut');
  if (alone.shape) assert.match(alone.shape, /^(bevel|superellipse\(0\))$/, 'The corner is cut, not rounded');
});
