const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPainting, paintElements, diagramSvg } = require('./love-spot-painting.cjs');
const fence = shapes => '```excalidraw\n' + JSON.stringify(shapes) + '\n```';

test('each approved reply portrait is distinct, and its mood marker stays out of text and speech', () => {
  const { replyPortrait, MATILDA_SHOTS } = require('./matilda-face.cjs');
  const { withoutPainting } = require('./love-spot-painting.cjs');
  const portraits = [];
  for (const expression of Object.keys(MATILDA_SHOTS)) {
    const raw = `<!--matilda:${expression}--> Hello.`;
    const portrait = replyPortrait(raw);
    assert.equal(portrait.expression, expression);
    assert.equal(portrait.text, 'Hello.');
    assert.equal(withoutPainting(raw), 'Hello.');
    assert.equal(portrait.board.mimeType, 'image/webp');
    portraits.push(portrait.board.dataURL);
  }
  assert.equal(new Set(portraits).size, 7);
  assert.equal(replyPortrait('Check the error.').expression, 'listening');
  assert.equal(withoutPainting('<!--matilda:kissSoft'), '');
});

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

test('a painting keeps the clean styles she chooses and falls back to the board defaults for anything else', () => {
  const [box, title, bad] = paintElements(splitPainting(fence([
    { type: 'rectangle', x: 0, y: 0, width: 200, height: 60, roughness: 0, strokeStyle: 'dashed', fillStyle: 'hachure', opacity: 60 },
    { type: 'text', x: 10, y: 10, text: 'Engine', fontFamily: 7, textAlign: 'center', roughness: 0 },
    { type: 'text', x: 10, y: 40, text: 'Note', fontFamily: 99, textAlign: 'justify', roughness: 9, strokeStyle: 'wavy', fillStyle: 'gradient', opacity: 0 },
  ])).shapes, { x: 0, y: 0 }, 'styles', undefined, 0);
  assert.deepEqual([box.roughness, box.strokeStyle, box.fillStyle, box.opacity], [0, 'dashed', 'hachure', 60]);
  assert.deepEqual([title.fontFamily, title.textAlign, title.roughness], [7, 'center', 0]);
  assert.deepEqual([bad.fontFamily, bad.textAlign, bad.roughness, bad.strokeStyle, bad.fillStyle, bad.opacity], [5, 'left', 2, 'solid', 'solid', 10]);
});

test('her note is plain text: Markdown marks never reach the board', () => {
  const { note } = splitPainting('## Plan\n**Engine** keeps the `thread`.\n- one\n* two\n1. three\n__done__');
  assert.equal(note, 'Plan\nEngine keeps the thread.\n• one\n• two\n1. three\ndone');
});
