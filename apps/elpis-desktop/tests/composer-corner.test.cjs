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

// Every visible edge of the composer box: the bar's and composer's borders and their corner lines.
async function oneEdge(page, withTray, when) {
  const edge = await page.evaluate(withTray => {
    const composer = document.querySelector('.composer'), tray = withTray ? document.querySelector('.composer-tray') : null;
    const c = getComputedStyle(composer);
    return { composer: c.borderBottomColor, composerSide: c.borderLeftColor, after: getComputedStyle(composer, '::after').backgroundImage,
      before: withTray ? null : getComputedStyle(composer, '::before').backgroundImage,
      tray: tray && getComputedStyle(tray).borderTopColor, trayMark: tray && getComputedStyle(tray, '::before').backgroundImage };
  }, withTray);
  assert.equal(edge.composerSide, edge.composer, `the composer's border is one colour ${when}`);
  assert.ok(edge.after.includes(edge.composer), `the bottom corner line is the border colour ${edge.composer} ${when}: ${edge.after}`);
  if (withTray) {
    assert.equal(edge.tray, edge.composer, `the bar's border matches the composer's ${when}`);
    assert.ok(edge.trayMark.includes(edge.composer), `the top corner line is the border colour ${edge.composer} ${when}: ${edge.trayMark}`);
  } else assert.ok(edge.before.includes(edge.composer), `the top corner line is the border colour ${edge.composer} ${when}: ${edge.before}`);
}

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
  // Masih (18 and 19 Oct): the corner lines' colour and the box's edge "shouldn't be" different. The bar, the composer
  // and both corner lines are one edge, in one colour, at rest and while typing.
  await oneEdge(page, true, 'at rest');
  await page.locator('.composer textarea').first().focus();
  await oneEdge(page, true, 'while typing');

  await page.locator('.thread-row .thread-link').first().click();
  await page.locator('.composer-tray').waitFor({ state: 'detached' });
  await oneEdge(page, false, 'in a chat');
  const alone = await corner(page, '.composer');
  assert.notEqual(alone.display, 'none');
  assert.equal(alone.markSize, alone.cut, 'In a chat the accent spans the composer\'s own cut');
  if (alone.shape) assert.match(alone.shape, /^(bevel|superellipse\(0\))$/, 'The corner is cut, not rounded');
});
