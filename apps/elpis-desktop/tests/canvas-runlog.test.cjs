const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { chooseTheme } = require('./controls.cjs');

async function staged(options = {}) {
  let phase = 0;
  const f = await openCanvas({ ...options, listed(run) {
    return { id: run.graphId, status: phase === 4 ? 'succeeded' : 'running', tasks: run.tasks.map(task => {
      const tally = task.title.includes('Tally'), check = task.kind === 'verify';
      const step = (tally ? 2 : 0) + (check ? 1 : 0);
      const status = phase > step ? 'succeeded' : phase === step ? 'running' : 'pending';
      return { id: task.id, status, assignedThreadId: `agent-${task.id}`, result: status === 'succeeded' && !check ? { summary: `${task.title} captured` } : null };
    }) };
  } });
  return { ...f, advance: value => { phase = value; } };
}

test('the complete chronological log retains starts, tasks, checks and actual reports; click and Enter open its agent', async () => {
  const f = await staged(); const { canvas, page } = f;
  try {
    await canvas.getByText('More patterns', { exact: true }).click();
    await canvas.getByRole('button', { name: /^Voting/ }).click();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const log = canvas.getByRole('log', { name: 'Run log', exact: true });
    await log.getByRole('button', { name: /AGENT STARTED.*Quillon · Answer 1/ }).waitFor();
    assert.equal(await log.getByRole('button', { name: /REPORT RECEIVED/ }).count(), 0);
    for (let phase = 1; phase <= 4; phase++) {
      f.advance(phase);
      await log.getByRole('button', { name: phase === 1 ? /CHECK STARTED.*Quillon · Answer 1/ : phase === 2 ? /AGENT STARTED.*Tally/ : phase === 3 ? /CHECK STARTED.*Tally/ : /CHECK PASSED.*Tally/ }).waitFor();
    }
    const texts = await log.locator('li').allTextContents();
    assert.equal(texts.length, 20, 'all observed events survive, with no polling duplicates');
    assert.equal(texts.filter(text => /DATASTORE CAPTURED/.test(text)).length, 4);
    assert.ok(texts.findIndex(text => /AGENT STARTED.*Tally/.test(text)) > texts.findIndex(text => /CHECK PASSED.*Orilo · Answer 3/.test(text)));
    const times = await log.locator('time').allTextContents(); assert.deepEqual(times, [...times].sort());
    await log.getByRole('button', { name: /AGENT STARTED.*Quillon · Answer 1/ }).click();
    const dashboard = canvas.getByRole('dialog', { name: 'Quillon · Answer 1 info' }); await dashboard.waitFor();
    await dashboard.getByRole('button', { name: 'Close info' }).click();
    await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    await log.getByRole('button', { name: /CHECK PASSED.*Tally/ }).focus(); await page.keyboard.press('Enter');
    await canvas.getByRole('dialog', { name: 'Nuvani · Tally the answers info' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the timer advances in either view and stops on completion, including a new run', async () => {
  const f = await staged(); const { canvas, page } = f;
  try {
    await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const clock = canvas.getByRole('region', { name: 'Run clock', exact: true });
    await clock.waitFor(); const first = await clock.locator('strong').innerText();
    await page.waitForFunction(value => document.querySelector('[aria-label="Run clock"] strong')?.textContent !== value, first);
    assert.ok(await clock.locator('strong').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 32);
    await canvas.getByRole('radio', { name: 'Flat', exact: true }).click(); await clock.waitFor();
    f.advance(4); await canvas.locator('.canvas-header').getByRole('status').filter({ hasText: 'Finished' }).waitFor();
    const ended = await clock.locator('strong').innerText(); await page.waitForTimeout(2100);
    assert.equal(await clock.locator('strong').innerText(), ended);
    await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click(); assert.equal(await clock.locator('strong').innerText(), ended);
    f.advance(0); await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(value => document.querySelector('[aria-label="Run clock"] strong')?.textContent !== value, ended);
    assert.equal(await clock.locator('strong').innerText(), '00:00');
    assert.equal(await canvas.getByRole('log', { name: 'Run log' }).getByRole('button', { name: /REPORT RECEIVED/ }).count(), 0);
  } finally { await f.close(); }
});

test('Kahn waves stay visible with the sidebar closed; waiting inputs clear only after checks pass in either view', async () => {
  const f = await staged(); const { canvas } = f;
  try {
    await canvas.getByText('More patterns', { exact: true }).click();
    await canvas.getByRole('button', { name: /^Voting/ }).click();
    await canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    const order = canvas.getByRole('region', { name: 'Run order', exact: true }); await order.waitFor();
    assert.match(await order.innerText(), /Kahn/i);
    assert.equal(await order.locator('li').count(), 2);
    for (const iso of [false, true]) {
      await canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click(); await f.fit();
      if (iso) await canvas.locator('.iso-label').filter({ hasText: 'Nuvani · Tally the answers' }).click(); else await f.node('Nuvani · Tally the answers').click();
      assert.match(await canvas.getByLabel('Inputs needed', { exact: true }).innerText(), /Quillon · Answer 1.*Veyra · Answer 2.*Orilo · Answer 3/);
    }
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await order.locator('li[data-status="running"]').first().waitFor();
    assert.match(await order.locator('li[data-status="running"]').innerText(), /Wave 1/i);
    // Filling the template's missing prompts replaces the selection when the run starts.
    await f.fit(); await canvas.locator('.iso-label').filter({ hasText: 'Nuvani · Tally the answers' }).click();
    f.advance(1); await canvas.getByRole('log').getByRole('button', { name: /CHECK STARTED.*Quillon · Answer 1/ }).waitFor();
    assert.match(await canvas.getByLabel('Inputs needed', { exact: true }).innerText(), /Quillon · Answer 1.*check/);
    f.advance(2); await order.locator('li[data-status="running"]').filter({ hasText: /Wave 2/i }).waitFor();
    assert.match(await canvas.getByLabel('Inputs needed', { exact: true }).innerText(), /All inputs captured/);
    await canvas.getByRole('radio', { name: 'Flat', exact: true }).click();
    assert.match(await canvas.getByLabel('Inputs needed', { exact: true }).innerText(), /All inputs captured/);
  } finally { await f.close(); }
});

test('failed checks stay in the log, explain blocked inputs, and stop the clock without inventing reports', async () => {
  const f = await openCanvas({ listed(run) { return { id: run.graphId, status: 'failed', tasks: run.tasks.map((task, index) => ({ id: task.id, status: index === 1 ? 'failed' : index === 0 ? 'succeeded' : 'blocked', assignedThreadId: null, result: null })) }; } });
  try {
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const log = f.canvas.getByRole('log', { name: 'Run log' }); await log.getByRole('button', { name: /CHECK FAILED/ }).first().waitFor();
    assert.equal(await log.getByRole('button', { name: /REPORT RECEIVED/ }).count(), 0);
    await log.getByRole('button', { name: /CHECK FAILED/ }).first().click();
    const dashboard = f.canvas.getByRole('dialog', { name: / info$/ }); await dashboard.waitFor();
    await dashboard.getByRole('button', { name: 'Close info' }).click();
    await log.getByRole('button', { name: /INPUT BLOCKED.*Nuvani · Join the parts/ }).first().click();
    assert.match(await f.canvas.getByLabel('Inputs needed', { exact: true }).innerText(), /Quillon · Part 1 \(Check failed\)/);
    const clock = f.canvas.getByRole('region', { name: 'Run clock' }); const ended = await clock.locator('strong').innerText();
    await f.page.waitForTimeout(1600); assert.equal(await clock.locator('strong').innerText(), ended);
  } finally { await f.close(); }
});

test('a report arriving after task completion is captured once even though its status stays the same', async () => {
  let reported = false;
  const f = await openCanvas({ listed(run) { return { id: run.graphId, status: 'running', tasks: run.tasks.map((task, index) => ({ id: task.id, status: index === 0 ? 'succeeded' : index === 1 ? 'running' : 'pending', assignedThreadId: null, result: index === 0 && reported ? { summary: 'Captured later' } : null })) }; } });
  try {
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const log = f.canvas.getByRole('log'); await log.getByRole('button', { name: /TASK DONE/ }).waitFor();
    assert.equal(await log.getByRole('button', { name: /REPORT RECEIVED/ }).count(), 0);
    reported = true; await log.getByRole('button', { name: /REPORT RECEIVED/ }).waitFor();
    await f.page.waitForTimeout(1700);
    assert.equal(await log.getByRole('button', { name: /REPORT RECEIVED/ }).count(), 1);
  } finally { await f.close(); }
});

test('agents that finish between polls retain their start, task, check and report entries', async () => {
  const f = await openCanvas({ listed(run) { return { id: run.graphId, status: 'succeeded', tasks: run.tasks.map(task => ({ id: task.id, status: 'succeeded', assignedThreadId: null, result: task.kind === 'verify' ? null : { summary: 'Fast result' } })) }; } });
  try {
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.canvas.locator('.canvas-header').getByRole('status').filter({ hasText: 'Finished' }).waitFor();
    const log = f.canvas.getByRole('log');
    for (const label of ['AGENT STARTED', 'TASK DONE', 'CHECK STARTED', 'CHECK PASSED', 'REPORT RECEIVED']) assert.equal(await log.getByRole('button', { name: new RegExp(label) }).count(), 4, label);
  } finally { await f.close(); }
});

for (const [width, height] of [[1280, 800], [900, 700]]) for (const theme of ['light', 'dark']) test(`run instruments fit before, during and after the run: ${width}×${height} ${theme}`, async () => {
  const f = await staged({ width, height }); const { canvas, page } = f;
  try {
    if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
    await canvas.getByText('More patterns', { exact: true }).click();
    await canvas.getByRole('button', { name: /^Voting/ }).click();
    await fs.mkdir('/tmp/canvas-runlog', { recursive: true });
    for (const state of ['before', 'during', 'after']) {
      if (state === 'during') {
        await canvas.getByRole('button', { name: 'Run graph', exact: true }).click(); await canvas.getByRole('log').getByRole('button', { name: /AGENT STARTED/ }).first().waitFor();
        await page.waitForTimeout(400); await assertUiFit(canvas, `automatic run layout ${width} ${theme}`);
      }
      if (state === 'after') { f.advance(4); await canvas.locator('.canvas-header').getByRole('status').filter({ hasText: 'Finished' }).waitFor(); }
      for (const iso of [false, true]) {
        await canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click(); await f.fit();
        await assertUiFit(canvas, `${state} ${iso ? '3D' : '2D'} ${width} ${theme}`);
        await page.screenshot({ path: `/tmp/canvas-runlog/${width}-${theme}-${iso ? '3d' : '2d'}-${state}.png` });
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
