// Keys Masih presses on the board, end to end (24 Oct 2026: "test the keystrokes"): Escape clears a selection, as in
// Blender and n8n; Run explains refusals at the bottom without moving the toolbar (Masih, 27 Oct).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

// WB acceptance contract: keep the restored keys, give every new command a real key event,
// and prove edits, cancellation, history and typing isolation through the rendered board.
const editingGraph = () => ({ name: 'Keyboard editing', nodes: [
  ...['a', 'b', 'c', 'd'].map((id, index) => ({ id, type: 'agent', position: { x: 220 + (index === 3 ? 1 : index) * 260, y: index === 3 ? 260 : 0 },
    data: { title: id.toUpperCase(), instruction: `Write ${id}`, model: null, writeScopes: [id === 'd' ? 'docs' : 'src'], acceptanceCriteria: [] } })),
  { id: 'n', type: 'note', position: { x: 220, y: 450 }, data: { text: 'Personal' } },
], edges: [{ id: 'a->b', source: 'a', target: 'b' }, { id: 'b->c', source: 'b', target: 'c', label: 'Result' }] });
const off = f => f.page.evaluate(() => document.activeElement?.blur());
const pick = async (f, id) => { await f.canvas.locator(`.react-flow__node[data-id="${id}"]`).click(); await off(f); };
const selectedIds = f => f.canvas.locator('.react-flow__node-agent.selected').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
const editing = () => openCanvas({ graph: editingGraph(), autoLayout: false });
const geometry = graph => ({ nodes: graph.nodes.map(({ id, type, position, isoPosition, data }) => ({ id, type, position, isoPosition, muted: data.muted })), edges: graph.edges, frames: graph.frames });
async function wirePoint(f, id, fraction = .5) {
  return f.canvas.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate((path, fraction) => {
    const point = path.getPointAtLength(path.getTotalLength() * fraction), screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, fraction);
}

for (const [key, dx, dy] of [['Alt+ArrowRight', 20, 0], ['Alt+Shift+ArrowDown', 0, 200]]) test(`${key} nudges one or ten grid units, with one Undo and Redo`, async () => {
  const f = await editing();
  try {
    await pick(f, 'b'); const before = await f.saved(), position = before.nodes.find(n => n.id === 'b').position;
    await f.page.keyboard.press(key); let after = await f.saved();
    assert.deepEqual(after.nodes.find(n => n.id === 'b').position, { x: position.x + dx, y: position.y + dy });
    assert.deepEqual(after.nodes.find(n => n.id === 'a').position, before.nodes.find(n => n.id === 'a').position);
    await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await f.page.keyboard.press('Control+Shift+z'); after = await f.saved(); assert.deepEqual(after.nodes.find(n => n.id === 'b').position, { x: position.x + dx, y: position.y + dy });
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press(key);
    assert.deepEqual(geometry(await f.saved()), geometry(after));
  } finally { await f.close(); }
});

test('Ctrl+G frames a selection, F2 names it, Ctrl+Shift+G ungroups without removing agents or wires', async () => {
  const f = await editing();
  try {
    await pick(f, 'a'); await f.canvas.locator('.react-flow__node[data-id="b"]').click({ modifiers: ['Shift'] }); await off(f);
    const before = await f.saved(); await f.page.keyboard.press('Control+g'); let after = await f.saved();
    assert.deepEqual(after.frames[0].nodeIds.sort(), ['a', 'b']); assert.deepEqual(after.edges, before.edges);
    await f.page.keyboard.press('F2'); const name = f.canvas.getByRole('textbox', { name: 'Frame name', exact: true }); await name.fill('First stage'); await f.page.keyboard.press('Enter');
    assert.equal((await f.saved()).frames[0].title, 'First stage'); await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await f.canvas.waitFor();
    assert.equal((await f.saved()).frames[0].title, 'First stage'); await f.canvas.locator('.canvas-frame-title').click(); await off(f); await f.page.keyboard.press('Control+Shift+g');
    assert.equal((await f.saved()).frames.length, 0); assert.deepEqual(geometry(await f.saved()).nodes, geometry(before).nodes); assert.deepEqual((await f.saved()).edges, before.edges);
    await f.page.keyboard.press('Control+z'); assert.equal((await f.saved()).frames[0].title, 'First stage');
    await pick(f, 'b'); await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Control+Shift+g'); assert.equal((await f.saved()).frames.length, 1);
    await f.page.keyboard.press('Control+g'); assert.equal((await f.saved()).frames.length, 1);
  } finally { await f.close(); }
});

test('a frame moves all its members on the grid in one undo step, and Escape cancels the whole drag', async () => {
  const f = await editing();
  try {
    await pick(f, 'a'); await f.canvas.locator('.react-flow__node[data-id="b"]').click({ modifiers: ['Shift'] }); await off(f); await f.page.keyboard.press('Control+g'); const before = await f.saved();
    const drag = async cancel => {
      const title = f.canvas.locator('.canvas-frame-title'); await title.hover();
      const box = await title.boundingBox(), start = { x: box.x + 30, y: box.y + box.height / 2 };
      const hit = await f.page.evaluate(at => {
        const target = document.elementFromPoint(at.x, at.y), flow = document.querySelector('.canvas-board > .react-flow')?.getBoundingClientRect();
        return { title: !!target?.closest('.canvas-frame-title'), target: target?.outerHTML.slice(0, 400), flow: flow?.toJSON(), at };
      }, start);
      assert.ok(hit.title, `frame drag must start on its visible title: ${JSON.stringify(hit)}`);
      await f.page.mouse.move(start.x, start.y); await f.page.mouse.down();
      await f.page.mouse.move(box.x + 80, box.y + box.height / 2 + 50, { steps: 10 }); if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up();
    };
    await drag(true); assert.deepEqual(geometry(await f.saved()), geometry(before)); await drag(false); const after = await f.saved();
    const delta = id => { const old = before.nodes.find(n => n.id === id).position, next = after.nodes.find(n => n.id === id).position; return { x: next.x - old.x, y: next.y - old.y }; };
    assert.notDeepEqual(delta('a'), { x: 0, y: 0 }); assert.deepEqual(delta('a'), delta('b')); assert.equal(delta('a').x % 20, 0); assert.equal(delta('a').y % 20, 0); assert.deepEqual(delta('c'), { x: 0, y: 0 });
    await off(f); await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
  } finally { await f.close(); }
});

test('Ctrl+F finds existing agents; Enter reveals the chosen result and Escape cancels without adding', async () => {
  const f = await editing();
  try {
    await pick(f, 'a'); await f.page.keyboard.press('Control+f'); const search = f.canvas.getByRole('textbox', { name: 'Find agents', exact: true }); await search.fill('C'); await f.page.keyboard.press('Enter');
    assert.deepEqual(await selectedIds(f), ['c']); await f.agentCount(4, 'find does not add');
    await off(f); await f.page.keyboard.press('Control+f'); await f.page.keyboard.press('Escape'); assert.deepEqual(await selectedIds(f), ['c']);
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Control+f'); assert.equal(await search.count(), 0);
  } finally { await f.close(); }
});

test('Ctrl+Shift+Enter previews the selected run with ancestors, excludes unrelated work, and empty selection cannot run', async () => {
  const f = await editing();
  try {
    await off(f); await f.page.keyboard.press('Control+Shift+Enter'); assert.equal(f.runs.length, 0);
    await pick(f, 'b'); await f.page.keyboard.press('Control+Shift+Enter'); const scope = f.canvas.getByRole('dialog', { name: 'Run selected', exact: true }); await scope.waitFor();
    assert.match(await scope.innerText(), /A/); assert.match(await scope.innerText(), /B/); assert.ok(!(await scope.innerText()).includes('D ·'));
    await f.page.keyboard.press('Escape'); assert.equal(f.runs.length, 0);
    await off(f); await f.page.keyboard.press('Control+Shift+Enter'); await scope.getByRole('button', { name: 'Run selected', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Run capture"]')); assert.deepEqual(f.runs[0].tasks.map(t => t.id), ['a', 'a-check', 'b', 'b-check']);
    assert.deepEqual((await f.saved()).edges, editingGraph().edges);
  } finally { await f.close(); }
});

test('a selected run fills missing prompts only inside its previewed scope and preserves unrelated agents and wiring', async () => {
  const graph = editingGraph(); graph.nodes.find(n => n.id === 'b').data.instruction = ''; graph.nodes.find(n => n.id === 'd').data.instruction = '';
  const f = await openCanvas({ graph, autoLayout: false });
  try {
    await pick(f, 'b'); await f.page.keyboard.press('Control+Shift+Enter'); await f.canvas.getByRole('dialog', { name: 'Run selected', exact: true }).getByRole('button', { name: 'Run selected', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Run capture"]'));
    assert.deepEqual(f.plans[0].agents.map(node => node.key), ['a', 'b']); assert.deepEqual(f.runs[0].tasks.map(task => task.id), ['a', 'a-check', 'b', 'b-check']);
    const after = await f.saved(); assert.equal(after.nodes.find(n => n.id === 'd').data.instruction, ''); assert.deepEqual(after.edges, graph.edges); assert.equal(after.nodes.filter(n => n.type === 'agent').length, 4);
  } finally { await f.close(); }
});

test('Alt+Shift+M toggles the minimap, with no response in menus or fields', async () => {
  const f = await editing();
  try {
    // The minimap starts hidden (27 Oct: its grey boxes were noise); the key shows it and the board remembers.
    await off(f); assert.equal(await f.canvas.locator('.react-flow__minimap').count(), 0);
    await f.page.keyboard.press('Alt+Shift+m'); await f.canvas.locator('.react-flow__minimap').waitFor();
    await f.saved(); await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await f.canvas.waitFor(); await f.canvas.locator('.react-flow__minimap').waitFor(); await off(f);
    await f.page.keyboard.press('Alt+Shift+m'); assert.equal(await f.canvas.locator('.react-flow__minimap').count(), 0);
    await pick(f, 'a'); await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Alt+Shift+m'); assert.equal(await f.canvas.locator('.react-flow__minimap').count(), 0);
  } finally { await f.close(); }
});

test('Ctrl+right-drag cuts crossed wires once, Escape cancels, and unmodified right-drag preserves them', async () => {
  const f = await editing();
  try {
    await off(f); const before = await f.saved(), at = await wirePoint(f, 'a->b'), next = await wirePoint(f, 'b->c');
    const cut = async (ctrl, cancel = false) => {
      if (ctrl) await f.page.keyboard.down('Control'); await f.page.mouse.move(at.x, at.y - 45); await f.page.mouse.down({ button: 'right' });
      await f.page.mouse.move(at.x, at.y + 45, { steps: 8 }); await f.page.mouse.move(next.x, next.y + 45, { steps: 6 }); await f.page.mouse.move(next.x, next.y - 45, { steps: 8 }); if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up({ button: 'right' }); if (ctrl) await f.page.keyboard.up('Control');
    };
    await cut(true, true); assert.deepEqual((await f.saved()).edges, before.edges);
    await cut(false); await f.page.keyboard.press('Escape'); assert.deepEqual((await f.saved()).edges, before.edges);
    await off(f); await cut(true); assert.deepEqual((await f.saved()).edges, []); assert.equal(await f.canvas.getByRole('menu').count(), 0);
    await off(f); await f.page.keyboard.press('Control+z'); assert.deepEqual((await f.saved()).edges, before.edges);
    await f.page.keyboard.press('Control+Shift+z'); assert.deepEqual((await f.saved()).edges, []);
  } finally { await f.close(); }
});

test('flat and isometric views share new editing commands, frame names, note text and the same history', async () => {
  const f = await editing();
  try {
    for (const iso of [true, false]) {
      await f.canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click(); await f.fit();
      const node = id => f.canvas.locator(iso ? `.iso-node[data-id="${id}"]` : `.react-flow__node[data-id="${id}"]`);
      await node('b').click(); await off(f); const before = geometry(await f.saved());
      await f.page.keyboard.press('Alt+ArrowRight'); assert.equal((await f.saved()).nodes.find(n => n.id === 'b').position.x, before.nodes.find(n => n.id === 'b').position.x + 20);
      await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), before);
      await f.page.keyboard.press('m'); assert.equal((await f.saved()).nodes.find(n => n.id === 'b').data.muted, true); await f.page.keyboard.press('Control+z');
      await f.page.keyboard.press('Control+g'); await f.page.keyboard.press('F2'); const field = f.canvas.getByRole('textbox', { name: 'Frame name', exact: true }); await field.fill('Shared stage'); await f.page.keyboard.press('Enter'); await off(f);
      assert.equal((await f.saved()).frames[0].title, 'Shared stage'); await f.page.keyboard.press('Control+Shift+g'); assert.equal((await f.saved()).frames.length, 0);
      const view = () => f.canvas.locator(iso ? '.iso-world' : '.react-flow__viewport').getAttribute(iso ? 'transform' : 'style');
      const originalView = await view(); await f.page.keyboard.press('-'); await f.page.waitForTimeout(300); assert.notEqual(await view(), originalView); await f.page.keyboard.press('0');
      await f.page.keyboard.press('Control+f'); await f.canvas.getByRole('textbox', { name: 'Find agents', exact: true }).fill('C'); await f.page.keyboard.press('Enter');
      const selected = iso ? await f.canvas.locator('.iso-node[aria-pressed="true"]').getAttribute('data-id') : (await selectedIds(f))[0]; assert.equal(selected, 'c');
      assert.equal(await f.canvas.getByRole('textbox', { name: 'Note', exact: true }).inputValue(), 'Personal');
      // Find centred C, which can leave A outside the board: show the whole graph before pointing at it.
      // Double-click opens Info on the flat board and renames on the isometric one (tests/canvas-editing.test.cjs pins it).
      await f.fit(); await node('a').dblclick();
      if (iso) { await f.canvas.getByRole('textbox', { name: 'Rename agent', exact: true }).waitFor(); await f.page.keyboard.press('Escape'); }
      else { await f.canvas.getByRole('dialog', { name: 'A info', exact: true }).waitFor(); await f.page.keyboard.press('Escape'); }
    }
  } finally { await f.close(); }
});
