const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) {
  test(`approved working animation remains hollow with a blinking dot in ${colorScheme}`, async t => {
    const f = await fixture({ colorScheme, running: true });
    t.after(() => f.close());
    await f.open('chat-a');
    const mark = f.page.locator('.elpis-working-mark').last();
    await mark.waitFor();
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await f.page.emulateMedia({ reducedMotion });
      const actual = await mark.evaluate(svg => {
        const shape = svg.querySelector('path');
        const dot = svg.querySelector('circle');
        return {
          width: svg.getBoundingClientRect().width,
          height: svg.getBoundingClientRect().height,
          fill: getComputedStyle(shape).fill,
          strokeWidth: getComputedStyle(shape).strokeWidth,
          rotation: getComputedStyle(svg.querySelector('.elpis-working-rotor')).animationDuration,
          blinkingDot: !!dot && getComputedStyle(dot).animationName !== 'none',
          blink: dot && getComputedStyle(dot).animationDuration,
        };
      });
      assert.equal(actual.width, 18, 'the mark keeps the approved send-icon size');
      assert.equal(actual.height, 18);
      assert.equal(actual.fill, 'none', 'the previous filled diamond must not return');
      assert.notEqual(actual.strokeWidth, '0px');
      assert.equal(actual.rotation, '4s', 'system motion settings must not halve the approved speed');
      assert.equal(actual.blinkingDot, true);
      assert.equal(actual.blink, '2s');
    }
    assert.deepEqual(f.errors, []);
  });
}
