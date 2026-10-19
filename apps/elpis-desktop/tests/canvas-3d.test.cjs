const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const drag = async (page, a, b, button = 'left') => { await page.mouse.move(a.x, a.y); await page.mouse.down({ button }); await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up({ button }); };
const middle = async loc => { const r = await loc.boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

test('3D selection, dashboard, shared settings and delete/undo work together', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  try {
    await canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    const agent = canvas.locator('.iso-node[aria-label^="Quillon · Part 1:"]');
    await agent.click(); await canvas.locator('.iso-node[aria-label^="Veyra · Part 2:"]').click({ modifiers: ['Shift'] });
    assert.equal(await canvas.locator('.iso-node[aria-pressed="true"]').count(), 2);
    await agent.click(); await page.keyboard.press('Enter');
    const dashboard = canvas.getByRole('dialog', { name: 'Quillon · Part 1 info', exact: true }); await dashboard.waitFor();
    await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();
    const panel = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A shared prompt');
    await agent.click(); await page.keyboard.press('Delete');
    assert.equal(await canvas.locator('.iso-node[data-kind="agent"]').count(), 3);
    await page.keyboard.press('Control+z');
    assert.equal(await canvas.locator('.iso-node[data-kind="agent"]').count(), 4);
    assert.equal((await f.saved()).nodes.find(n => n.data.title === 'Quillon · Part 1').data.instruction, 'A shared prompt');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('3D ports connect and drop to create; changes persist on the flat board', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  try {
    await canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    await canvas.getByRole('button', { name: 'Output of Quillon · Part 1', exact: true }).click();
    await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal((await f.saved()).nodes.filter(n => n.type === 'agent').length, 4, 'clicking a dot keeps its existing command menu');
    await drag(page, await middle(canvas.getByRole('button', { name: 'Output of Quillon · Part 1', exact: true })), await middle(canvas.getByRole('button', { name: 'Input of Veyra · Part 2', exact: true })));
    let saved = await f.saved(), from = saved.nodes.find(n => n.data.title === 'Quillon · Part 1').id, to = saved.nodes.find(n => n.data.title === 'Veyra · Part 2').id;
    assert.ok(saved.edges.some(e => e.source === from && e.target === to));
    const board = await canvas.locator('.iso-board').boundingBox();
    await drag(page, await middle(canvas.getByRole('button', { name: 'Output of Veyra · Part 2', exact: true })), { x: board.x + board.width - 40, y: board.y + 40 });
    await canvas.getByRole('textbox', { name: 'Name', exact: true }).fill('Follow in 3D'); await page.keyboard.press('Enter');
    await page.keyboard.type('Follow in 3D');
    saved = await f.saved(); const added = saved.nodes.find(n => n.data.title === 'Follow in 3D').id;
    assert.ok(saved.edges.some(e => e.source === to && e.target === added));
    await canvas.getByRole('button', { name: 'Flat', exact: true }).click(); await f.agentCount(5, '3D edits appear in 2D');
    assert.equal(await f.wires.count(), 5);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('3D middle and scroll pan; Space opens patterns; Home fits; F frames', async () => {
  const f = await openCanvas({ width: 900, height: 700 }); const { page, canvas } = f;
  try {
    await canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    const board = canvas.locator('.iso-board'), world = board.locator('.iso-world'), r = await board.boundingBox(), start = { x: r.x + 20, y: r.y + 20 };
    const fitted = await world.getAttribute('transform');
    await drag(page, start, { x: start.x + 60, y: start.y + 40 }, 'middle');
    assert.notEqual(await world.getAttribute('transform'), fitted, 'middle pans');
    await board.focus(); await page.keyboard.press('Home'); assert.equal(await world.getAttribute('transform'), fitted);
    await page.mouse.move(start.x, start.y); await page.mouse.wheel(45, 30);
    await page.waitForTimeout(100); assert.notEqual(await world.getAttribute('transform'), fitted, 'scroll pans');
    await page.keyboard.press('Space');
    await canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true }).press('Escape');
    await board.focus(); await page.keyboard.press('Home');
    await canvas.locator('.iso-node[aria-label^="Quillon · Part 1:"]').click();
    await page.keyboard.press('f'); assert.notEqual(await world.getAttribute('transform'), fitted, 'F frames selected pedestal');
    await page.keyboard.press('Home'); await page.keyboard.press('Control+a');
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
      await fs.mkdir('/tmp/canvas-rebuild', { recursive: true }); await page.waitForTimeout(200); await page.screenshot({ path: `/tmp/canvas-rebuild/3d-${theme}.png` });
    }
  } finally { await f.close(); }
});

test('3D dense long labels stay inside the board without overlapping when all are selected', async () => {
  const graph = { name: 'Dense labels', maxAgents: 12, nodes: [{ id: 'mother', type: 'mother', position: { x: 0, y: 420 }, data: {} }, ...Array.from({ length: 12 }, (_, n) => ({ id: `answer-${n}`, type: 'agent', position: { x: 240, y: n * 120 }, data: { title: `A long independent answer number ${n + 1} with details`, instruction: 'Save the answer', model: null, writeScopes: ['src'], acceptanceCriteria: [] } }))], edges: [] };
  const f = await openCanvas({ width: 900, height: 700, graph });
  try {
    await f.canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    await f.canvas.locator('.iso-board').focus(); await f.page.keyboard.press('Control+a');
    const { assertUiFit } = require('./ui-fit.cjs');
    await assertUiFit(f.canvas.locator('.iso-board'), 'dense labels');
    await f.page.screenshot({ path: '/tmp/canvas-rebuild/3d-dense-light.png' });
    const area = await f.canvas.locator('.iso-board').boundingBox();
    for (const box of await f.canvas.locator('.iso-label').evaluateAll(list => list.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }))) assert.ok(box.left >= area.x - 1 && box.right <= area.x + area.width + 1 && box.top >= area.y - 1 && box.bottom <= area.y + area.height + 1, 'every label is inside the board');
  } finally { await f.close(); }
});

test('3D labels select and open the matching agent', async () => {
  const f = await openCanvas();
  try {
    await f.canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    const label = f.canvas.locator('.iso-label').filter({ hasText: 'Veyra · Part 2' });
    await label.click();
    assert.equal(await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Veyra · Part 2');
    await label.dblclick();
    await f.canvas.getByRole('textbox', { name: 'Rename agent', exact: true }).waitFor();
    await f.page.keyboard.press('Escape'); await label.click(); await f.page.keyboard.press('Enter');
    await f.canvas.getByRole('dialog', { name: 'Veyra · Part 2 info', exact: true }).waitFor();
  } finally { await f.close(); }
});
