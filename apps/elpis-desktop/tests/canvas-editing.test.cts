import type { Locator, Page } from 'playwright-core';
import type { CanvasGraph, CanvasNode } from '../lib/canvas.ts';
import type { CanvasFixture, CanvasOptions } from './canvas-fixture.cts';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const { openCanvas }: { openCanvas(options: CanvasOptions): Promise<CanvasFixture> } = require('./canvas-fixture.cts');
const { chooseTheme }: { chooseTheme(page: Page, theme: string): Promise<void> } = require('./controls.cts');
const { assertUiFit }: { assertUiFit(locator: Locator, label: string): Promise<void> } = require('./ui-fit.cts');

async function placementGeometry(f: CanvasFixture, iso: boolean) {
  return f.canvas.evaluate((canvas, iso) => {
    const area = canvas.querySelector(iso ? '.iso-board' : '.react-flow'), world = canvas.querySelector(iso ? '.iso-world' : '.react-flow__viewport');
    if (!area || !world) throw Error('Canvas geometry missing');
    const box = area.getBoundingClientRect(), matrix = iso ? (world as SVGGraphicsElement).getScreenCTM() : new DOMMatrix(getComputedStyle(world).transform);
    const saved = localStorage.getItem('elpis-workflow-draft-v1'); if (!matrix || !saved) throw Error('Canvas geometry unavailable');
    return { board: { x: box.x, y: box.y, width: box.width, height: box.height }, camera: { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f }, targetTransform: world.getAttribute('transform'), nodes: (JSON.parse(saved) as CanvasGraph).nodes.map(({id, position, isoPosition}) => ({id, position, isoPosition})) };
  }, iso);
}

