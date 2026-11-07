const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const drag = async (page: Awaited<ReturnType<typeof openCanvas>>['page'], a: { x: number; y: number }, b: { x: number; y: number }, button = 'left') => { await page.mouse.move(a.x, a.y); await page.mouse.down({ button }); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up({ button }); };

test('dragging handles connects; a dropped output creates and wires the new agent', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  const center = async (locator: { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }) => { const b = await locator.boundingBox(); if (!b) throw new Error('handle is not visible'); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  try {
    await f.fit();
    await f.wires.first().locator('.react-flow__edge-interaction').click({ button: 'right' });
    await canvas.getByRole('menuitem', { name: /^Remove wire/ }).click();
    await drag(page, await center(f.node('Quillon · Part 1').locator('.react-flow__handle.source')), await center(f.node('Nuvani · Join the parts').locator('.react-flow__handle.target')));
    assert.equal(await f.wires.count(), 3);
    const area = await canvas.locator('.react-flow__pane').boundingBox(); assert.ok(area);
    await drag(page, await center(f.node('Veyra · Part 2').locator('.react-flow__handle.source')), { x: area.x + area.width - 50, y: area.y + 65 });
    await canvas.getByRole('textbox', { name: 'Name', exact: true }).fill('Follow the second answer'); await page.keyboard.press('Enter');
    await page.keyboard.type('Follow the second answer');
    await f.agentCount(5, 'drop creates a connected agent');
    const saved = await f.saved(), made = saved.nodes.find((n: { data: { title: string }; id: string }) => n.data.title === 'Follow the second answer'), source = saved.nodes.find((n: { data: { title: string }; id: string }) => n.data.title === 'Veyra · Part 2');
    assert.ok(saved.edges.some((e: { source: string; target: string }) => e.source === source.id && e.target === made.id));
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
      const board = document.querySelector('.canvas-board'); if (!board) throw new Error('board missing'); const toolbar = board.querySelector('.canvas-toolbar');
      const log = document.createElement('div'); log.className = 'canvas-log-panel'; log.innerHTML = '<ol class="canvas-log">' + '<li>event</li>'.repeat(6) + '</ol>'; board.insertBefore(log, toolbar);
      const notice = document.createElement('div'); notice.className = 'canvas-notice canvas-error-notice'; notice.setAttribute('role', 'alert');
      notice.innerHTML = '<div class="canvas-error-details">' + 'Check failed: the file is not at the workspace root. '.repeat(14) + '</div>';
      const surface = document.querySelector('.agents-canvas'); if (!surface) throw new Error('canvas missing'); surface.append(notice);
    });
    const box = (selector: string) => canvas.locator(selector).first().boundingBox();
    const flow = await box('.react-flow'), toolbar = await box('.canvas-toolbar'), notice = await box('.canvas-error-notice');
    assert.ok(flow.height >= 100, `the board keeps room (${Math.round(flow.height)} px)`);
    assert.ok(toolbar.y + toolbar.height <= notice.y + 1, `the toolbar ends above the error (${Math.round(toolbar.y + toolbar.height)} > ${Math.round(notice.y)})`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
