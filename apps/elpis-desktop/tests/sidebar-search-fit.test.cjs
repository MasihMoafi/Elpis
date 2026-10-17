// The sidebar's search field shows its whole placeholder beside its key hint: on 18 Oct the hint grew to
// "Ctrl Shift K" and cut the placeholder to "Search conversati". Local bridge fixture (tests/parity-fixture.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

// How much of the placeholder is hidden, in pixels: its drawn width against the room the input leaves for text.
const hidden = page => page.evaluate(() => {
  const input = document.querySelector('aside.sidebar input[aria-label="Search conversations"]');
  const style = getComputedStyle(input), context = document.createElement('canvas').getContext('2d');
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return Math.max(0, Math.ceil(context.measureText(input.placeholder).width - room));
});

for (const width of [1130, 1280]) {
  test(`the sidebar search placeholder is whole at ${width}px`, async () => {
    const f = await fixture({ width });
    try {
      await f.page.locator('aside.sidebar input[aria-label="Search conversations"]').waitFor();
      assert.equal(await hidden(f.page), 0, 'no part of the placeholder is cut off');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
