// Workflows uses the app's own controls (24 Oct 2026: "look like the rest of the app"): every row of every board pop-up
// is the shared menu row, sized alike, and every field is a components/ui field; only the graph's own glyphs (ports,
// wire ends and wire labels) are drawn by the board.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

const graph = { name: 'Shared controls', edges: [{ id: 'a->b', source: 'a', target: 'b' }], nodes: [
  ...['a', 'b'].map((id, index) => ({ id, type: 'agent', position: { x: 260 + index * 260, y: 40 }, data: { title: id.toUpperCase(), instruction: '', model: null, writeScopes: [], acceptanceCriteria: [] } })),
  { id: 'n', type: 'note', position: { x: 260, y: 300 }, data: { text: 'Mine' } }] };
const GLYPHS = '.react-flow__controls-button';

test('every Workflows pop-up row is the shared menu row and every field a shared field', async () => {
  const f = await openCanvas({ graph, autoLayout: false });
  try {
    const off = () => f.page.evaluate(() => document.activeElement?.blur());
    // "Change this…" is the app-wide Improve Elpis item (components/improve-elpis.tsx), in every menu of the app.
    const rows = popup => popup.locator('button:not([data-slot="change-menuitem"])').evaluateAll(items => items.map(item => { const s = getComputedStyle(item); return { slot: item.dataset.slot, text: item.textContent.trim().split('\n')[0], size: `${s.fontSize} ${s.paddingTop} ${s.paddingLeft}` }; }));
    const seen = [];
    const pick = async id => { await f.canvas.locator(`.react-flow__node[data-id="${id}"]`).click(); await off(); };
    // The board's menu, an agent's menu, the command bar and Find: each opened by its key or a right-click.
    const board = await f.canvas.locator('.react-flow__pane').boundingBox();
    await f.page.mouse.click(board.x + board.width - 40, board.y + board.height - 200, { button: 'right' });
    seen.push(...await rows(f.canvas.getByRole('menu', { name: 'Board', exact: true }))); await f.page.keyboard.press('Escape');
    await pick('a'); await f.page.keyboard.press('Shift+F10');
    seen.push(...await rows(f.canvas.getByRole('menu', { name: 'Agent A', exact: true }))); await f.page.keyboard.press('Escape');
    await pick('a'); await f.page.keyboard.press('Tab');
    seen.push(...await rows(f.canvas.getByRole('dialog', { name: 'Add agents', exact: true }))); await f.page.keyboard.press('Escape');
    await off(); await f.page.keyboard.press('Control+f'); await f.canvas.getByRole('textbox', { name: 'Find agents', exact: true }).fill('');
    seen.push(...await rows(f.canvas.getByRole('dialog', { name: 'Find on board', exact: true }))); await f.page.keyboard.press('Escape');
    assert.ok(seen.length >= 12, `rows were found (${seen.length})`);
    for (const row of seen) assert.equal(row.slot, 'menu-row', `${row.text} is the shared menu row`);
    assert.equal(new Set(seen.map(row => row.size)).size, 1, `one size for every row: ${[...new Set(seen.map(row => row.size))]}`);

    // Fields and buttons on the board and in the panel: each comes from components/ui.
    await pick('a');
    // (A shared Select keeps its value in its own hidden input.)
    const handmade = await f.canvas.locator(`button:not([data-slot]):not(${GLYPHS}), input:not([data-slot]):not([aria-hidden="true"]), textarea:not([data-slot]), select:not([data-slot])`).evaluateAll(items => items.map(item => item.outerHTML.slice(0, 120)));
    assert.deepEqual(handmade, [], 'no hand-made controls');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
