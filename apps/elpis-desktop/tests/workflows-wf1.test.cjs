const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require(process.env.ELPIS_WF1_CDP ? './workflows-wf1-real.cjs' : './canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');

const shots = process.env.ELPIS_SHOTS || '/tmp/wf1-shots';
const agent = (id, x) => ({ id, type: 'agent', position: { x, y: 0 }, data: { title: id, instruction: `Write the ${id} report`, model: null, provider: null, effort: null, writeScopes: [], acceptanceCriteria: ['Report exists'] } });
const graph = { name: 'W3 A27 A30', nodes: ['First', 'Middle', 'Last'].map((id, i) => agent(id, i * 400)), edges: [{ id: 'first-middle', source: 'First', target: 'Middle' }, { id: 'middle-last', source: 'Middle', target: 'Last' }] };
const picked = (f, iso) => f.canvas.locator(iso ? '.iso-node[aria-pressed="true"]' : '.react-flow__node.selected').evaluateAll(items => items.map(n => n.dataset.id).sort());
async function drag(page, from, to, { shift = false, cancel = false, shot } = {}) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (shot) {
    const box = page.locator('.canvas-selection');
    assert.equal(await box.count(), 1, 'both views draw the shared selection rectangle');
    assert.equal(await box.evaluate(el => getComputedStyle(el).borderStyle), to.x < from.x ? 'dashed' : 'solid');
    await page.screenshot({ path: `${shots}/${shot}.png` });
  }
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}
async function theme(f, value) {
  if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (value === 'dark')) await chooseTheme(f.page, value);
}

