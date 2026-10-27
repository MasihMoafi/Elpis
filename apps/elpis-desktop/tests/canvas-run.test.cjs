const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption, chooseTheme, captureReview, openPatterns } = require('./controls.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

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
    await openPatterns(canvas);
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
  const end = 'End of the complete workflow failure details.';
  const reason = `Writable success requires changed files.\n${Array.from({ length: 40 }, (_, index) => `Check ${index + 1}: the filesystem command failed; review the agent's evidence before running again.`).join('\n')}\nRequest: ${'a'.repeat(180)}\n${end}`;
  const fixture = await openCanvas({ listed(run) {
    return { id: run.graphId, status: 'failed', tasks: run.tasks.map((task, index) => ({ id: task.id, status: index === 0 ? 'failed' : 'blocked', assignedThreadId: null, failureReason: index === 0 ? reason : 'prerequisite did not succeed' })) };
  } });
  try {
    await fixture.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const notice = fixture.canvas.getByRole('alert').filter({ hasText: 'Writable success requires changed files' }); await notice.waitFor();
    const run = fixture.canvas.getByRole('button', { name: 'Run graph', exact: true });
    await fixture.agents.first().click();
    const selected = fixture.canvas.locator('.react-flow__node-agent.selected');
    assert.equal(await selected.count(), 1);
    const ids = await fixture.agents.evaluateAll(nodes => nodes.map(node => node.dataset.id));
    const initialDetails = notice.getByRole('region', { name: 'Workflow error details', exact: true });
    await initialDetails.focus(); await initialDetails.press('Control+a');
    assert.equal(await selected.count(), 1, 'selecting error text does not select every agent');
    await initialDetails.press('Backspace');
    assert.deepEqual(await fixture.agents.evaluateAll(nodes => nodes.map(node => node.dataset.id)), ids, 'reading an error cannot delete agents');
    await fixture.page.evaluate(() => window.getSelection()?.removeAllRanges());
    for (const width of [960, 1440]) for (const theme of ['light', 'dark']) {
      await fixture.page.setViewportSize({ width, height: 900 });
      if (await fixture.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(fixture.page, theme);
      for (const iso of [false, true]) {
        await fixture.canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
        const at = await notice.boundingBox(), canvas = await fixture.canvas.boundingBox(), header = await fixture.canvas.locator('.canvas-header').boundingBox();
        assert.ok(at.x >= canvas.x && at.x + at.width <= canvas.x + canvas.width + 1, 'a long failure stays inside its workspace');
        assert.ok(at.y >= header.y + header.height && Math.abs(at.y + at.height - canvas.y - canvas.height) <= 14, 'failures occupy the bottom without covering the header');
        assert.equal(await notice.evaluate(el => !!el.closest('.canvas-header')), false, 'no error popup remains under Run');
        assert.equal(await run.getAttribute('aria-describedby'), await notice.getAttribute('id'), 'Run still describes its actual failure');
        const details = notice.getByRole('region', { name: 'Workflow error details', exact: true });
        assert.ok((await details.innerText()).includes(end), 'the complete failure remains available');
        const scroll = await details.evaluate(el => ({ client: el.clientHeight, full: el.scrollHeight, fits: el.scrollWidth <= el.clientWidth + 1 }));
        assert.ok(scroll.full > scroll.client && scroll.fits, 'long details scroll vertically and wrap unbroken text');
        await details.focus(); await details.press('End');
        // Native keyboard scrolling can finish after the key event returns. Wait for the actual scroll end;
        // the following range assertion still proves that the complete final line is readable.
        await fixture.page.waitForFunction(el => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1, await details.elementHandle());
        assert.equal(await details.evaluate((el, ending) => {
          const text = el.firstChild, start = text.textContent.indexOf(ending), range = document.createRange();
          range.setStart(text, start); range.setEnd(text, start + ending.length);
          const tail = range.getBoundingClientRect(), box = el.getBoundingClientRect();
          return el.scrollTop > 0 && tail.top >= box.top - 1 && tail.bottom <= box.bottom + 1;
        }, end), true, 'keyboard scrolling reaches the final readable line');
        await details.press('Home');
        await fixture.page.waitForFunction(el => el.scrollTop === 0, await details.elementHandle());
        await assertUiFit(notice, `bottom workflow failure ${width} ${theme} ${iso ? '3D' : '2D'}`);
        await captureReview(fixture.page, `workflow-failure-${width}-${theme}-${iso ? '3d' : '2d'}`);
      }
    }
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click(); await notice.waitFor({ state: 'hidden' });
    assert.equal(await run.getAttribute('aria-describedby'), null, 'dismissal removes the stale error description');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a project with no folders runs: every agent and its check write their report in their own folder; one may write the whole project', async () => {
  const fixture = await openCanvas({ folders: [] });
  const { page, canvas, runs, node, errors, close } = fixture;
  try {
    await openPatterns(canvas);
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

test('a new workflow can be designed at laptop width while the previous run keeps working', async () => {
  const fixture = await openCanvas({ width: 1366, graph: { name: 'Existing work', nodes: [
    { id: 'mother', type: 'mother', position: { x: 0, y: 0 }, data: {} },
    { id: 'writer', type: 'agent', position: { x: 300, y: 0 }, data: { title: 'Keep working', instruction: 'Complete the existing task.', model: null, writeScopes: ['src'], acceptanceCriteria: ['Return the result'] } },
  ], edges: [] }, listed(run) { return { id: run.graphId, status: 'running', tasks: run.tasks.map(task => ({ id: task.id, status: 'running', assignedThreadId: null })) }; } });
  try {
    const { page, canvas } = fixture;
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await canvas.getByText('Wait for this run to finish before starting another.', { exact: true }).waitFor();
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    assert.equal(await request.isEnabled(), true, 'an active run does not lock the next workflow request');
    await request.fill('from scratch: prepare the next independent workflow');
    const create = canvas.getByRole('button', { name: 'New workflow', exact: true });
    assert.equal(await create.isEnabled(), true);
    await assertUiFit(canvas.locator('.canvas-header'), 'new workflow remains reachable on a laptop during a run');
    await create.click(); await fixture.agentCount(2, 'the new draft opens');
    assert.equal(fixture.runs.length, 1, 'designing a new workflow does not start another run');
    assert.equal(fixture.runs[0].ended, undefined, 'the previous run is still running');
    assert.equal(fixture.posts.some(post => /interrupt|cancel|resume/.test(post.path)), false, 'the previous run is never stopped');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
