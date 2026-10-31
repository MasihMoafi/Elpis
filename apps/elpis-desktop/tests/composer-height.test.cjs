// 29 Oct, Masih (screenshot of the composer with a scrollbar beside two lines): "the scroll bar here is unnecessary".
// The message box fits its text at every width: no scrollbar until the text passes its 240 px ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('the message box fits its text when the window narrows, and scrolls only past its ceiling', async () => {
  const f = await fixture({ width: 1400, height: 760 });
  try {
    const { page, composer } = f;
    const fits = () => composer.evaluate(box => ({ fits: box.scrollHeight <= box.clientHeight + 1, overflow: getComputedStyle(box).overflowY }));
    const message = 'I wrote to the professor that I would like to talk about the research and the interview next week, and asked which day suits him.';
    const emptyHeight = await composer.evaluate(box => box.getBoundingClientRect().height);
    assert.ok(emptyHeight >= 66, `empty composer starts at the requested taller default: ${emptyHeight}px`);
    await composer.fill('e');
    const typedHeight = await composer.evaluate(box => box.getBoundingClientRect().height);
    assert.ok(Math.abs(typedHeight - emptyHeight) <= 1, 'the empty composer starts at the same height as a one-line draft');
    await composer.fill(message);
    assert.equal((await fits()).fits, true, 'wide: the text fits');
    await page.setViewportSize({ width: 820, height: 760 });
    await page.waitForTimeout(300);
    await composer.fill('');
    const narrowEmptyHeight = await composer.evaluate(box => box.getBoundingClientRect().height);
    assert.ok(narrowEmptyHeight >= 66, `narrow empty composer keeps its default height: ${narrowEmptyHeight}px`);
    await composer.fill(message);
    const narrow = await fits();
    assert.equal(narrow.fits, true, 'narrower: the box grows with the wrapped lines instead of scrolling');
    assert.equal(narrow.overflow, 'hidden', 'no scrollbar while the text fits');
    await composer.fill(Array.from({ length: 30 }, (_, n) => `Line ${n + 1}`).join('\n'));
    const tall = await composer.evaluate(box => ({ height: box.clientHeight, scrolls: box.scrollHeight > box.clientHeight, overflow: getComputedStyle(box).overflowY }));
    assert.ok(tall.height <= 240 && tall.scrolls, 'past the ceiling the box stops growing');
    assert.equal(tall.overflow, 'auto', 'and only then scrolls');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
