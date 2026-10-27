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

for (const [key, expected] of [['Control+i', ['a', 'c', 'd']], ['Shift+ArrowLeft', ['a', 'b']], ['Shift+ArrowRight', ['b', 'c']]]) test(`${key} selects the intended agents and leaves text selection local`, async () => {
  const f = await editing();
  try {
    await pick(f, 'b'); await f.page.keyboard.press(key); assert.deepEqual(await selectedIds(f), expected);
    await pick(f, 'b'); await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus();
    await f.page.keyboard.press(key); assert.deepEqual(await selectedIds(f), ['b']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

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

test('Shift+A searches at the pointer, Escape cancels, and Enter creates an undoable agent there', async () => {
  const f = await editing();
  try {
    const pane = await f.canvas.locator('.react-flow__pane').boundingBox(); await off(f);
    const at = { x: pane.x + pane.width - 290, y: pane.y + pane.height - 180 }; await f.page.mouse.move(at.x, at.y);
    await f.page.keyboard.press('Shift+a'); const command = f.canvas.getByRole('textbox', { name: 'Command', exact: true }); await command.waitFor();
    await f.page.keyboard.press('Escape'); assert.equal((await f.saved()).nodes.length, 6);
    await off(f); await f.page.keyboard.press('Shift+a'); await command.fill('1: New work'); await f.page.keyboard.press('Enter');
    await f.agentCount(5, 'Shift+A insertion'); const made = (await f.saved()).nodes.find(n => n.data.instruction === 'New work'); assert.ok(made);
    const box = await f.canvas.locator(`.react-flow__node[data-id="${made.id}"]`).boundingBox();
    assert.ok(Math.abs(box.x - at.x) < 50 && Math.abs(box.y - at.y) < 80, 'captured pointer sets the new position');
    await off(f); await f.page.keyboard.press('Control+z'); await f.agentCount(4, 'Undo search insertion');
  } finally { await f.close(); }
});

test('Shift+S creates a personal note at the pointer; Undo removes it and typing stays in its editor', async () => {
  const f = await editing();
  try {
    await off(f); const pane = await f.canvas.locator('.react-flow__pane').boundingBox(); await f.page.mouse.move(pane.x + pane.width - 160, pane.y + 260);
    await f.page.keyboard.press('Shift+s'); assert.equal((await f.saved()).nodes.filter(n => n.type === 'note').length, 2);
    await off(f); await f.page.keyboard.press('Control+z'); assert.equal((await f.saved()).nodes.filter(n => n.type === 'note').length, 1);
    await f.canvas.getByRole('textbox', { name: 'Note', exact: true }).focus(); await f.page.keyboard.press('Shift+s');
    assert.equal((await f.saved()).nodes.filter(n => n.type === 'note').length, 1);
  } finally { await f.close(); }
});

test('M mutes an agent, the run skips it and heals its dependencies, Undo restores its enabled state', async () => {
  const f = await editing();
  try {
    await pick(f, 'b'); await f.page.keyboard.press('m'); const muted = await f.saved(); assert.equal(muted.nodes.find(n => n.id === 'b').data.muted, true);
    assert.equal(muted.edges.length, 2, 'mute preserves the drawing'); await f.page.keyboard.press('Control+Enter');
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Run capture"]'));
    assert.ok(f.runs.length); const tasks = f.runs[0].tasks;
    assert.ok(!tasks.some(t => t.id === 'b' || t.id === 'b-check')); assert.deepEqual(tasks.find(t => t.id === 'c').dependsOn, ['a', 'a-check']);
    await off(f); await f.page.keyboard.press('Control+z'); assert.equal((await f.saved()).nodes.find(n => n.id === 'b').data.muted, undefined);
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('m'); assert.equal((await f.saved()).nodes.find(n => n.id === 'b').data.muted, undefined);
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

test('Ctrl+X cuts with ordinary deletion, Ctrl+V preserves internal wires, and Undo restores the cut', async () => {
  const f = await editing();
  try {
    await pick(f, 'a'); await f.canvas.locator('.react-flow__node[data-id="b"]').click({ modifiers: ['Shift'] }); await off(f); const before = await f.saved(); await f.page.keyboard.press('Control+x');
    let graph = await f.saved(); assert.ok(!graph.nodes.some(n => n.id === 'a' || n.id === 'b')); assert.equal(graph.edges.length, 0, 'cut does not bypass');
    await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await f.page.keyboard.press('Control+v'); await f.agentCount(6, 'paste after cut'); graph = await f.saved();
    const copies = await selectedIds(f); assert.equal(graph.edges.filter(e => copies.includes(e.source) && copies.includes(e.target)).length, 1); assert.ok(!graph.edges.some(e => copies.includes(e.source) !== copies.includes(e.target)), 'only internal wires are pasted');
    await pick(f, 'b'); await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Control+x'); await f.agentCount(6, 'field cut');
  } finally { await f.close(); }
});

test('Shift+Alt+T tidies only selected agents; no selection tidies all; Undo preserves manual positions', async () => {
  const f = await editing();
  try {
    await pick(f, 'b'); await f.page.keyboard.press('Alt+ArrowDown'); const before = await f.saved();
    await f.page.keyboard.press('Shift+Alt+t'); const after = await f.saved();
    assert.notDeepEqual(after.nodes.find(n => n.id === 'b').position, before.nodes.find(n => n.id === 'b').position);
    for (const id of ['a', 'c', 'd', 'n']) assert.deepEqual(after.nodes.find(n => n.id === id).position, before.nodes.find(n => n.id === id).position);
    await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Shift+Alt+t'); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await off(f); await f.page.keyboard.press('Escape'); await f.page.keyboard.press('Shift+Alt+t'); assert.notDeepEqual(geometry(await f.saved()), geometry(before));
  } finally { await f.close(); }
});

for (const key of ['+', '-', '0', '.']) test(`${key} changes the view without editing the graph or firing in a field`, async () => {
  const f = await editing();
  try {
    await pick(f, 'b'); const before = await f.saved(), view = () => f.canvas.locator('.react-flow__viewport').getAttribute('style');
    if (key === '0') { await f.page.keyboard.press('-'); await f.page.waitForTimeout(300); }
    const previous = await view(); await f.page.keyboard.press(key); await f.page.waitForTimeout(350); assert.notEqual(await view(), previous);
    assert.deepEqual(geometry(await f.saved()), geometry(before));
    if (key === '0' || key === '.') { await f.page.keyboard.press('-'); await f.page.waitForTimeout(300); }
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); const fieldView = await view();
    await f.page.keyboard.press(key); await f.page.waitForTimeout(300); assert.equal(await view(), fieldView);
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

test('arrows select the nearest agent in that direction without moving it, in both views', async () => {
  const f = await editing();
  try {
    const before = await f.saved(); await pick(f, 'a'); await f.page.keyboard.press('ArrowRight'); assert.deepEqual(await selectedIds(f), ['b']);
    await f.page.keyboard.press('ArrowDown'); assert.deepEqual(await selectedIds(f), ['d']); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('ArrowLeft'); assert.deepEqual(await selectedIds(f), ['d']);
    await f.canvas.getByRole('radio', { name: 'Isometric', exact: true }).click(); await off(f); await f.page.keyboard.press('ArrowUp');
    assert.equal(await f.canvas.locator('.iso-node[aria-pressed="true"]').count(), 1); assert.deepEqual(geometry(await f.saved()), geometry(before));
  } finally { await f.close(); }
});

test('Shift+Tab selects the previous agent in stable board order, while Tab retains the command bar', async () => {
  const f = await editing();
  try {
    await pick(f, 'c'); const before = geometry(await f.saved()); await f.page.keyboard.press('Shift+Tab'); assert.deepEqual(await selectedIds(f), ['b']);
    assert.deepEqual(geometry(await f.saved()), before); await f.page.keyboard.press('Tab'); await f.canvas.getByRole('dialog', { name: 'Add agents', exact: true }).waitFor(); await f.page.keyboard.press('Escape');
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Shift+Tab'); assert.deepEqual(await selectedIds(f), ['b']);
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
    await off(f); await f.page.keyboard.press('Alt+Shift+m'); assert.equal(await f.canvas.locator('.react-flow__minimap').count(), 0);
    await f.saved(); await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await f.canvas.waitFor(); assert.equal(await f.canvas.locator('.react-flow__minimap').count(), 0, 'the board remembers its minimap'); await off(f);
    await f.page.keyboard.press('Alt+Shift+m'); await f.canvas.locator('.react-flow__minimap').waitFor();
    await pick(f, 'a'); await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Alt+Shift+m'); assert.equal(await f.canvas.locator('.react-flow__minimap').count(), 1);
  } finally { await f.close(); }
});

test('Shift+F10 opens the selection menu and shows the real command keys; menu keystrokes stay local', async () => {
  const f = await editing();
  try {
    // One agent's menu is the approved short one (canvas-basics pins it); the editing commands sit on a selection's menu.
    await pick(f, 'b'); await f.page.keyboard.press('Shift+F10'); const single = f.canvas.getByRole('menu', { name: 'Agent B', exact: true }); await single.waitFor();
    assert.equal(await single.getByRole('menuitem', { name: /^Mute/ }).count(), 0); await f.page.keyboard.press('Escape');
    await pick(f, 'b'); await f.page.keyboard.press('Shift+ArrowRight'); await f.page.keyboard.press('Shift+F10'); const menu = f.canvas.getByRole('menu', { name: '2 agents', exact: true }); await menu.waitFor();
    for (const [label, key] of [['Mute', 'M'], ['Frame selection', 'Ctrl+G'], ['Cut', 'Ctrl+X'], ['Run selected', 'Ctrl+Shift+Enter']]) assert.match(await menu.getByRole('menuitem', { name: new RegExp(label) }).innerText(), new RegExp(key.replace(/[+]/g, '\\+')));
    const before = await f.saved(); await f.page.keyboard.press('m'); assert.deepEqual(geometry(await f.saved()), geometry(before)); await f.page.keyboard.press('Escape');
    await pick(f, 'b'); await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('Shift+F10'); assert.equal(await single.count(), 0);
  } finally { await f.close(); }
});

test('L draws a freehand lasso, Shift adds, Alt subtracts, Escape restores the original selection', async () => {
  const f = await editing();
  try {
    await pick(f, 'b'); const before = await f.saved(), box = await f.canvas.locator('.react-flow__node[data-id="a"]').boundingBox();
    const points = [[box.x - 15, box.y - 15], [box.x + box.width + 15, box.y - 15], [box.x + box.width + 15, box.y + box.height + 15], [box.x - 15, box.y + box.height + 15], [box.x - 15, box.y - 15]];
    const draw = async (modifier, cancel = false) => {
      await off(f); await f.page.keyboard.press('l'); if (modifier) await f.page.keyboard.down(modifier);
      await f.page.mouse.move(...points[0]); await f.page.mouse.down(); for (const point of points.slice(1)) await f.page.mouse.move(...point, { steps: 4 });
      if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up(); if (modifier) await f.page.keyboard.up(modifier);
    };
    await draw('Shift'); assert.deepEqual(await selectedIds(f), ['a', 'b']);
    await draw('Alt'); assert.deepEqual(await selectedIds(f), ['b']);
    await draw(null, true); assert.deepEqual(await selectedIds(f), ['b']);
    await draw(null); assert.deepEqual(await selectedIds(f), ['a']); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await f.page.keyboard.press('l'); assert.equal(await f.canvas.locator('[data-tool="lasso"]').count(), 0);
  } finally { await f.close(); }
});

test('Alt+box drag subtracts only enclosed items, with Escape restoring selection', async () => {
  const f = await editing();
  try {
    await f.canvas.locator('.react-flow').focus(); await f.page.keyboard.press('Control+a'); const box = await f.canvas.locator('.react-flow__node[data-id="b"]').boundingBox();
    const drag = async cancel => {
      await f.page.keyboard.down('Alt'); await f.page.mouse.move(box.x - 10, box.y - 10); await f.page.mouse.down();
      await f.page.mouse.move(box.x + box.width + 10, box.y + box.height + 10, { steps: 8 }); if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up(); await f.page.keyboard.up('Alt');
    };
    await drag(true); assert.deepEqual(await selectedIds(f), ['a', 'b', 'c', 'd']);
    await drag(false); assert.deepEqual(await selectedIds(f), ['a', 'c', 'd']);
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

test('Shift-drop inserts a disconnected agent on a highlighted wire atomically; plain drop and Escape preserve wiring', async () => {
  const f = await editing();
  try {
    const before = await f.saved();
    const drag = async (shift, cancel = false) => {
      const box = await f.canvas.locator('.react-flow__node[data-id="d"]').boundingBox(), at = await wirePoint(f, 'b->c');
      await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await f.page.mouse.down();
      await f.page.mouse.move(at.x, at.y, { steps: 10 }); if (shift) await f.page.keyboard.down('Shift'); if (cancel) await f.page.keyboard.press('Escape');
      await f.page.mouse.up(); if (shift) await f.page.keyboard.up('Shift');
    };
    await drag(false); assert.deepEqual((await f.saved()).edges, before.edges); await off(f); await f.page.keyboard.press('Control+z');
    await drag(true, true); assert.deepEqual(geometry(await f.saved()), geometry(before));
    await drag(true); const after = await f.saved(); assert.deepEqual(after.edges.map(e => e.id), ['a->b', 'b->d', 'd->c']); assert.equal(after.edges.find(e => e.id === 'd->c').label, 'Result');
    await off(f); await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
  } finally { await f.close(); }
});

test('Alt-drag extracts an agent and heals its single gap; Escape restores both positions and wires', async () => {
  const f = await editing();
  try {
    const before = await f.saved();
    const drag = async cancel => {
      const box = await f.canvas.locator('.react-flow__node[data-id="b"]').boundingBox(); await f.page.keyboard.down('Alt');
      await f.page.mouse.move(box.x + 60, box.y + 35); await f.page.mouse.down(); await f.page.mouse.move(box.x + 80, box.y + 180, { steps: 10 });
      if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up(); await f.page.keyboard.up('Alt');
    };
    await drag(true); assert.deepEqual(geometry(await f.saved()), geometry(before)); await drag(false);
    const after = await f.saved(); assert.deepEqual(after.edges, [{ id: 'a->c', source: 'a', target: 'c', label: 'Result' }]); assert.ok(after.nodes.some(n => n.id === 'b'));
    await off(f); await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
  } finally { await f.close(); }
});

test('selected wire endpoints reconnect only on valid drops, Escape and blank drops preserve the original; Delete removes that wire', async () => {
  const f = await editing();
  try {
    const before = await f.saved(), at = await wirePoint(f, 'a->b'); await f.page.mouse.click(at.x, at.y); await f.page.keyboard.press('Escape');
    const endpoint = f.canvas.locator('.react-flow__edge[data-id="a->b"] .react-flow__edgeupdater-target');
    await endpoint.waitFor();
    const drag = async (destination, cancel) => {
      const box = await endpoint.boundingBox(); await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await f.page.mouse.down();
      await f.page.mouse.move(destination.x, destination.y, { steps: 10 }); if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up();
    };
    const d = await f.canvas.locator('.react-flow__node[data-id="d"] .react-flow__handle.target').boundingBox(), to = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
    await drag(to, true); assert.deepEqual((await f.saved()).edges, before.edges);
    const pane = await f.canvas.locator('.react-flow__pane').boundingBox(); await drag({ x: pane.x + 20, y: pane.y + 40 }); assert.deepEqual((await f.saved()).edges, before.edges); await f.agentCount(4, 'reconnect to blank never creates');
    await drag(to); assert.ok((await f.saved()).edges.some(e => e.source === 'a' && e.target === 'd'));
    await off(f); await f.page.keyboard.press('Control+z'); assert.deepEqual((await f.saved()).edges, before.edges);
    const again = await wirePoint(f, 'a->b'); await f.page.mouse.click(again.x, again.y); await f.page.keyboard.press('Escape'); await f.page.keyboard.press('Delete'); assert.deepEqual((await f.saved()).edges.map(e => e.id), ['b->c']);
  } finally { await f.close(); }
});

test('dragging either port onto blank board still adds exactly one connected agent; Escape and Undo restore the drawing', async () => {
  const f = await editing();
  try {
    const before = await f.saved();
    const drop = async (end, cancel = false) => {
      const handle = await f.canvas.locator(`.react-flow__node[data-id="d"] .react-flow__handle.${end}`).boundingBox();
      const pane = await f.canvas.locator('.react-flow__pane').boundingBox();
      await f.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await f.page.mouse.down();
      await f.page.mouse.move(pane.x + pane.width - 260, pane.y + pane.height - 150, { steps: 12 }); if (cancel) await f.page.keyboard.press('Escape'); await f.page.mouse.up();
    };
    await drop('source', true); await f.agentCount(4, 'Escape cancels port drag'); assert.deepEqual((await f.saved()).edges, before.edges);
    for (const end of ['source', 'target']) {
      await drop(end); await f.agentCount(5, `${end} wire drop`); const graph = await f.saved(), made = graph.nodes.find(n => n.type === 'agent' && !before.nodes.some(old => old.id === n.id));
      assert.ok(made); assert.ok(graph.edges.some(e => end === 'source' ? e.source === 'd' && e.target === made.id : e.source === made.id && e.target === 'd'));
      assert.equal(graph.edges.length, before.edges.length + 1); await off(f); await f.page.keyboard.press('Control+z'); assert.deepEqual(geometry(await f.saved()), geometry(before));
    }
  } finally { await f.close(); }
});

test('all new keys stay inside menus, Info dialogs and the Add dialog', async () => {
  const f = await editing();
  try {
    const keys = ['Shift+a', 'Control+i', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Alt+ArrowRight', 'Shift+Alt+t', 'm', 'Control+g', 'Control+Shift+g', 'Shift+s', '+', '-', '0', '.', 'Control+Enter', 'Control+Shift+Enter', 'Control+f', 'Control+x', 'Alt+Shift+m'];
    for (const popup of ['menu', 'info', 'add']) {
      await pick(f, 'b'); if (popup === 'menu') await f.page.keyboard.press('Shift+F10'); else await f.page.keyboard.press(popup === 'info' ? 'Enter' : 'Tab');
      const owner = popup === 'menu' ? f.canvas.getByRole('menu') : popup === 'info' ? f.canvas.getByRole('dialog', { name: 'B info', exact: true }) : f.canvas.getByRole('textbox', { name: 'Command', exact: true });
      const before = geometry(await f.saved()), runCount = f.runs.length;
      for (const key of keys) { await owner.focus(); await f.page.keyboard.press(key); assert.equal(await owner.count(), 1, `${popup} still owns ${key}`); }
      assert.deepEqual(geometry(await f.saved()), before, `${popup} owns the keys`); assert.equal(f.runs.length, runCount, `${popup} starts no run`);
      await f.page.keyboard.press('Escape');
    }
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

test('Escape clears the selection made by Ctrl+A or a click; Escape in a field stays in the field', async () => {
  const { page, canvas, node, errors, close } = await openCanvas();
  try {
    const selected = () => canvas.locator('.react-flow__node.selected').count();
    await canvas.locator('.react-flow').focus();
    await page.keyboard.press('Control+a'); assert.ok(await selected() >= 4, 'Ctrl+A selects the agents');
    await page.keyboard.press('Escape'); assert.equal(await selected(), 0, 'Escape clears the selection');
    await node('Veyra · Part 2').click(); await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Escape'); assert.equal(await selected(), 0, 'Escape clears a clicked agent');
    await node('Veyra · Part 2').click();
    await canvas.getByRole('textbox', { name: 'Name', exact: true }).focus(); await page.keyboard.press('Escape');
    assert.equal(await selected(), 1, 'Escape in the Name field leaves the selection');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('without a project, Run explains why at the bottom and the toolbar keeps its position', async () => {
  const { page, canvas, close } = await openCanvas();
  try {
    await page.evaluate(() => localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [], selectedId: null })));
    await page.reload(); await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    const header = canvas.locator('.canvas-header'), height = (await header.boundingBox()).height;
    const run = canvas.getByRole('button', { name: 'Run graph', exact: true }), before = await run.boundingBox();
    await run.click();
    const reason = canvas.getByRole('alert').filter({ hasText: 'Choose the project the agents work in' }); await reason.waitFor();
    assert.equal((await header.boundingBox()).height, height, 'the toolbar did not grow');
    assert.deepEqual(await run.boundingBox(), before, 'Run did not move');
    const box = await reason.boundingBox(), workspace = await canvas.boundingBox();
    assert.ok(box.x >= workspace.x && box.x + box.width <= workspace.x + workspace.width + 1, 'the reason stays inside the workflow workspace');
    assert.ok(box.y >= before.y + before.height && Math.abs(box.y + box.height - workspace.y - workspace.height) <= 14, 'the reason sits at the bottom of the workflow workspace');
    assert.equal(await run.getAttribute('aria-describedby'), await reason.getAttribute('id'), 'Run describes its refusal after the message moves');
  } finally { await close(); }
});
