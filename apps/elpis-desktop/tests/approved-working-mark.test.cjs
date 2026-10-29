const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { icons } = require('./fixtures/elpis-icon-collection.json');

// Masih, 29 Oct: "use its animation from the collection as the waiting animation, just so I can compare": the working mark
// is context--animation.svg (the context gauge's six ring segments turning once every 8 s around its hexagon core).
for (const colorScheme of ['light', 'dark']) {
  test(`the working mark is the collection's turning context gauge in ${colorScheme}`, async t => {
    const f = await fixture({ colorScheme, running: true });
    t.after(() => f.close());
    await f.open('chat-a');
    const mark = f.page.locator('.elpis-working-mark').last();
    await mark.waitFor();
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await f.page.emulateMedia({ reducedMotion });
      const actual = await mark.evaluate(svg => {
        const rotor = svg.querySelector('.elpis-working-rotor'), probe = document.createElement('span');
        probe.style.color = 'var(--primary-action, var(--primary))'; document.body.append(probe);
        const accent = getComputedStyle(probe).color; probe.remove();
        return {
          size: `${svg.getBoundingClientRect().width}x${svg.getBoundingClientRect().height}`,
          viewBox: svg.getAttribute('viewBox'),
          ring: [...rotor.querySelectorAll('path')].map(path => path.getAttribute('d')),
          core: svg.querySelector('.elpis-working-core').getAttribute('d'),
          fills: [...svg.querySelectorAll('path')].every(path => getComputedStyle(path).fill === accent),
          animation: getComputedStyle(rotor).animationName === 'none' ? 'none' : `${getComputedStyle(rotor).animationName} ${getComputedStyle(rotor).animationDuration}`,
        };
      });
      assert.equal(actual.size, '18x18', 'the size of the spinner it replaces');
      assert.equal(actual.viewBox, icons.context.viewBox);
      assert.deepEqual([...actual.ring, actual.core], icons.context.paths, "the collection's ring segments and core");
      assert.ok(actual.fills, 'drawn in the accent, as the spinner was');
      assert.equal(actual.animation, reducedMotion === 'reduce' ? 'none' : 'elpis-orbit 8s', 'turns once every 8 s; still under reduced motion');
    }
    assert.deepEqual(f.errors, []);
  });
}
