const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPainting, paintElements, diagramSvg } = require('./love-spot-painting.cjs');
const fence = shapes => '```excalidraw\n' + JSON.stringify(shapes) + '\n```';

test('positioned connectors and absolute-point connectors produce the same board geometry', () => {
  const positioned = splitPainting(fence([{ type: 'rectangle', x: 0, y: 0, width: 200, height: 60 }, { type: 'arrow', x: 100, y: 60, points: [[0, 0], [0, 50], [-40, 80]] }])).shapes;
  const absolute = splitPainting(fence([{ type: 'rectangle', x: 0, y: 0, width: 200, height: 60 }, { type: 'arrow', points: [[100, 60], [100, 110], [60, 140]] }])).shapes;
  const a = paintElements(positioned, { x: 20, y: 30 }, 'same', undefined, 0);
  const b = paintElements(absolute, { x: 20, y: 30 }, 'same', undefined, 0);
  assert.deepEqual(a, b);
  assert.deepEqual([a[1].x, a[1].y, a[1].points], [120, 90, [[0, 0], [0, 50], [-40, 80]]]);
});

test('inline SVG uses the same connector positions, escapes labels and refuses broken drawing data', () => {
  const svg = diagramSvg(JSON.stringify([{ type: 'rectangle', x: 0, y: 0, width: 200, height: 60 }, { type: 'arrow', x: 100, y: 60, points: [[0, 0], [0, 50]] }, { type: 'text', x: 20, y: 20, text: '<script>alert(1)</script>', strokeColor: 'url(https://invalid)' }]));
  assert.match(svg, /points="116,76 116,126"/);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script|https:|url\(https/);
  assert.equal(diagramSvg('[broken]'), null);
  assert.equal(diagramSvg('[]'), null);
});