const graph: CanvasGraph = { name: 'Editing', nodes: ['a', 'b', 'c'].map((id, i) => ({ id, type: 'agent', position: { x: i === 2 ? 480 : 240, y: i * 140 }, data: { title: ['Kivo', 'Orun', 'Vela'][i] as string, instruction: 'Write the result', model: null, writeScopes: [['src'], ['docs'], ['tests']][i] as string[], acceptanceCriteria: [] } })), edges: [{ id: 'a->c', source: 'a', target: 'c' }, { id: 'b->c', source: 'b', target: 'c' }] };
async function mode(f: CanvasFixture, iso: boolean) { await f.canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click(); await f.fit(); }
async function wireClick(f: CanvasFixture, selector: string) {
  const p = await f.canvas.locator(selector).first().evaluate(el => { const wire = el as SVGGeometryElement, p = wire.getPointAtLength(wire.getTotalLength() * .55), matrix = wire.getScreenCTM(); if (!matrix) throw Error('Wire geometry missing'); const q = new DOMPoint(p.x, p.y).matrixTransform(matrix); return { x: q.x, y: q.y }; });
  await f.page.mouse.click(p.x, p.y);
}
async function captures(f: CanvasFixture, stage: string, iso = true) {
  if (process.env.ELPIS_SHOTS) await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
  await mode(f, iso);
  for (const width of [1280]) for (const theme of ['light']) {
    await f.page.setViewportSize({ width, height: 900 });
    if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
    await f.fit(); await assertUiFit(f.canvas, `${stage} ${width} ${theme}`);
    const area = await f.canvas.locator(iso ? '.iso-board' : '.react-flow').boundingBox(); assert.ok(area);
    for (const box of await f.canvas.locator('.iso-flow-label').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }))) assert.ok(box.x >= area.x && box.y >= area.y && box.right <= area.x + area.width && box.bottom <= area.y + area.height, 'wire labels remain inside the board');
    if (iso) assert.equal(await f.canvas.locator('.iso-board').evaluate(root => [...root.querySelectorAll('.iso-flow-label')].some(label => { const a = label.getBoundingClientRect(); return [...root.querySelectorAll('.iso-node, .iso-port')].some(node => { const b = node.getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }); })), false, 'wire labels avoid pedestals and connection dots');
    else assert.equal(await f.canvas.locator('.react-flow').evaluate(root => [...root.querySelectorAll('.react-flow__edge-text')].some(label => { const a = label.getBoundingClientRect(); return [...root.querySelectorAll('.react-flow__node')].some(node => { const b = node.getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }); })), false, 'wire labels avoid agent cards');
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/${stage}-${width}-${theme}.png` });
  }
}

test('inline rename: Enter/blur save, Escape cancels, Mother agent is fixed, both views and inspector agree', async () => {
  const f = await openCanvas({ graph });
  try {
    await mode(f, true);
    await f.canvas.locator('.iso-label[data-for="a"]').dblclick();
    const field = f.canvas.getByRole('textbox', { name: 'Rename agent', exact: true });
    await field.fill('Quillon'); await f.page.keyboard.press('Enter');
    assert.equal(await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Quillon');
    await f.canvas.locator('.iso-node[data-id="a"]').dblclick(); await field.fill('Cancelled'); await f.page.keyboard.press('Escape');
    assert.match(await f.canvas.locator('.iso-label[data-for="a"]').innerText(), /Quillon/);
    await f.canvas.locator('.iso-label[data-for="a"]').dblclick(); await field.fill('Quillon prime'); await f.canvas.locator('.iso-label[data-for="b"]').click();
    assert.match(await f.canvas.locator('.iso-label[data-for="a"]').innerText(), /Quillon prime/);
    await f.canvas.locator('.iso-label[data-for="mother"]').dblclick(); assert.equal(await field.count(), 0);
    await mode(f, false); assert.equal(await f.node('Quillon prime').count(), 1);
    await captures(f, 'rename'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const iso of [true, false]) test(`wire noun labels persist and reach receiving briefs, shared Mother agent trunk: ${iso ? '3D' : 'flat'}`, async () => {
  const f = await openCanvas({ graph });
  try {
    await mode(f, iso);
    await wireClick(f, iso ? '.iso-link:not([data-mother]) .iso-wire' : '.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path');
    const field = f.canvas.getByRole('textbox', { name: 'Flow label', exact: true });
    await field.fill('cancelled flow'); await f.page.keyboard.press('Escape');
    const cancelled = (await f.saved()).edges[0]; assert.ok(cancelled); assert.equal(cancelled.label, undefined);
    await wireClick(f, iso ? '.iso-link:not([data-mother]) .iso-wire' : '.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path');
    await field.fill('three answers'); await f.page.keyboard.press('Enter');
    await wireClick(f, iso ? '.iso-mother-trunk .iso-wire' : '.canvas-mother-trunk .react-flow__edge-path');
    await field.fill('the instructions'); await f.page.keyboard.press('Enter');
    const saved = await f.saved(); assert.ok(saved.edges[0]); assert.equal(saved.motherFlow, 'the instructions'); assert.equal(saved.edges[0].label, 'three answers');
    await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await mode(f, iso);
    assert.equal(await f.canvas.locator(iso ? '.iso-flow-label' : '.react-flow__edge-text').filter({ hasText: 'the instructions' }).count(), 1);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.page.waitForFunction(() => /Running|Finished/.test(document.querySelector('.canvas-header')?.textContent ?? ''));
    const run = f.runs[0]; assert.ok(run);
    for (const id of ['a', 'b']) { const task = run.tasks.find(t => t.id === id); assert.ok(task); assert.match(task.instruction, /Receives “the instructions” from Mother agent/); }
    const task = run.tasks.find(t => t.id === 'c'); assert.ok(task); assert.match(task.instruction, /Receives “three answers” from Kivo/);
    if (!iso) await captures(f, 'wires-flat-view', false);
    await captures(f, `wires-${iso ? 'iso' : 'flat'}`); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Direct creation and the Workflows page name.
{

const graph: CanvasGraph = { name: 'My workflow', nodes: [{ id: 'a', type: 'agent', position: { x: 260, y: 0 }, data: { title: 'Quillon', instruction: 'Write the result', model: null, writeScopes: ['src'], acceptanceCriteria: [] } }], edges: [] };
const board = (f: CanvasFixture, iso: boolean) => f.canvas.locator(iso ? '.iso-board' : '.react-flow');
const select = (f: CanvasFixture, iso: boolean, id = 'a') => f.canvas.locator(iso ? `.iso-label[data-for="${id}"]` : `.react-flow__node[data-id="${id}"]`).click();
async function setup(iso: boolean) {
  const f = await openCanvas({ graph, width: 1280 });
  await f.canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
  await f.fit();
  return f;
}
async function empty(f: CanvasFixture, iso: boolean) {
  const box = await board(f, iso).boundingBox(); assert.ok(box);
  return { x: box.x + box.width - 140, y: box.y + 120 };
}
async function worldPoint(f: CanvasFixture, iso: boolean, at: { x: number; y: number }) {
  if (iso) return f.canvas.locator('.iso-world').evaluate((el, p) => { const matrix = (el as SVGGraphicsElement).getScreenCTM(); if (!matrix) throw Error('World geometry missing'); const q = new DOMPoint(p.x, p.y).matrixTransform(matrix.inverse()); return { x: q.x, y: q.y }; }, at);
  return f.canvas.locator('.react-flow__viewport').evaluate((el, p) => { const board = el.closest('.react-flow'); if (!board) throw Error('Board missing'); const b = board.getBoundingClientRect(), m = new DOMMatrix(getComputedStyle(el).transform); return { x: (p.x - b.left - m.e) / m.a, y: (p.y - b.top - m.f) / m.d }; }, at);
}
async function added(f: CanvasFixture, iso: boolean, count: number, source?: string, wanted?: { x: number; y: number }) {
  await f.page.waitForFunction(n => { const saved = localStorage.getItem('elpis-workflow-draft-v1'); return saved && (JSON.parse(saved) as CanvasGraph).nodes.filter((node: CanvasNode) => node.type === 'agent').length === n; }, count);
  assert.equal(await f.canvas.getByRole('dialog', { name: 'Add agents', exact: true }).count(), 0, 'the gesture creates directly');
  const name = f.canvas.getByRole('textbox', { name: 'Name', exact: true });
  assert.equal(await name.evaluate(el => el === document.activeElement), true, 'new name takes the keys');
  const saved = await f.saved(), made = saved.nodes.filter(node => node.type === 'agent').at(-1); assert.ok(made);
  assert.equal(await name.inputValue(), made.data.title);
  if (wanted) {
    const at = iso ? made.isoPosition : { x: made.position.x + 105, y: made.position.y + 48 }; assert.ok(at);
    const retained = Math.abs(at.x - wanted.x) < 15 && Math.abs(at.y - wanted.y) < 15;
    assert.ok(retained, `free-space creation preserves the pointer position with auto-arrange on${retained ? '' : ` ${JSON.stringify({ wanted, actual: at, made, geometry: await placementGeometry(f, iso) })}`}`);
  }
  if (source) assert.ok(saved.edges.some(edge => edge.source === source && edge.target === made.id), 'already wired');
  else assert.equal(saved.edges.length, 0, 'empty-board add has no explicit dependency');
  const boxes = await f.canvas.locator(iso ? '.iso-node, .iso-label' : '.react-flow__node').evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; assert.ok(a && b);
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

for (const iso of [false, true]) {
  test(`Workflows double-click empty board adds at the pointer with no dialog: ${iso ? '3D' : '2D'}`, async () => {
    const f = await setup(iso);
    try {
      const at = await empty(f, iso), wanted = await worldPoint(f, iso, at);
      await f.page.mouse.dblclick(at.x, at.y);
      const made = await added(f, iso, 2, undefined, wanted);
      const saved = await f.saved();
      await f.page.reload();
      await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
      const reloaded = (await f.saved()).nodes.find(node => node.id === made.id), previous = saved.nodes.find(node => node.id === made.id); assert.ok(reloaded && previous);
      assert.deepEqual(reloaded.position, previous.position); assert.deepEqual(reloaded.isoPosition, previous.isoPosition);
    } finally { await f.close(); }
  });
  test(`Workflows output dragged to empty space adds there already wired: ${iso ? '3D' : '2D'}`, async () => {
    const f = await setup(iso);
    try {
      const dot = f.canvas.locator(iso ? '.iso-port[data-node="a"][data-end="source"]' : '.react-flow__node[data-id="a"] .react-flow__handle.source');
      const box = await dot.boundingBox(), at = await empty(f, iso), wanted = await worldPoint(f, iso, at); assert.ok(box);
      await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await f.page.mouse.down(); await f.page.mouse.move(at.x, at.y, { steps: 12 }); await f.page.mouse.up();
      await added(f, iso, 2, 'a', wanted);
    } finally { await f.close(); }
  });
  test(`Workflows A adds beside selection already wired, including a folded inspector: ${iso ? '3D' : '2D'}`, async () => {
    const f = await setup(iso);
    try {
      await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
      await select(f, iso); await f.page.keyboard.press('a');
      const first = await added(f, iso, 2, 'a');
      await select(f, iso, first.id); await f.page.keyboard.press('a');
      await added(f, iso, 3, first.id);
      for (const theme of ['light']) {
        if ((await f.page.locator('html').evaluate(el => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
        await f.fit(); await assertUiFit(f.canvas, `Workflows ${iso ? '3D' : '2D'} ${theme}`);
        if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflows-${iso ? '3d' : '2d'}-${theme}.png` }); }
      }
    } finally { await f.close(); }
  });
}

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
