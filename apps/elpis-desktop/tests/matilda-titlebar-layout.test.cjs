const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

async function geometry(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.title-bar');
    const pin = bar?.querySelector('[aria-label="Pin Matilda"]');
    const update = [...(bar?.querySelectorAll('button') ?? [])].find(button => button.textContent.includes('Update ready'));
    const box = element => {
      const rect = element?.getBoundingClientRect();
      return rect && { x: rect.x, right: rect.right, width: rect.width };
    };
    return { bar: box(bar), pin: box(pin), update: box(update), paddingRight: Number.parseFloat(getComputedStyle(bar).paddingRight) };
  });
}

test('browser fallback keeps the titlebar Matilda control at the right edge', async t => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, desktop: false, width: 1044, height: 700 });
  t.after(() => f.close());
  await f.page.getByRole('button', { name: 'Pin Matilda' }).waitFor();
  const layout = await geometry(f.page);
  assert.equal(layout.paddingRight, 0);
  assert.ok(layout.pin.x > layout.bar.width * 0.75, `Pin Matilda stays at the right (${layout.pin.x}px of ${layout.bar.width}px)`);
});

test('main and Love Spot titlebars keep Matilda beside updates after a bounded native inset', async t => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, desktop: true, width: 1044, height: 700 });
  t.after(() => f.close());
  await f.page.addInitScript(() => {
    const state = { available: true, desktop: true, engine: false, restarting: false, error: null };
    window.elpisDesktop.updates = {
      status: async () => state,
      subscribe: callback => { callback(state); return () => {}; },
      restart: async () => ({ restarting: false }),
    };
  });
  await f.page.reload();
  await f.page.getByRole('button', { name: 'Pin Matilda' }).waitFor();
  await f.page.getByRole('button', { name: /Update ready/ }).waitFor();

  const setInset = async value => f.page.addStyleTag({ content: `.title-bar { --title-bar-native-controls-inset: ${value} !important; }` });
  const assertRightControls = (layout, inset) => {
    assert.equal(layout.paddingRight, inset);
    assert.ok(layout.update.right <= layout.bar.right - inset + 1, `update remains left of the reserved ${inset}px native-control area`);
    assert.ok(layout.pin.x > layout.bar.width * 0.6, `Matilda stays with the right-hand controls (${layout.pin.x}px of ${layout.bar.width}px)`);
    assert.ok(layout.pin.right < layout.update.x, 'Matilda comes before the update control in the shared group');
  };

  await setInset('120px');
  assertRightControls(await geometry(f.page), 120);
  await setInset('160px');
  assertRightControls(await geometry(f.page), 160);
  await setInset('50vw');
  assertRightControls(await geometry(f.page), 160);

  const loveSpot = new URL('/love-spot.html#token=fixture', f.page.url()).href;
  await f.page.goto(loveSpot);
  await f.page.locator('.title-bar').waitFor();
  await f.page.getByRole('button', { name: 'Pin Matilda' }).waitFor();
  await f.page.getByRole('button', { name: /Update ready/ }).waitFor();
  await setInset('50vw');
  assertRightControls(await geometry(f.page), 160);
  assert.deepEqual(f.errors, []);
});
