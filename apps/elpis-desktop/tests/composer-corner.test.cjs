const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

// The composer's amber corner bracket must sit on the outer corner of what the user sees as one box, with that
// corner's own radius. On a new chat the environment bar sits on top of the composer and squares its top corners.
const corner = (page, selector) => page.locator(selector).first().evaluate(element => {
  const box = getComputedStyle(element), mark = getComputedStyle(element, '::before');
  return { display: mark.display, markRadius: mark.borderTopLeftRadius, boxRadius: box.borderTopLeftRadius, top: mark.top, left: mark.left };
});

for (const colorScheme of ['light', 'dark']) test(`the composer's corner bracket follows the box it marks (${colorScheme})`, async t => {
  const f = await fixture({ width: 1280, height: 860, colorScheme });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f;
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.locator('.composer-tray').waitFor();
  const tray = await corner(page, '.composer-tray'), composer = await corner(page, '.composer');
  assert.equal(composer.display, 'none', 'Below the environment bar the composer has no top corner of its own to mark');
  assert.notEqual(tray.display, 'none', 'The bracket marks the bar, the outer corner of the joined box');
  assert.equal(tray.markRadius, tray.boxRadius, 'The bracket bends with the corner it sits on');
  assert.deepEqual([tray.top, tray.left], ['-1px', '-1px'], 'The bracket lies on the border, not inside it');

  await page.locator('.thread-row .thread-link').first().click();
  await page.locator('.composer-tray').waitFor({ state: 'detached' });
  const alone = await corner(page, '.composer');
  assert.notEqual(alone.display, 'none');
  assert.equal(alone.markRadius, alone.boxRadius, 'In a chat the bracket bends with the composer itself');
});
