const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { MATILDA_SHOTS, MATILDA_SHOTS_LIGHT, replyPortrait } = require('../bridge/matilda-face.cjs');

test('approved portraits have a clear backdrop in light, dark and board modes', async t => {
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
      out.push({ theme, name, transparent, dressAlpha: context.getImageData(96, 180, 1, 1).data[3], outsideCircle: [[10,180],[180,180],[0,96],[191,191]].map(([x,y]) => context.getImageData(x,y,1,1).data[3]) });
    }
    return out;
  }, { dark: MATILDA_SHOTS, light: MATILDA_SHOTS_LIGHT, board: Object.fromEntries(Object.keys(MATILDA_SHOTS).map(name => [name, replyPortrait(`<!--matilda:${name}-->`).board.dataURL])) });
  for (const result of results) {
    assert.ok(result.transparent > 0, `${result.theme}/${result.name}: the page shows through the portrait backdrop`);
    assert.ok(result.outsideCircle.every(alpha => alpha < 20), `${result.theme}/${result.name}: the approved circular crop remains clear outside its edge`);
    assert.ok(result.dressAlpha >= 250, `${result.theme}/${result.name}: the approved dress remains opaque`);
  }
  assert.deepEqual(f.errors, []);
});
