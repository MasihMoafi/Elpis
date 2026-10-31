const assert = require('node:assert/strict');
const { icons } = require('./fixtures/elpis-icon-collection.json');

const words = value => value.replace(/,/g, ' ').trim().split(/\s+/).join(' ');

/** Check the exported SVG and the visible shape rendered by the browser. */
async function assertCollectionIcon(locator, name, where = name) {
  const expected = icons[name];
  assert.ok(expected, `${where}: fixture has no collection icon ${name}`);
  const actual = await locator.first().evaluate(svg => {
    const box = svg.getBBox(), rect = svg.getBoundingClientRect(), viewBox = svg.viewBox.baseVal;
    return {
      viewBox: svg.getAttribute('viewBox'),
      paths: [...svg.querySelectorAll('path')].map(path => path.getAttribute('d')),
      geometry: { x: box.x, y: box.y, width: box.width, height: box.height },
      viewport: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height, renderedWidth: rect.width, renderedHeight: rect.height },
    };
  });
  assert.equal(actual.viewBox, expected.viewBox, `${where}: wrong collection viewBox for ${name}`);
  assert.deepEqual(actual.paths.map(words), expected.paths.map(words), `${where}: wrong collection paths for ${name}`);
  assert.ok(actual.viewport.renderedWidth > 0 && actual.viewport.renderedHeight > 0, `${where}: SVG has no rendered size`);
  assert.ok(actual.geometry.width > 0 && actual.geometry.height > 0, `${where}: SVG has no rendered path geometry`);
  const b = actual.geometry, v = actual.viewport;
  assert.ok(b.x >= v.x - 0.5 && b.y >= v.y - 0.5 && b.x + b.width <= v.x + v.width + 0.5 && b.y + b.height <= v.y + v.height + 0.5,
    `${where}: path geometry falls outside its viewBox`);
}

module.exports = { assertCollectionIcon };
