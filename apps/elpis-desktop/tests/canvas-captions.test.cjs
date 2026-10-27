// Every node's caption ("Agent", "Mother", "Note · for you", a frame's name) stays on one line, whole
// (24 Oct 2026: "AGENT · WAVE 1" wrapped onto two lines).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
test('every node kind keeps its caption on one line, never clipped', async () => {
  const graph = { name: 'Captions', frames: [{ id: 'f', title: 'Stage one', nodeIds: ['a', 'b'] }], edges: [{ id: 'a->b', source: 'a', target: 'b' }], nodes: [
    ...['a', 'b'].map((id, index) => ({ id, type: 'agent', position: { x: 260 + index * 260, y: 40 }, data: { title: `Agent ${id} with a long name that runs on`, instruction: '', model: null, writeScopes: [], acceptanceCriteria: [] } })),
    { id: 'n', type: 'note', position: { x: 260, y: 300 }, data: { text: 'Mine' } }] };
  const f = await openCanvas({ graph, autoLayout: false });
  try {
    const captions = await f.canvas.locator('.agent-node-kind, .canvas-note-grip, .canvas-frame-title strong').evaluateAll(items => items.map(item => {
      const style = getComputedStyle(item), line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
      return { text: item.textContent, oneLine: item.getBoundingClientRect().height <= line * 1.5, whole: item.scrollWidth <= item.clientWidth + 1 };
    }));
    assert.deepEqual(captions.map(caption => caption.text).sort(), ['Agent', 'Agent', 'Mother', 'Note · for you', 'Stage one'].sort());
    for (const caption of captions) { assert.ok(caption.oneLine, `${caption.text} wraps`); assert.ok(caption.whole, `${caption.text} is clipped`); }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
