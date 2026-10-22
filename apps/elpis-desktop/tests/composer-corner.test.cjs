const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

// The composer's cut corners are drawn by its own border, the same width and colour as its straight edges (R32); no
// separate corner lines. On a new chat the environment bar sits on top and squares the composer's top corners, so the
// bar's own cut is the box's outer corner.
const box = (page, selector) => page.locator(selector).first().evaluate(element => {
  const style = getComputedStyle(element), line = name => { const { content } = getComputedStyle(element, name); return content !== 'none' && content !== 'normal'; };
  return { widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], colors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor].filter((_, i) => parseFloat([style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth][i]) > 0),
    cut: style.borderTopLeftRadius, shape: style.getPropertyValue('corner-shape'), accents: line('::before') || line('::after') };
});
const oneColour = (edge, when) => assert.equal(new Set(edge.colors).size, 1, `a box's edges are one colour ${when}: ${edge.colors}`);

for (const colorScheme of ['light', 'dark']) test(`the composer's cut corners are its own border, with no separate corner lines (${colorScheme})`, async t => {
  const f = await fixture({ width: 1280, height: 860, colorScheme });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f;
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.locator('.composer-tray').waitFor();
  for (const when of ['at rest', 'while typing']) {
    if (when === 'while typing') await page.locator('.composer textarea').first().focus();
    const tray = await box(page, '.composer-tray'), composer = await box(page, '.composer');
    assert.equal(tray.accents || composer.accents, false, `no separate corner lines ${when}`);
    assert.notEqual(tray.cut, '0px', `the bar's top-left corner is cut ${when}`);
    assert.equal(composer.cut, '0px', `below the bar the composer has no top corner of its own ${when}`);
    assert.deepEqual(tray.widths, ['1px', '1px', '0px', '1px'], `the bar's border is one width ${when}`);
    assert.deepEqual(composer.widths, ['1px', '1px', '1px', '1px'], `the composer's border is one width ${when}`);
    oneColour(tray, when); oneColour(composer, when);
    assert.equal(tray.colors[0], composer.colors[0], `the bar and the composer are one edge ${when}`);
  }

  await f.open('chat-a');
  await page.locator('.composer-tray').waitFor({ state: 'detached' });
  const alone = await box(page, '.composer');
  assert.equal(alone.accents, false, 'no separate corner lines in a chat');
  assert.notEqual(alone.cut, '0px', 'the composer\'s own corner is cut');
  assert.deepEqual(alone.widths, ['1px', '1px', '1px', '1px'], 'the cut corner has the straight edges\' width');
  oneColour(alone, 'in a chat');
  if (alone.shape) assert.match(alone.shape, /^(bevel|superellipse\(0\))$/, 'The corner is cut, not rounded');
});
