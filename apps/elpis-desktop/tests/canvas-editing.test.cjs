const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme, openPatterns } = require('./controls.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

async function placementGeometry(f) {
  return f.canvas.evaluate(canvas => {
    const area = canvas.querySelector('.react-flow'), world = canvas.querySelector('.react-flow__viewport');
    const box = area.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(world).transform);
    return { board: { x: box.x, y: box.y, width: box.width, height: box.height }, camera: { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f }, nodes: JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')).nodes.map(({id, position}) => ({id, position})) };
  });
}

const graph = { name: 'Editing', nodes: ['a', 'b', 'c'].map((id, i) => ({ id, type: 'agent', position: { x: i === 2 ? 480 : 240, y: i * 140 }, data: { title: ['Kivo', 'Orun', 'Vela'][i], instruction: 'Write the result', model: null, writeScopes: [['src'], ['docs'], ['tests']][i], acceptanceCriteria: [] } })), edges: [{ id: 'a->c', source: 'a', target: 'c' }, { id: 'b->c', source: 'b', target: 'c' }] };
async function wireClick(f, selector) {
  const p = await f.canvas.locator(selector).first().evaluate(el => { const p = el.getPointAtLength(el.getTotalLength() * .55); const q = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM()); return { x: q.x, y: q.y }; });
  await f.page.mouse.click(p.x, p.y);
}
async function captures(f, stage) {
  if (process.env.ELPIS_SHOTS) await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
  await f.fit();
  for (const width of [1280, 1440]) for (const theme of ['light', 'dark']) {
    await f.page.setViewportSize({ width, height: 900 });
    if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
    await f.fit(); await assertUiFit(f.canvas, `${stage} ${width} ${theme}`);
    assert.equal(await f.canvas.locator('.react-flow').evaluate(root => [...root.querySelectorAll('.react-flow__edge-text')].some(label => { const a = label.getBoundingClientRect(); return [...root.querySelectorAll('.react-flow__node')].some(node => { const b = node.getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }); })), false, 'wire labels avoid agent cards');
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/${stage}-${width}-${theme}.png` });
  }
}

test('delete with four-second toast, Undo button, Ctrl+Z and wires', async () => {
  const f = await openCanvas({ graph: { ...graph, maxAgents: 3 } });
  try {
    await f.fit();
    const node = () => f.node('Kivo');
    for (const key of ['Delete', 'Backspace']) {
      await f.canvas.getByRole('button', { name: 'Add agent', exact: true }).click(); await f.canvas.getByRole('alert').waitFor();
      await node().click(); await f.page.keyboard.press(key);
      const toast = f.canvas.getByRole('status').filter({ hasText: 'Deleted Kivo' }); await toast.waitFor();
      assert.equal(await f.canvas.getByRole('alert').count(), 0, 'deletion replaces the old limit warning so Undo is exposed');
      assert.ok(!(await f.saved()).nodes.some(n => n.id === 'a'));
      if (key === 'Delete') await toast.getByRole('button', { name: 'Undo', exact: true }).click();
      else { await f.page.waitForTimeout(3200); assert.equal(await toast.isVisible(), true); await f.page.waitForTimeout(1000); assert.equal(await toast.count(), 0); await f.page.keyboard.press('Control+z'); }
      await node().waitFor(); assert.equal((await f.saved()).edges.length, 2);
    }
    await captures(f, 'delete-flat'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('wire noun labels persist and reach receiving briefs, shared Mother trunk', async () => {
  const f = await openCanvas({ graph });
  try {
    await f.fit();
    await wireClick(f, '.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path');
    const field = f.canvas.getByRole('textbox', { name: 'Flow label', exact: true });
    await field.fill('cancelled flow'); await f.page.keyboard.press('Escape');
    assert.equal((await f.saved()).edges[0].label, undefined);
    await wireClick(f, '.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path');
    await field.fill('three answers'); await f.page.keyboard.press('Enter');
    await wireClick(f, '.canvas-mother-trunk .react-flow__edge-path');
    await field.fill('the instructions'); await f.page.keyboard.press('Enter');
    const saved = await f.saved(); assert.equal(saved.motherFlow, 'the instructions'); assert.equal(saved.edges[0].label, 'three answers');
    await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await f.fit();
    assert.equal(await f.canvas.locator('.react-flow__edge-text').filter({ hasText: 'the instructions' }).count(), 1);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.page.waitForFunction(() => /Running|Finished/.test(document.querySelector('.canvas-header')?.textContent ?? ''));
    for (const id of ['a', 'b']) assert.match(f.runs[0].tasks.find(t => t.id === id).instruction, /Receives “the instructions” from Mother/);
    assert.match(f.runs[0].tasks.find(t => t.id === 'c').instruction, /Receives “three answers” from Kivo/);
    await captures(f, 'wires-flat'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('starter and + names are distinctive and unique; eight additions never overlap; arrange toolbar/menu fit', async () => {
  const f = await openCanvas();
  try {
    await openPatterns(f.canvas);
    await f.canvas.getByRole('button', { name: /^Voting/ }).click();
    assert.ok((await f.titles()).every(name => /^[A-Z][a-z]+ · /u.test(name)));
    await f.canvas.getByRole('button', { name: /Blank playground/ }).click();
    for (let i = 0; i < 8; i++) await f.canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    const titles = await f.titles(); assert.equal(new Set(titles).size, 8);
    await f.fit();
    await f.canvas.getByRole('button', { name: 'Arrange by run order', exact: true }).click();
    await f.fit();
    const boxes = await f.canvas.locator('.react-flow__node-agent').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j], apart = a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
      assert.ok(apart, `overlap ${a.id} ${b.id}${apart ? '' : ` ${JSON.stringify({ a, b, geometry: await placementGeometry(f) })}`}`);
    }
    const board = await f.canvas.locator('.react-flow').boundingBox(); await f.page.mouse.click(board.x + 8, board.y + 8, { button: 'right' });
    await f.canvas.getByRole('menuitem', { name: 'Arrange by run order', exact: true }).click();
    await captures(f, 'placement'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Direct creation and the Workflows page name.
{

const graph = { name: 'My workflow', nodes: [{ id: 'a', type: 'agent', position: { x: 260, y: 0 }, data: { title: 'Quillon', instruction: 'Write the result', model: null, writeScopes: ['src'], acceptanceCriteria: [] } }], edges: [] };
const board = f => f.canvas.locator('.react-flow');
const select = (f, id = 'a') => f.canvas.locator(`.react-flow__node[data-id="${id}"]`).click();
async function setup() {
  const f = await openCanvas({ graph, width: 1280 });
  await f.fit();
  return f;
}
async function empty(f) {
  const box = await board(f).boundingBox();
  return { x: box.x + box.width - 140, y: box.y + 120 };
}
async function worldPoint(f, at) {
  return f.canvas.locator('.react-flow__viewport').evaluate((el, p) => { const b = el.closest('.react-flow').getBoundingClientRect(), m = new DOMMatrix(getComputedStyle(el).transform); return { x: (p.x - b.left - m.e) / m.a, y: (p.y - b.top - m.f) / m.d }; }, at);
}
async function added(f, count, source, wanted) {
  await f.page.waitForFunction(n => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')).nodes.filter(node => node.type === 'agent').length === n, count);
  assert.equal(await f.canvas.getByRole('dialog', { name: 'Add agents', exact: true }).count(), 0, 'the gesture creates directly');
  const name = f.canvas.getByRole('textbox', { name: 'Name', exact: true });
  assert.equal(await name.evaluate(el => el === document.activeElement), true, 'new name takes the keys');
  const saved = await f.saved(), made = saved.nodes.filter(node => node.type === 'agent').at(-1);
  assert.equal(await name.inputValue(), made.data.title);
  if (wanted) {
    const at = { x: made.position.x + 105, y: made.position.y + 48 };
    const retained = Math.abs(at.x - wanted.x) < 15 && Math.abs(at.y - wanted.y) < 15;
    assert.ok(retained, `free-space creation preserves the pointer position with auto-arrange on${retained ? '' : ` ${JSON.stringify({ wanted, actual: at, made, geometry: await placementGeometry(f) })}`}`);
  }
  if (source) assert.ok(saved.edges.some(edge => edge.source === source && edge.target === made.id), 'already wired');
  else assert.equal(saved.edges.length, 0, 'empty-board add has no explicit dependency');
  const boxes = await f.canvas.locator('.react-flow__node').evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `overlap ${i}/${j}`);
  }
  await f.page.keyboard.type(`Agent ${count}`);
  await f.page.keyboard.press('Enter');
  const prompt = f.canvas.getByRole('textbox', { name: 'Prompt', exact: true });
  assert.equal(await prompt.evaluate(el => el === document.activeElement), true, 'Enter advances to the task');
  await f.page.keyboard.type('A task with a letter A');
  assert.equal((await f.saved()).nodes.filter(node => node.type === 'agent').length, count, 'typing A in a field never adds');
  assert.deepEqual(f.errors, []);
  return made;
}

test('Workflows double-click empty board adds at the pointer with no dialog', async () => {
  const f = await setup();
  try {
    const at = await empty(f), wanted = await worldPoint(f, at);
    await f.page.mouse.dblclick(at.x, at.y);
    const made = await added(f, 2, undefined, wanted);
    const saved = await f.saved();
    await f.page.reload();
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const reloaded = (await f.saved()).nodes.find(node => node.id === made.id), previous = saved.nodes.find(node => node.id === made.id);
    assert.deepEqual(reloaded.position, previous.position);
  } finally { await f.close(); }
});
test('Workflows output dragged to empty space adds there already wired', async () => {
  const f = await setup();
  try {
    const dot = f.canvas.locator('.react-flow__node[data-id="a"] .react-flow__handle.source');
    const box = await dot.boundingBox(), at = await empty(f), wanted = await worldPoint(f, at);
    await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await f.page.mouse.down(); await f.page.mouse.move(at.x, at.y, { steps: 12 }); await f.page.mouse.up();
    await added(f, 2, 'a', wanted);
  } finally { await f.close(); }
});
test('Workflows A adds beside selection already wired, including a folded inspector', async () => {
  const f = await setup();
  try {
    await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    await select(f); await f.page.keyboard.press('a');
    const first = await added(f, 2, 'a');
    await select(f, first.id); await f.page.keyboard.press('a');
    await added(f, 3, first.id);
    for (const theme of ['light', 'dark']) {
      if ((await f.page.locator('html').evaluate(el => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await f.fit(); await assertUiFit(f.canvas, `Workflows ${theme}`);
      if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflows-2d-${theme}.png` }); }
    }
  } finally { await f.close(); }
});

test('Workflows names the sidebar, heading, command menu, window and guide; saved boards remain accessible', async () => {
  const f = await openCanvas({ graph });
  try {
    assert.equal(await f.page.getByRole('button', { name: 'Workflows', exact: true }).count(), 1);
    assert.equal(await f.page.getByRole('heading', { name: 'Workflows', exact: true }).count(), 1);
    assert.match(await f.page.title(), /Workflows/);
    await f.page.keyboard.press('Control+k');
    await f.page.keyboard.type('Workflows');
    await f.page.getByRole('option', { name: 'Workflows', exact: true }).click();
    assert.equal((await f.saved()).name, 'My workflow');
    await f.canvas.getByRole('button', { name: 'Guide to managing agents', exact: true }).click();
    await f.page.getByRole('button', { name: 'Back to Workflows', exact: true }).click();
    await f.canvas.waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Canvas', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
}
