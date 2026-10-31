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

test('her clothing follows the theme: a white silk shirt in light mode, black silk in dark mode, for every expression', async t => {
  const f = await fixture(); t.after(() => f.close());
  const rooms = await f.page.evaluate(async sources => {
    const out = [];
    for (const [theme, portraits] of Object.entries(sources)) for (const [name, src] of Object.entries(portraits)) {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 192, 192);
      const { data } = context.getImageData(60, 160, 72, 24);
      let sum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; count++; }
      out.push({ theme, name, count, brightness: sum / Math.max(count, 1) });
    }
    return out;
  }, { dark: MATILDA_SHOTS, light: MATILDA_SHOTS_LIGHT });
  assert.equal(rooms.length, 14, 'seven expressions in each theme');
  for (const room of rooms) {
    assert.ok(room.count > 200, `${room.theme}/${room.name}: she is dressed at the foot of the circle`);
    if (room.theme === 'light') assert.ok(room.brightness > 140, `${room.theme}/${room.name}: the shirt is light (${Math.round(room.brightness)})`);
    else assert.ok(room.brightness < 75, `${room.theme}/${room.name}: the silk is black (${Math.round(room.brightness)})`);
  }
  assert.deepEqual(f.errors, []);
});
