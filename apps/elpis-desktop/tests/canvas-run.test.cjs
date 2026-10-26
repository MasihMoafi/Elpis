const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption, chooseTheme } = require('./controls.cjs');

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
      if (task.title === 'Nuvani · Tally the answers') run.tallyInput = task.dependsOn.map(id => results.get(id));
    }
    const status = [...run.statuses.values()].every(status => status === 'succeeded') ? 'succeeded' : 'running';
    return { id: run.graphId, status, tasks: run.tasks.map(task => ({ id: task.id, status: run.statuses.get(task.id), assignedThreadId: null })) };
  } });
  const { page, canvas, runs, errors, close } = fixture;
  try {
    await canvas.getByText('More patterns', { exact: true }).click();
    await canvas.getByRole('button', { name: /^Voting/ }).click();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.agent-node-mark[data-check="succeeded"]').length === 4, null, { timeout: 20000 });
    // The run's chat asks for the multi-agent runtime: with the Ledger's SUBAGENTS switch off, Elpis refused every run.
    const chats = fixture.posts.filter(post => post.path === '/api/threads');
    assert.equal(chats.length, 1); assert.equal(chats[0].body.agents, true);
    const names = ['Quillon · Answer 1', 'Veyra · Answer 2', 'Orilo · Answer 3'];
    assert.deepEqual(runs[0].tallyInput.filter(answer => /original answer/.test(answer)), names.map(name => `${name}: original answer`));
    const tallyStart = events.indexOf('start:Nuvani · Tally the answers');
    for (const name of names) { const checked = events.indexOf(`done:Check: ${name}`); assert.ok(checked >= 0 && checked < tallyStart); }
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

test('a project with no folders runs: every agent and its check write their report in their own folder; one may write the whole project', async () => {
  const fixture = await openCanvas({ folders: [] });
  const { page, canvas, runs, node, errors, close } = fixture;
  try {
    await canvas.getByText('More patterns', { exact: true }).click();
    await canvas.getByRole('button', { name: /^Voting/ }).click();
    // The tally may write the whole project: the folder menu offers it even when the project has no folders.
    await node('Nuvani · Tally the answers').click();
    const inspector = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    await chooseOption(inspector.getByRole('combobox', { name: 'Add a folder', exact: true }), '.');
    await inspector.getByRole('group', { name: 'May write' }).getByText('Whole project', { exact: true }).waitFor();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.react-flow__node-agent [data-status="running"], .react-flow__node-agent [data-status="succeeded"]'), null, { timeout: 8000 });
    assert.equal(runs.length, 1, 'the run started');
    const byTitle = Object.fromEntries(runs[0].tasks.map(task => [task.title, task]));
    const answer = byTitle['Quillon · Answer 1'], check = byTitle['Check: Quillon · Answer 1'], tally = byTitle['Nuvani · Tally the answers'];
    assert.deepEqual([answer.writeScopes, check.writeScopes], [['agents/quillon-answer-1'], ['agents/quillon-answer-1/check']]);
    assert.deepEqual(tally.writeScopes, ['.', 'agents/nuvani-tally-the-answers']);
    assert.match(answer.instruction, /agents\/quillon-answer-1\/report\.md/);
    assert.match(check.instruction, /agents\/quillon-answer-1\/check\/report\.md/);
    assert.doesNotMatch(check.instruction, /read.only/i);
    assert.equal(new Set(runs[0].tasks.map(task => task.writeScopes.at(-1))).size, runs[0].tasks.length, 'every task has a folder of its own');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
