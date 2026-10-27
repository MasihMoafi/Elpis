const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const drag = async (page, a, b, button = 'left') => { await page.mouse.move(a.x, a.y); await page.mouse.down({ button }); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up({ button }); };

test('agent wires keep bezier target arrows; Mother has one shared trunk and arrowed branches', async () => {
  const f = await openCanvas();
  try {
    assert.equal(await f.canvas.locator('.canvas-chevron').count(), 0);
    for (const path of await f.canvas.locator('.react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path').all()) {
      assert.match(await path.getAttribute('d'), /C/); assert.ok(await path.getAttribute('marker-end'));
    }
    const trunk = f.canvas.locator('.canvas-mother-trunk .react-flow__edge-path');
    assert.equal(await trunk.count(), 1); assert.match(await trunk.getAttribute('d'), /H/); assert.equal(await trunk.getAttribute('marker-end'), null);
    const branches = f.canvas.locator('.react-flow__edge.canvas-edge-mother > .react-flow__edge-path');
    assert.equal(await branches.count(), 3);
    for (const path of await branches.all()) assert.ok(await path.getAttribute('marker-end'));
  } finally { await f.close(); }
});

test('modifier wheel zoom, middle/scroll pan, box select, delete, undo/redo, duplicate, frame, menus and wiring', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  try {
    await f.fit();
    const pane = canvas.locator('.react-flow__pane'), viewport = canvas.locator('.react-flow__viewport');
    const area = await pane.boundingBox(), origin = { x: area.x + 24, y: area.y + 24 };
    const transform = () => viewport.getAttribute('transform').then(value => value ?? viewport.getAttribute('style'));
    const pointerWorld = () => viewport.evaluate((el, p) => { const m = new DOMMatrix(getComputedStyle(el).transform), area = el.closest('.react-flow').getBoundingClientRect(); return { x: (p.x - area.left - m.e) / m.a, y: (p.y - area.top - m.f) / m.d }; }, origin);
    const anchor = await pointerWorld();
    const before = await transform(); await page.mouse.move(origin.x, origin.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control'); await page.waitForTimeout(400);
    assert.notEqual(await transform(), before, 'wheel zoom');
    const after = await pointerWorld(); assert.ok(Math.hypot(after.x - anchor.x, after.y - anchor.y) < 2, 'zoom stays at the pointer');
    let previous = await transform(); await drag(page, origin, { x: origin.x + 55, y: origin.y + 35 }, 'middle');
    assert.notEqual(await transform(), previous, 'middle drag pans');
    await page.mouse.click(origin.x, origin.y);
    previous = await transform(); await page.mouse.wheel(40, 70); await page.waitForTimeout(200);
    assert.notEqual(await transform(), previous, 'scroll pans');
    assert.equal(await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).count(), 0, 'Space does not open Add');
    await f.fit(); await f.node('Quillon · Part 1').click();
    await page.keyboard.press('Control+d'); await f.agentCount(5, 'duplicate'); await page.waitForTimeout(450);
    await page.keyboard.press('Delete'); await f.agentCount(4, 'delete'); await page.keyboard.press('Control+z'); await f.agentCount(5, 'undo');
    await page.keyboard.press('Control+Shift+z'); await f.agentCount(4, 'redo');
    await f.fit(); await f.node('Quillon · Part 1').click();
    previous = await transform(); await page.keyboard.press('f'); await page.waitForTimeout(400);
    assert.notEqual(await transform(), previous, 'F frames selection');
    assert.equal(await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).count(), 0);
    await page.keyboard.press('Home'); await page.waitForTimeout(350);
    await f.node('Quillon · Part 1').click({ button: 'right' }); await canvas.getByRole('menu', { name: 'Agent Quillon · Part 1', exact: true }).waitFor(); await page.keyboard.press('Escape');
    const edge = canvas.locator('.react-flow__edge:not(.canvas-edge-mother)').first(); await edge.locator('.react-flow__edge-interaction').click({ button: 'right' }); await canvas.getByRole('menu', { name: 'Wire', exact: true }).waitFor(); await page.keyboard.press('Escape');
    const currentArea = await pane.boundingBox();
    await page.mouse.click(currentArea.x + 24, currentArea.y + 24, { button: 'right' }); await canvas.getByRole('menu', { name: 'Board', exact: true }).waitFor(); await page.keyboard.press('Escape');
    await f.fit();
    const selectionArea = await pane.boundingBox();
    await drag(page, { x: selectionArea.x + 4, y: selectionArea.y + 4 }, { x: selectionArea.x + selectionArea.width - 4, y: selectionArea.y + selectionArea.height - 4 });
    await page.waitForTimeout(100);
    if (await canvas.locator('.react-flow__node-agent.selected').count() !== 4) await page.screenshot({ path: '/tmp/canvas-rebuild/selection-failure.png' });
    assert.equal(await canvas.locator('.react-flow__node-agent.selected').count(), 4, 'left drag box selects');
    assert.equal(f.posts.filter(post => post.path === '/api/trash/undo').length, 0, 'canvas undo never restores chats');
    await page.keyboard.press('Backspace'); await f.agentCount(0, 'Backspace removes selection'); await page.keyboard.press('Control+z'); await f.agentCount(4, 'undo deletion');
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
      await f.fit(); await fs.mkdir('/tmp/canvas-rebuild', { recursive: true }); await page.screenshot({ path: `/tmp/canvas-rebuild/controls-${theme}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('dragging handles connects; a dropped output creates and wires the new agent', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  const center = async locator => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  try {
    await f.fit();
    await f.wires.first().locator('.react-flow__edge-interaction').click({ button: 'right' });
    await canvas.getByRole('menuitem', { name: /^Remove wire/ }).click();
    await drag(page, await center(f.node('Quillon · Part 1').locator('.react-flow__handle.source')), await center(f.node('Nuvani · Join the parts').locator('.react-flow__handle.target')));
    assert.equal(await f.wires.count(), 3);
    const area = await canvas.locator('.react-flow__pane').boundingBox();
    await drag(page, await center(f.node('Veyra · Part 2').locator('.react-flow__handle.source')), { x: area.x + area.width - 50, y: area.y + 65 });
    await canvas.getByRole('textbox', { name: 'Name', exact: true }).fill('Follow the second answer'); await page.keyboard.press('Enter');
    await page.keyboard.type('Follow the second answer');
    await f.agentCount(5, 'drop creates a connected agent');
    const saved = await f.saved(), made = saved.nodes.find(n => n.data.title === 'Follow the second answer'), source = saved.nodes.find(n => n.data.title === 'Veyra · Part 2');
    assert.ok(saved.edges.some(e => e.source === source.id && e.target === made.id));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 27 Oct, a real run in a short window: the run clock, the run log and the toolbar took all the board's height, the
// board itself shrank to nothing and the toolbar covered the top of the error below. The board keeps room, and the
// toolbar never covers the error.
test('in a short window with a run log and an error, the board stays visible and nothing covers the error', async () => {
  const f = await openCanvas({ width: 1100, height: 750 });
  try {
    const { page, canvas } = f;
    // A finished run's log and a long check failure, as the real run produced (the log is rendered by a run; the notice by its failure).
    await page.evaluate(() => {
      const board = document.querySelector('.canvas-board'), toolbar = board.querySelector('.canvas-toolbar');
      const log = document.createElement('div'); log.className = 'canvas-log-panel'; log.innerHTML = '<ol class="canvas-log">' + '<li>event</li>'.repeat(6) + '</ol>'; board.insertBefore(log, toolbar);
      const notice = document.createElement('div'); notice.className = 'canvas-notice canvas-error-notice'; notice.setAttribute('role', 'alert');
      notice.innerHTML = '<div class="canvas-error-details">' + 'Check failed: the file is not at the workspace root. '.repeat(14) + '</div>';
      document.querySelector('.agents-canvas').append(notice);
    });
    const box = selector => canvas.locator(selector).first().boundingBox();
    const flow = await box('.react-flow'), toolbar = await box('.canvas-toolbar'), notice = await box('.canvas-error-notice');
    assert.ok(flow.height >= 100, `the board keeps room (${Math.round(flow.height)} px)`);
    assert.ok(toolbar.y + toolbar.height <= notice.y + 1, `the toolbar ends above the error (${Math.round(toolbar.y + toolbar.height)} > ${Math.round(notice.y)})`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
