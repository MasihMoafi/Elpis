const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');

test('Voting finishes every agent; Tally receives all answers after their checks', async () => {
  const events = [], results = new Map();
  const fixture = await openCanvas({ listed(run) {
    run.statuses ??= new Map(run.tasks.map(task => [task.id, 'pending']));
    for (const task of run.tasks) {
      if (run.statuses.get(task.id) === 'running') {
        run.statuses.set(task.id, 'succeeded');
        results.set(task.id, task.kind === 'verify' ? 'Check passed' : `${task.title}: original answer`);
        events.push(`done:${task.title}`);
      }
    }
    const ready = run.tasks.filter(task => run.statuses.get(task.id) === 'pending' && task.dependsOn.every(id => run.statuses.get(id) === 'succeeded'));
    for (const task of ready) {
      run.statuses.set(task.id, 'running'); events.push(`start:${task.title}`);
      if (task.title === 'Tally the answers') run.tallyInput = task.dependsOn.map(id => results.get(id));
    }
    const status = [...run.statuses.values()].every(status => status === 'succeeded') ? 'succeeded' : 'running';
    return { id: run.graphId, status, tasks: run.tasks.map(task => ({ id: task.id, status: run.statuses.get(task.id), assignedThreadId: null })) };
  } });
  const { page, canvas, runs, errors, close } = fixture;
  try {
    await canvas.getByRole('button', { name: /^Voting/ }).click();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.agent-node-mark[data-check="succeeded"]').length === 4, null, { timeout: 20000 });
    // The run's chat asks for the multi-agent runtime: with the Ledger's SUBAGENTS switch off, Elpis refused every run.
    const chats = fixture.posts.filter(post => post.path === '/api/threads');
    assert.equal(chats.length, 1); assert.equal(chats[0].body.agents, true);
    for (const task of runs[0].tasks.filter(task => task.kind === 'implement')) assert.match(task.instruction, /Save your result as files inside your allowed folders/);
    assert.deepEqual(runs[0].tallyInput.filter(answer => /original answer/.test(answer)), [1, 2, 3].map(n => `Answer ${n}: original answer`));
    const tallyStart = events.indexOf('start:Tally the answers');
    for (let n = 1; n <= 3; n++) assert.ok(events.indexOf(`done:Check: Answer ${n}`) < tallyStart);
    assert.match(await canvas.locator('.canvas-header').innerText(), /Finished.*4 of 4 done/);
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme); await fixture.fit();
      await fs.mkdir('/tmp/canvas-rebuild', { recursive: true });
      await page.screenshot({ path: `/tmp/canvas-rebuild/run-${theme}.png` });
    }
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('a failed writer explains why its descendants did not start', async () => {
  const fixture = await openCanvas({ listed(run) {
    return { id: run.graphId, status: 'failed', tasks: run.tasks.map((task, index) => ({ id: task.id, status: index === 0 ? 'failed' : 'blocked', assignedThreadId: null, failureReason: index === 0 ? 'Writable success requires changed files' : 'prerequisite did not succeed' })) };
  } });
  try {
    await fixture.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await fixture.canvas.getByRole('alert').filter({ hasText: 'Writable success requires changed files' }).waitFor();
  } finally { await fixture.close(); }
});
