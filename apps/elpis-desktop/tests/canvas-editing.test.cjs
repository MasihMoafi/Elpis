const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

const graph = { name: 'Editing', nodes: ['a', 'b', 'c'].map((id, i) => ({ id, type: 'agent', position: { x: i === 2 ? 480 : 240, y: i * 140 }, data: { title: ['Kivo', 'Orun', 'Vela'][i], instruction: 'Write the result', model: null, writeScopes: [['src'], ['docs'], ['tests']][i], acceptanceCriteria: [] } })), edges: [{ id: 'a->c', source: 'a', target: 'c' }, { id: 'b->c', source: 'b', target: 'c' }] };
async function mode(f, iso) { await f.canvas.getByRole('button', { name: iso ? 'Isometric' : 'Flat', exact: true }).click(); await f.fit(); }
async function wireClick(f, selector) {
  const p = await f.canvas.locator(selector).first().evaluate(el => { const p = el.getPointAtLength(el.getTotalLength() * .55); const q = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM()); return { x: q.x, y: q.y }; });
  await f.page.mouse.click(p.x, p.y);
}
async function captures(f, stage) {
  if (process.env.ELPIS_SHOTS) await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
  await mode(f, true);
  for (const width of [1280, 1440]) for (const theme of ['light', 'dark']) {
    await f.page.setViewportSize({ width, height: 900 });
    if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
    await f.fit(); await assertUiFit(f.canvas, `${stage} ${width} ${theme}`);
    const area = await f.canvas.locator('.iso-board').boundingBox();
    for (const box of await f.canvas.locator('.iso-flow-label').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }))) assert.ok(box.x >= area.x && box.y >= area.y && box.right <= area.x + area.width && box.bottom <= area.y + area.height, 'wire labels remain inside the board');
    assert.equal(await f.canvas.locator('.iso-board').evaluate(root => [...root.querySelectorAll('.iso-flow-label')].some(label => { const a = label.getBoundingClientRect(); return [...root.querySelectorAll('.iso-node, .iso-port')].some(node => { const b = node.getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }); })), false, 'wire labels avoid pedestals and connection dots');
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/${stage}-${width}-${theme}.png` });
  }
}

test('inline rename: Enter/blur save, Escape cancels, Mother is fixed, both views and inspector agree', async () => {
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

for (const iso of [true, false]) test(`delete with four-second toast, Undo button, Ctrl+Z and wires: ${iso ? '3D' : 'flat'}`, async () => {
  const f = await openCanvas({ graph });
  try {
    await mode(f, iso);
    const node = () => iso ? f.canvas.locator('.iso-label[data-for="a"]') : f.node('Kivo');
    for (const key of ['Delete', 'Backspace']) {
      await node().click(); await f.page.keyboard.press(key);
      const toast = f.canvas.getByRole('status').filter({ hasText: 'Deleted Kivo' }); await toast.waitFor();
      assert.ok(!(await f.saved()).nodes.some(n => n.id === 'a'));
      if (key === 'Delete') await toast.getByRole('button', { name: 'Undo', exact: true }).click();
      else { await f.page.waitForTimeout(3200); assert.equal(await toast.isVisible(), true); await f.page.waitForTimeout(1000); assert.equal(await toast.count(), 0); await f.page.keyboard.press('Control+z'); }
      await node().waitFor(); assert.equal((await f.saved()).edges.length, 2);
    }
    await captures(f, `delete-${iso ? 'iso' : 'flat'}`); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const iso of [true, false]) test(`wire noun labels persist and reach receiving briefs, shared Mother trunk: ${iso ? '3D' : 'flat'}`, async () => {
  const f = await openCanvas({ graph });
  try {
    await mode(f, iso);
    await wireClick(f, iso ? '.iso-link:not([data-mother]) .iso-wire' : '.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path');
    const field = f.canvas.getByRole('textbox', { name: 'Flow label', exact: true });
    await field.fill('cancelled flow'); await f.page.keyboard.press('Escape');
    assert.equal((await f.saved()).edges[0].label, undefined);
    await wireClick(f, iso ? '.iso-link:not([data-mother]) .iso-wire' : '.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path');
    await field.fill('three answers'); await f.page.keyboard.press('Enter');
    await wireClick(f, iso ? '.iso-mother-trunk .iso-wire' : '.canvas-mother-trunk .react-flow__edge-path');
    await field.fill('the instructions'); await f.page.keyboard.press('Enter');
    const saved = await f.saved(); assert.equal(saved.motherFlow, 'the instructions'); assert.equal(saved.edges[0].label, 'three answers');
    await f.page.reload(); await f.page.getByRole('button', { name: 'Canvas', exact: true }).click(); await mode(f, iso);
    assert.equal(await f.canvas.locator(iso ? '.iso-flow-label' : '.react-flow__edge-text').filter({ hasText: 'the instructions' }).count(), 1);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.page.waitForFunction(() => /Running|Finished/.test(document.querySelector('.canvas-header')?.textContent ?? ''));
    for (const id of ['a', 'b']) assert.match(f.runs[0].tasks.find(t => t.id === id).instruction, /Receives “the instructions” from Mother/);
    assert.match(f.runs[0].tasks.find(t => t.id === 'c').instruction, /Receives “three answers” from Kivo/);
    await captures(f, `wires-${iso ? 'iso' : 'flat'}`); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('starter and + names are distinctive and unique; eight additions never overlap; arrange toolbar/menu fit both views', async () => {
  const f = await openCanvas();
  try {
    await f.canvas.getByRole('button', { name: /^Voting/ }).click();
    assert.ok((await f.titles()).every(name => /^[A-Z][a-z]+ · /u.test(name)));
    await f.canvas.getByRole('button', { name: /Blank playground/ }).click();
    for (let i = 0; i < 8; i++) await f.canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    const titles = await f.titles(); assert.equal(new Set(titles).size, 8);
    for (const iso of [false, true]) {
      await mode(f, iso);
      await f.canvas.getByRole('button', { name: 'Arrange by run order', exact: true }).click(); await f.fit();
      const boxes = await f.canvas.locator(iso ? '.iso-node, .iso-label' : '.react-flow__node-agent').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id') || el.getAttribute('data-for'), x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `overlap ${a.id} ${b.id}`); }
      const board = await f.canvas.locator(iso ? '.iso-board' : '.react-flow').boundingBox(); await f.page.mouse.click(board.x + 8, board.y + 8, { button: 'right' });
      await f.canvas.getByRole('menuitem', { name: 'Arrange by run order', exact: true }).click();
    }
    await captures(f, 'placement'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
