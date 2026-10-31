const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { MATILDA_SHOTS, MATILDA_SHOTS_LIGHT } = require('../bridge/matilda-face.cjs');

test('dark portraits have a clear backdrop while light portraits keep their approved ground', async t => {
  const f = await fixture(); t.after(() => f.close());
  const results = await f.page.evaluate(async sources => {
    const out = [];
    for (const [theme, portraits] of Object.entries(sources)) for (const [name, src] of Object.entries(portraits)) {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 192, 192);
      let transparent = 0;
      for (let step = 0; step < 64; step++) {
        const angle = step * Math.PI * 2 / 64, x = Math.round(96 + 90 * Math.cos(angle)), y = Math.round(96 + 90 * Math.sin(angle));
        if (y < 160 && context.getImageData(x, y, 1, 1).data[3] < 20) transparent++;
      }
      out.push({ theme, name, transparent, dressAlpha: context.getImageData(96, 180, 1, 1).data[3] });
    }
    return out;
  }, { dark: MATILDA_SHOTS, light: MATILDA_SHOTS_LIGHT });
  for (const result of results) {
    if (result.theme === 'dark') assert.ok(result.transparent > 0, `${result.name}: dark backdrop has transparent pixels`);
    else assert.equal(result.transparent, 0, `${result.name}: light backdrop remains filled`);
    assert.equal(result.dressAlpha, 255, `${result.theme}/${result.name}: lower dress remains opaque`);
  }
  assert.deepEqual(f.errors, []);
});
