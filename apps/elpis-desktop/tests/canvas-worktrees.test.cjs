// Worktree isolation on the agents canvas: a run in a git repository with several writing agents asks Elpis for one
// worktree per writer, and when the engine reports a merge clash the canvas stops on it: the files are listed and the
// agent is marked (engine contract: codex-rs core/src/tools/handlers/work_graph_worktrees.rs, docs/WORK_GRAPHS.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

const writer = (id, title, x, y, folder) => ({ id, type: 'agent', position: { x, y }, data: { title, instruction: `Do ${title}`, model: null, writeScopes: [folder], acceptanceCriteria: [] } });
/** Two parts side by side and a join that waits for both. */
const TEAM = { name: 'Two parts', nodes: [writer('a1', 'Quillon · Part 1', 240, -60, 'src'), writer('a2', 'Veyra · Part 2', 240, 60, 'docs'), writer('a3', 'Join', 480, 0, 'tests')],
  edges: [{ id: 'a1->a3', source: 'a1', target: 'a3' }, { id: 'a2->a3', source: 'a2', target: 'a3' }] };
const ALONE = { name: 'One part', nodes: [writer('a1', 'Quillon · Part 1', 240, 0, 'src')], edges: [] };
const KEPT = 'Kept for inspection: /tmp/demo-elpis/graph-1/a1 (branch elpis/graph-1/a1), /tmp/demo-elpis/graph-1/a2 (branch elpis/graph-1/a2).';

/** Waits until `read()` is truthy, naming the step on failure. */
async function eventually(read, label) {
  const until = Date.now() + 8000;
  for (;;) {
    const value = read(); if (value) return value;
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const run = canvas => canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
/** A look at the run once its first look is past: the graph ended as `status`, each task as `tasks` says (default: done). */
const ended = (status, error, tasks = {}) => (item, looks) => looks === 0 ? undefined : { id: item.graphId, name: item.name, status, error, worktreeReport: error, eventCount: 9,
  tasks: item.tasks.map(task => ({ id: task.id, kind: task.kind, title: task.title, status: 'succeeded', assignedThreadId: null, failureReason: null, ...tasks[task.id] })) };
const status = async (node, selector = '.agent-node') => node.locator(selector).first().getAttribute('data-status');

test('a run asks for worktree isolation in a git repository with more than one writing agent, and not otherwise', async () => {
  const sent = async options => {
    const opened = await openCanvas(options);
    try { await run(opened.canvas); return (await eventually(() => opened.runs[0], 'the run was sent')); }
    finally { await opened.close(); }
  };
  const inRepository = await sent({ graph: TEAM, repository: true });
  assert.equal(inRepository.isolation, 'worktree');
  assert.deepEqual(inRepository.tasks.filter(task => task.kind === 'implement').map(task => task.id), ['a1', 'a2', 'a3']);
  // The folder is not a git repository: Elpis would refuse the run, so the canvas leaves isolation out.
  assert.equal('isolation' in await sent({ graph: TEAM, repository: false }), false);
  // One writing agent has no one to clash with.
  assert.equal('isolation' in await sent({ graph: ALONE, repository: true }), false);
});

test('a clash at the end of the run stops it: the files are listed and the agent whose work clashed is marked', async () => {
  const error = `Not merged: elpis/graph-1/a2 clashes with main in src/app.ts, README.md; main is untouched. ${KEPT}`;
  const { page, canvas, node, errors, close } = await openCanvas({ graph: TEAM, repository: true, listed: ended('failed', error) });
  try {
    await run(canvas);
    const notice = canvas.locator('.canvas-notice');
    await notice.waitFor({ timeout: 8000 });
    assert.equal(await notice.innerText(), `Merge stopped: “Veyra · Part 2” clashes with main in src/app.ts, README.md. main is untouched. ${KEPT}`);
    assert.equal(await notice.getAttribute('role'), 'alert');
    // The agent whose result clashed is marked failed, in words as well as colour; the others are done.
    assert.equal(await status(node('Veyra · Part 2')), 'failed');
    assert.match(await node('Veyra · Part 2').locator('.agent-node-meta').innerText(), /clash$/);
    for (const title of ['Quillon · Part 1', 'Join']) { assert.equal(await status(node(title)), 'succeeded', title); assert.match(await node(title).locator('.agent-node-meta').innerText(), /done$/, title); }
    // The run log says it too, and the run is over.
    assert.match(await canvas.getByRole('log', { name: 'Run log' }).innerText(), /Veyra · Part 2: merge clash in src\/app\.ts, README\.md/);
    // The run is over, and the agent whose work clashed is not counted as done.
    await canvas.getByRole('status').filter({ hasText: /Finished · 2 of 3 done/ }).waitFor();
    // The agent's dashboard lists every clashing file.
    await node('Veyra · Part 2').dblclick();
    const dashboard = canvas.getByRole('dialog', { name: 'Veyra · Part 2 info' });
    assert.equal(await dashboard.locator('dt', { hasText: 'Merge clash' }).locator('xpath=following-sibling::dd').innerText(), 'src/app.ts\nREADME.md');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('a clash between the work an agent builds on marks that agent and lists the files', async () => {
  const reason = 'task `a3` builds on elpis/graph-1/a1 and elpis/graph-1/a2, whose results clash in: src/shared.ts, src/util.ts; the conflicted worktree is kept at /tmp/demo-elpis/graph-1/a3 (branch elpis/graph-1/a3)';
  const error = `one or more work graph tasks failed or were blocked. Not built: ${reason}. Kept worktrees with work: /tmp/demo-elpis/graph-1/a1 (branch elpis/graph-1/a1).`;
  const { canvas, node, errors, close } = await openCanvas({ graph: TEAM, repository: true,
    listed: ended('failed', error, { a3: { status: 'failed', failureReason: reason }, 'a3-check': { status: 'blocked', failureReason: 'it waits for a3, which failed' } }) });
  try {
    await run(canvas);
    const notice = canvas.locator('.canvas-notice');
    await notice.waitFor({ timeout: 8000 });
    assert.equal(await notice.innerText(), 'Merge stopped: the work “Join” builds on clashes in src/shared.ts, src/util.ts. Your branch is untouched. Kept worktrees with work: /tmp/demo-elpis/graph-1/a1 (branch elpis/graph-1/a1).');
    assert.equal(await status(node('Join')), 'failed');
    assert.match(await node('Join').locator('.agent-node-meta').innerText(), /clash$/);
    assert.equal(await status(node('Quillon · Part 1')), 'succeeded');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('an ordinary task failure shows its reason without a merge notice or merge clash', async () => {
  const { canvas, node, errors, close } = await openCanvas({ graph: TEAM, repository: true,
    listed: ended('failed', 'one or more work graph tasks failed or were blocked. No worktree was created.', { a2: { status: 'failed', failureReason: 'the model stopped' } }) });
  try {
    await run(canvas);
    await canvas.getByText(/Finished/).first().waitFor({ timeout: 8000 });
    assert.equal(await canvas.locator('.canvas-notice').innerText(), "Veyra · Part 2: the model stopped Review this message and the agents' Info, then try Run graph again.");
    assert.doesNotMatch(await canvas.locator('.canvas-notice').innerText(), /Merge stopped/);
    assert.equal(await status(node('Veyra · Part 2')), 'failed');
    assert.doesNotMatch(await node('Veyra · Part 2').locator('.agent-node-meta').innerText(), /clash/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