for (const iso of [false, true]) for (const color of ['light', 'dark']) {
  const view = iso ? 'isometric' : 'flat';
  test(`W3 ${view} ${color}: window, crossing, Shift, Escape, empty board, middle pan and reload`, async () => {
    const f = await openCanvas({ graph, folders: [] });
    try {
      await fs.mkdir(shots, { recursive: true }); await theme(f, color);
      if (iso) await f.canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
      await f.fit();
      const initial = (await f.saved()).nodes.map(n => ({ id: n.id, position: n.position }));
      const box = await f.canvas.locator(iso ? '.iso-node[data-id="Middle"]' : '.react-flow__node[data-id="Middle"]').boundingBox();
      const left = { x: box.x - 8, y: box.y - 8 }, right = { x: box.x + box.width + 8, y: box.y + box.height + 8 };
      const partial = { x: box.x + box.width / 2, y: right.y };
      const world = f.canvas.locator(iso ? '.iso-world' : '.react-flow__viewport');
      const transform = () => world.getAttribute(iso ? 'transform' : 'style');
      const before = await transform();
      await drag(f.page, left, partial);
      await f.page.screenshot({ path: `${shots}/W3-${view}-${color}-partial.png` });
      assert.deepEqual(await picked(f, iso), [], 'left to right rejects a partly enclosed agent');
      assert.equal(await transform(), before, 'left drag selects without panning');
      await drag(f.page, partial, left, { shot: `W3-${view}-${color}-crossing` });
      assert.deepEqual(await picked(f, iso), ['Middle'], 'right to left selects a touched agent');
      await drag(f.page, left, right, { shot: `W3-${view}-${color}-window` });
      assert.deepEqual(await picked(f, iso), ['Middle'], 'left to right selects an enclosed agent');
      for (const id of ['First', 'Last']) {
        const b = await f.canvas.locator(iso ? `.iso-node[data-id="${id}"]` : `.react-flow__node[data-id="${id}"]`).boundingBox();
        await drag(f.page, { x: b.x + b.width + 8, y: b.y - 8 }, { x: b.x + b.width / 2, y: b.y + b.height + 8 }, { shift: true });
      }
      assert.deepEqual(await picked(f, iso), ['First', 'Last', 'Middle'], 'Shift adds first and last agents');
      await drag(f.page, left, right, { shift: true, cancel: true });
      assert.deepEqual(await picked(f, iso), ['First', 'Last', 'Middle'], 'Escape restores the selection from before the drag');
      assert.equal(await f.canvas.locator('.canvas-selection').count(), 0);
      const board = await f.canvas.locator(iso ? '.iso-board' : '.react-flow__pane').boundingBox();
      await f.page.mouse.click(board.x + 10, board.y + 10);
      assert.deepEqual(await picked(f, iso), [], 'empty board click clears selection');
      const panBefore = await transform();
      await f.page.mouse.move(board.x + 16, board.y + 16); await f.page.mouse.down({ button: 'middle' });
      await f.page.mouse.move(board.x + 85, board.y + 55, { steps: 8 }); await f.page.mouse.up({ button: 'middle' });
      assert.notEqual(await transform(), panBefore, 'middle drag pans in both views');
      const scrolledFrom = await transform(); await f.page.mouse.wheel(0, 45); await f.page.waitForTimeout(150);
      assert.notEqual(await transform(), scrolledFrom, 'scroll also pans in both views');
      assert.deepEqual((await f.saved()).nodes.map(n => ({ id: n.id, position: n.position })), initial);
      await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
      assert.deepEqual((await f.saved()).nodes.map(n => ({ id: n.id, position: n.position })), initial, 'selection and pan never change saved positions');
      // A board with no agents still accepts both window directions and cancellation.
      if (iso) await f.canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
      await f.canvas.locator(iso ? '.iso-node[data-id="Middle"]' : '.react-flow__node[data-id="Middle"]').click();
      await f.page.keyboard.press('Control+A');
      await f.page.waitForFunction(iso => document.querySelectorAll(iso ? '.iso-node[data-kind="agent"][aria-pressed="true"]' : '.react-flow__node-agent.selected').length === 3, iso);
      await f.page.keyboard.press('Delete');
      await f.page.waitForFunction(iso => document.querySelectorAll(iso ? '.iso-node[data-kind="agent"]' : '.react-flow__node-agent').length === 0, iso);
      assert.equal(await f.canvas.locator(iso ? '.iso-node[data-kind="agent"]' : '.react-flow__node-agent').count(), 0);
      await f.fit();
      const empty = await f.canvas.locator(iso ? '.iso-board' : '.react-flow__pane').boundingBox();
      const a = { x: empty.x + 12, y: empty.y + 12 }, b = { x: empty.x + 75, y: empty.y + 55 };
      await drag(f.page, a, b); assert.deepEqual(await picked(f, iso), []);
      await drag(f.page, b, a, { cancel: true }); assert.deepEqual(await picked(f, iso), []);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`A27 ${view} ${color}: every agent says Info, opens by button and Enter, closes outside, Escape and Close info`, async () => {
    const f = await openCanvas({ graph, folders: [] });
    try {
      await fs.mkdir(shots, { recursive: true }); await theme(f, color);
      if (iso) await f.canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
      for (const id of ['First', 'Middle', 'Last']) {
        await f.canvas.locator(iso ? `.iso-node[data-id="${id}"]` : `.react-flow__node[data-id="${id}"]`).click();
        const inspector = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
        if (id === 'First') await f.page.screenshot({ path: `${shots}/A27-${view}-${color}-inspector.png` });
        assert.equal(await inspector.getByRole('button', { name: /Dashboard/i }).count(), 0, 'no Dashboard label remains');
        const info = inspector.getByRole('button', { name: /^Info\b/ });
        await info.click();
        const dialog = f.canvas.getByRole('dialog', { name: `${id} info`, exact: true }); await dialog.waitFor();
        assert.equal(await info.getAttribute('aria-expanded'), 'true');
        await info.click(); await dialog.waitFor({ state: 'detached' });
        assert.equal(await info.getAttribute('aria-expanded'), 'false', 'the Info button also closes Info');
        await info.click(); await dialog.waitFor();
        await f.canvas.getByRole('textbox', { name: 'Graph name', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
        await info.click(); await dialog.waitFor(); await f.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
        await f.canvas.locator(iso ? `.iso-node[data-id="${id}"]` : `.react-flow__node[data-id="${id}"]`).click(); await f.page.keyboard.press('Enter');
        await dialog.waitFor();
        if (id === 'Middle') await f.page.screenshot({ path: `${shots}/A27-${view}-${color}-info.png` });
        await dialog.getByRole('button', { name: 'Close info', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

for (const color of ['light', 'dark']) test(`A30 ${color}: run rejection and failed agent explain the next action at the bottom; retry succeeds`, { skip: Boolean(process.env.ELPIS_WF1_CDP) && 'Mock responses are excluded from real-app acceptance; run workflows-wf1-real.cjs for a real refused write.' }, async () => {
  let failed = true;
  const f = await openCanvas({ graph, folders: [], listed(run) {
    return { id: run.graphId, status: failed ? 'failed' : 'succeeded', tasks: run.tasks.map((task, i) => ({ id: task.id, status: failed ? i === 0 ? 'failed' : 'blocked' : 'succeeded', assignedThreadId: null, failureReason: failed && i === 0 ? 'EACCES: permission denied, open agents/first/report.md' : null })) };
  } });
  try {
    await fs.mkdir(shots, { recursive: true }); await theme(f, color);
    const header = f.canvas.locator('.canvas-header'), run = header.getByRole('button', { name: 'Run graph', exact: true });
    let refusal = 'The agent could not start: provider unavailable.';
    await f.page.route('**/api/workflows/run', route => route.fulfill({ status: 403, json: { error: refusal } }));
    await run.click(); await f.canvas.getByRole('alert').waitFor();
    const problem = f.canvas.getByRole('alert');
    await f.page.screenshot({ path: `${shots}/A30-${color}-error.png` });
    assert.equal(await problem.count(), 1, 'the actionable reason stays in its workspace');
    assert.equal(await header.getByRole('alert').count(), 0, 'run failures leave the toolbar clear');
    assert.match(await problem.innerText(), /provider unavailable/); assert.match(await problem.innerText(), /try|run again/i);
    refusal = `EACCES: permission denied, mkdir '/tmp/demo/${'long-project-folder/'.repeat(12)}agents/first'`;
    await run.click();
    await problem.filter({ hasText: /permission denied/ }).waitFor();
    assert.match(await problem.innerText(), /permission|write/i); assert.match(await problem.innerText(), /choose|allow|grant|check|try/i, 'gives an action');
    assert.ok(await problem.getAttribute('id'), 'the actual reason has an accessible id');
    assert.equal(await run.getAttribute('aria-describedby'), await problem.getAttribute('id'), 'Run graph is linked to its actual reason');
    for (const width of [1130, 1440]) {
      await f.page.setViewportSize({ width, height: 900 });
      const fits = await header.evaluate(el => el.scrollWidth <= el.clientWidth && [...el.querySelectorAll('[role="alert"], button')].every(child => { const b = child.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }));
      assert.equal(fits, true, `run toolbar fits at ${width}`);
      const box = await problem.boundingBox(), workspace = await f.canvas.boundingBox();
      assert.ok(box.x >= workspace.x && box.x + box.width <= workspace.x + workspace.width + 1, `run error fits at ${width}`);
      assert.ok(Math.abs(box.y + box.height - workspace.y - workspace.height) <= 14, 'the complete refusal stays at the bottom');
      await f.page.screenshot({ path: `${shots}/A30-${color}-refused-${width}.png` });
    }
    await f.page.unroute('**/api/workflows/run');
    await run.click(); await problem.filter({ hasText: /First/ }).waitFor();
    assert.match(await problem.innerText(), /write|permission/i);
    failed = false; await run.click(); await header.getByRole('status').filter({ hasText: /Finished/ }).waitFor();
    assert.equal(await problem.count(), 0, 'a successful retry clears the stale error');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
