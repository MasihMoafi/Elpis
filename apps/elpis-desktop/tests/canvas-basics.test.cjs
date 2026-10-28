// The basics every node editor has (Blender, ComfyUI, Resolve, Node-RED, Slate; lat.md/tasks.md, 17 October 2026):
// undo and redo, copy and paste with the wires among the copies, duplicate, delete keeping the flow, right-click
// menus on agents, the board and wires, F2 to rename, and Home to fit the whole graph.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas, planFor } = require('./canvas-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { captureReview, chooseOption, chooseTheme, openPatterns } = require('./controls.cjs');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const reportPlan = body => ({ name: 'Pointt review', agents: [{ key: 'evidence', title: 'Review evidence', prompt: body.goal, folders: [], doneWhen: ['Return the observed findings'], waitsFor: [] }] });

for (const colorScheme of ['light', 'dark']) test(`workflows start in their sandbox without a project and keep reports scoped (${colorScheme})`, async () => {
  const sandbox = '/tmp/elpis-workflow-sandbox';
  const root = { id: 'sandbox-root', name: 'Pointt review', cwd: sandbox, status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const f = await fixture({ colorScheme, cwd: '', storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [], selectedId: null }),
  }, routes: {
    '/api/workflows/workspace': () => ({ cwd: sandbox }),
    '/api/folders': () => ({ data: [] }),
    '/api/canvas/plan': reportPlan,
    '/api/threads': body => body ? { thread: root } : { data: THREADS.map(thread => ({ ...thread, cwd: '' })), nextCursor: null },
    '/api/repository': () => ({ repository: false }),
    '/api/workflows/run': () => ({ graphId: '00000000-0000-0000-0000-000000000011' }),
    '/api/workflows': () => ({ data: [] }),
  } });
  try {
    const { page } = f;
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    await canvas.getByRole('button', { name: 'Choose project', exact: true }).filter({ hasText: 'Sandbox' }).waitFor();
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    const goal = 'Review Pointt and tell me the next three steps.';
    await request.fill(goal);
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-agent').length === 1);
    const plan = f.posts.find(post => post.path === '/api/canvas/plan');
    assert.equal(plan.body.cwd, sandbox); assert.equal(plan.body.goal, goal); assert.deepEqual(plan.body.agents, []);
    const sent = page.waitForResponse(response => response.url().endsWith('/api/workflows/run') && response.request().method() === 'POST');
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click(); await sent;
    assert.equal(f.posts.find(post => post.path === '/api/threads').body.cwd, sandbox);
    const run = f.posts.find(post => post.path === '/api/workflows/run').body;
    assert.equal(run.isolation, undefined);
    assert.ok(run.tasks.every(task => task.writeScopes.length === 1 && task.writeScopes[0].startsWith('agents/')), 'review tasks write only their own report/check folders');
    assert.equal(await request.inputValue(), goal);
    assert.equal(f.posts.filter(post => post.path === '/api/workflows/workspace').length, 1);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-sandbox-${colorScheme}.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('choosing a workflow project stays on the board, preserves its request and can return to the sandbox', async () => {
  const sandbox = '/tmp/elpis-workflow-sandbox', project = { id: 'pointt', name: 'Pointt', cwd: '/tmp/pointt' };
  const f = await fixture({ cwd: '', storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [project], selectedId: null }),
  }, routes: { '/api/workflows/workspace': () => ({ cwd: sandbox }), '/api/folders': () => ({ data: [] }), '/api/canvas/plan': reportPlan } });
  try {
    const { page } = f; await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Keep this exact review request.');
    await canvas.getByRole('button', { name: 'Choose project', exact: true }).click();
    await page.getByRole('menuitem', { name: /Pointt/ }).click();
    await canvas.waitFor(); assert.equal(await request.inputValue(), 'Keep this exact review request.');
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-agent').length === 1);
    assert.equal(f.posts.filter(post => post.path === '/api/canvas/plan').at(-1).body.cwd, project.cwd);
    await canvas.getByRole('button', { name: 'Choose project', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Use sandbox', exact: true }).click();
    await canvas.getByRole('button', { name: 'Choose project', exact: true }).filter({ hasText: 'Sandbox' }).waitFor();
    const replanned = page.waitForResponse(response => response.url().endsWith('/api/canvas/plan') && response.request().method() === 'POST');
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).click(); await replanned;
    const sandboxPlan = f.posts.filter(post => post.path === '/api/canvas/plan').at(-1);
    assert.equal(sandboxPlan.body.cwd, sandbox); assert.equal(sandboxPlan.body.goal, 'Keep this exact review request.');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('workflow history dismisses outside and with Escape, restores focus and keeps the draft', async () => {
  const f = await fixture({ routes: { '/api/workflows/history': () => ({ data: [] }) } });
  try {
    const { page } = f;
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Keep my unfinished workflow request.');
    const history = canvas.getByRole('button', { name: 'History', exact: true });
    await history.click(); await page.getByText('No workflows in history.', { exact: true }).waitFor();
    await request.click();
    await page.getByText('No workflows in history.', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await request.inputValue(), 'Keep my unfinished workflow request.');
    await history.click(); await page.getByText('No workflows in history.', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByText('No workflows in history.', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await history.evaluate(node => node === document.activeElement), true);
    assert.equal(await request.inputValue(), 'Keep my unfinished workflow request.');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Ctrl+A selects only the focused workflow editor or board', async () => {
  const f = await openCanvas();
  try {
    const { page, canvas } = f;
    await f.node('Quillon · Part 1').click();
    const selected = canvas.locator('.react-flow__node-agent.selected');
    assert.equal(await selected.count(), 1);
    await canvas.getByRole('button', { name: 'History', exact: true }).focus();
    await page.keyboard.press('Control+a');
    assert.equal(await selected.count(), 1, 'a toolbar control cannot select every node');
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ''), '', 'toolbar focus cannot select the whole app');
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Only this input is selected.'); await request.press('Control+a');
    assert.deepEqual(await request.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 28]);
    assert.equal(await selected.count(), 1, 'text selection keeps board selection');
    await canvas.locator('.react-flow').focus(); await page.keyboard.press('Control+a');
    assert.equal(await selected.count(), 4, 'explicit board focus selects its four agents');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('offline workflows keep the exact request editable, block callbacks, and design after reconnecting', async () => {
  const f = await fixture({ width: 1440, height: 900, cwd: '/tmp/demo', storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p1', name: 'demo', cwd: '/tmp/demo' }], selectedId: 'p1' }),
  }, routes: { '/api/folders': () => ({ data: ['src'] }), '/api/canvas/plan': body => planFor(body) } });
  let releasePlan;
  try {
    const { page } = f;
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.waitFor();
    f.emit('connection', { connected: false });
    const offline = canvas.getByRole('status').filter({ hasText: 'Reconnect to design or run workflows. Your draft stays editable.' });
    await offline.waitFor();
    for (const name of ['New workflow', 'Update current', 'Run graph']) assert.equal(await canvas.getByRole('button', { name, exact: true }).isDisabled(), true, name);
    const goal = 'Fix login — keep these exact words';
    await request.fill(goal);
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-agent').length === 5);
    const before = f.posts.length;
    // A form submit and the run shortcut must also be guarded, independently of disabled buttons.
    await canvas.getByRole('form', { name: 'New workflow', exact: true }).evaluate(form => form.requestSubmit());
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(value => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.request === value, goal);
    assert.deepEqual(f.posts.slice(before).filter(post => /^\/api\/(canvas\/plan|workflows\/run|threads)$/.test(post.path)), [], 'offline callbacks send no runtime mutations');
    assert.equal(await request.inputValue(), goal);
    f.emit('connection', { connected: true });
    await offline.waitFor({ state: 'detached' });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.nodes.filter(node => node.type === 'agent').length === 5);
    const savedBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')));
    const heldPlan = new Promise(resolve => { releasePlan = resolve; });
    await page.route('**/api/canvas/plan', async route => { await heldPlan; await route.continue(); });
    const pendingPlan = page.waitForRequest(req => req.url().endsWith('/api/canvas/plan'));
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await pendingPlan;
    f.emit('connection', { connected: false }); await offline.waitFor();
    f.emit('connection', { connected: true }); await offline.waitFor({ state: 'detached' });
    releasePlan();
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))), savedBefore, 'a plan from the previous connection cannot replace an unchanged saved board');
    assert.equal(await canvas.locator('.react-flow__node-agent').count(), 5);
    assert.equal(f.posts.some(post => /^\/api\/(threads|workflows\/run)$/.test(post.path)), false);
    await page.unroute('**/api/canvas/plan');
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-agent').length === 1);
    const plan = f.posts.filter(post => post.path === '/api/canvas/plan').at(-1);
    assert.equal(plan.body.goal, goal);
    assert.deepEqual(plan.body.agents, []);
    assert.equal(await request.inputValue(), goal);
    assert.equal(f.posts.some(post => post.path === '/api/workflows/run'), false);
    assert.deepEqual(f.errors, []);
  } finally { releasePlan?.(); await f.close(); }
});

test('reconnecting during run preparation cannot submit the old run and keeps edits for an explicit retry', async () => {
  let created = 0, releaseRepository;
  const graph = { name: 'Connection retry', request: 'Keep this request', nodes: ['a', 'b'].map((id, index) => ({
    id, type: 'agent', position: { x: 260, y: index * 180 }, data: { title: `Writer ${id}`, instruction: `Write evidence for ${id}`, model: null, writeScopes: ['src'], acceptanceCriteria: ['Evidence exists'] },
  })), edges: [] };
  const f = await fixture({ width: 1440, height: 900, cwd: '/tmp/demo', storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p1', name: 'demo', cwd: '/tmp/demo' }], selectedId: 'p1' }),
    'elpis-workflow-draft-v1': JSON.stringify(graph),
  }, routes: {
    '/api/folders': () => ({ data: ['src'] }), '/api/repository': () => ({ repository: true }),
    '/api/threads': body => body ? { thread: { ...THREADS[0], id: `created-${++created}`, cwd: '/tmp/demo' } } : { data: THREADS, nextCursor: null },
    '/api/workflows/run': () => ({ graphId: 'retried-run' }),
    '/api/workflows': () => ({ data: [{ id: 'retried-run', status: 'succeeded', tasks: [] }] }),
  } });
  try {
    const { page } = f;
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.waitFor();
    const heldRepository = new Promise(resolve => { releaseRepository = resolve; });
    await page.route('**/api/repository**', async route => { await heldRepository; await route.continue(); });
    const pendingRepository = page.waitForRequest(req => new URL(req.url()).pathname === '/api/repository');
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await pendingRepository;
    assert.equal(created, 1, 'the original online attempt created its root before the connection changed');
    const offline = canvas.getByRole('status').filter({ hasText: 'Reconnect to design or run workflows. Your draft stays editable.' });
    f.emit('connection', { connected: false }); await offline.waitFor();
    const edited = 'Keep the edit made during interrupted preparation';
    await request.fill(edited);
    f.emit('connection', { connected: true }); await offline.waitFor({ state: 'detached' });
    releaseRepository();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).waitFor();
    await page.waitForFunction(value => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.request === value, edited);
    assert.equal(f.posts.some(post => post.path === '/api/workflows/run'), false, 'reconnection cannot continue the old attempt after its repository read');
    assert.equal(await canvas.locator('.react-flow__node-agent').count(), 2);
    await page.unroute('**/api/repository**');
    const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workflows/run' && response.ok());
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await retried;
    const sent = f.posts.filter(post => post.path === '/api/workflows/run');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.rootThreadId, 'created-2', 'only the explicit new attempt starts the run');
    assert.equal(sent[0].body.isolation, 'worktree');
    assert.equal(await request.inputValue(), edited);
    assert.deepEqual(f.errors, []);
  } finally { releaseRepository?.(); await f.close(); }
});

test('New workflow stays available with a closed panel, starts from empty context, and keeps current work recoverable', async () => {
  const f = await openCanvas({ desktop: true });
  const request = () => f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
  let releasePlan;
  try {
    await request().waitFor();
    assert.equal(await f.canvas.getByRole('textbox', { name: 'Graph name', exact: true }).count(), 0, 'a preset is selected rather than edited as a name');
    await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    await f.canvas.locator('.canvas-side').waitFor({ state: 'detached' });
    await f.saved();
    await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await request().waitFor();
    assert.equal(await f.canvas.locator('.canvas-side').count(), 0, 'the closed panel preference survives');
    for (const theme of ['light', 'dark']) for (const width of [1440, 960]) {
      await f.page.setViewportSize({ width, height: 900 });
      if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await f.page.evaluate(() => document.fonts.ready);
      await f.fit();
      await assertUiFit(f.canvas.locator('.canvas-header'), `workflow entry fits at ${width} in ${theme}`);
      assert.equal(await request().isVisible(), true, 'the primary request does not depend on the side panel');
      assert.equal(await f.canvas.locator('.canvas-side').count(), 0, 'the entry remains available with the panel closed');
      await captureReview(f.page, `workflow-entry-closed-${width}-${theme}`);
    }
    await request().fill('Fix the login bug');
    const before = await f.saved();
    await f.page.route('**/api/canvas/plan', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Planning refused for this attempt.' }) }));
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.canvas.getByRole('alert').filter({ hasText: 'Planning refused for this attempt.' }).waitFor();
    assert.equal(await request().inputValue(), 'Fix the login bug');
    assert.deepEqual(await f.saved(), before, 'refusal keeps the saved starter and request');
    await f.page.unroute('**/api/canvas/plan');
    const heldPlan = new Promise(resolve => { releasePlan = resolve; });
    await f.page.route('**/api/canvas/plan', async route => { await heldPlan; await route.continue(); });
    const asked = f.page.waitForRequest(req => req.url().endsWith('/api/canvas/plan'));
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await asked;
    await f.canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await f.agentCount(5, 'the person edited the board while a plan was pending');
    await f.canvas.locator('.canvas-side').waitFor();
    await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    await f.canvas.locator('.canvas-side').waitFor({ state: 'detached' });
    const edited = await f.saved();
    releasePlan();
    await f.canvas.getByRole('alert').filter({ hasText: 'The current workflow changed while Elpis was designing.' }).waitFor();
    assert.deepEqual(await f.saved(), edited, 'a late plan cannot overwrite the person’s intervening work');
    await f.page.unroute('**/api/canvas/plan');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.agentCount(1, 'the new workflow uses the assistant’s team');
    assert.deepEqual(f.plans.at(-1).agents, [], 'even an unmarked saved starter supplies no team to New workflow');
    assert.equal(f.runs.length, 0, 'designing a workflow does not start it');
    const designed = await f.saved();
    await f.page.evaluate(() => document.activeElement?.blur()); await f.page.keyboard.press('Control+z');
    await f.agentCount(5, 'Undo recovers the prior board');
    await f.page.keyboard.press('Control+Shift+z'); await f.agentCount(1, 'Redo restores the new workflow');
    await f.saved();
    await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await request().waitFor();
    await f.agentCount(1, 'the designed team survives reload');
    assert.deepEqual((await f.saved()).nodes, designed.nodes);
    assert.equal(await f.canvas.locator('.canvas-side').count(), 0);
    await request().fill('Fix another login bug');
    await f.canvas.getByRole('button', { name: 'Update current', exact: true }).click();
    await f.agentCount(2, 'Update current keeps the saved team');
    assert.deepEqual(f.plans.at(-1).agents.map(agent => agent.key), designed.nodes.filter(node => node.type === 'agent').map(node => node.id));
    assert.deepEqual(f.errors, []);
  } finally { releasePlan?.(); await f.close(); }
});

test('canvas basics: undo and redo, copy and paste, duplicate, delete keeping the flow, menus, rename, fit', async () => {
  const { page, canvas, node, wires, saved, titles, agentCount, fit, errors, plans, runs, close } = await openCanvas();
  try {
    const off = () => page.evaluate(() => document.activeElement?.blur());
    const wired = (graph, from, to) => graph.edges.some(edge => graph.nodes.find(item => item.id === edge.source)?.data?.title === from && graph.nodes.find(item => item.id === edge.target)?.data?.title === to);

    await agentCount(4, 'the default board');
    // Readable on opening, as FigJam keeps its objects: the board never zooms below 85% by itself, so an agent's name
    // reads at 12 px or more.
    const named = await node('Quillon · Part 1').locator('.agent-node-title').evaluate(title => parseFloat(getComputedStyle(title).fontSize) * title.getBoundingClientRect().height / title.offsetHeight);
    assert.ok(named >= 12, `an agent's name reads at ${named.toFixed(1)} px`);
    // Shift+click as a hand does it (Shift held, the mouse wobbling a pixel or two) adds to the selection and moves
    // nothing; Ctrl+A selects every agent.
    await fit();
    const where = async () => (await saved()).nodes.map(item => `${item.position.x},${item.position.y}`).join(' ');
    const shiftClick = async title => {
      const box = await node(title).boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.move(box.x + 60, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 63, box.y + 32); await page.mouse.up();
      await page.keyboard.up('Shift');
    };
    const selected = () => canvas.locator('.react-flow__node.selected .agent-node-title').allInnerTexts();
    const placed = await where();
    await node('Quillon · Part 1').click(); await shiftClick('Veyra · Part 2'); await shiftClick('Orilo · Part 3');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3']);
    assert.equal(await where(), placed, 'Shift+click moved nothing');
    await shiftClick('Veyra · Part 2');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Orilo · Part 3'], 'Shift+click on a selected agent takes it out');
    await canvas.locator('.react-flow').focus(); await page.keyboard.press('Control+a');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3', 'Nuvani · Join the parts']);
    assert.equal(await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).count(), 0, 'Ctrl+A selects; it opens nothing');
    await canvas.getByRole('complementary', { name: 'Selected agents', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();

    // The mouse as in Fusion and Slate: left-drag on empty board draws a selection box; middle-drag pans; nothing moves.
    const pane = await canvas.locator('.react-flow__pane').boundingBox(), p1 = await node('Quillon · Part 1').boundingBox(), p3 = await node('Orilo · Part 3').boundingBox();
    await page.mouse.move(p1.x - 20, p1.y - 20); await page.mouse.down(); await page.mouse.move(p3.x + p3.width + 20, p3.y + p3.height + 20, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3'], 'the box selects what it covers');
    assert.equal(await where(), placed, 'drawing a box moved nothing');
    // A click inside the boxed group picks that agent, never the whole group.
    await shiftClick('Veyra · Part 2');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Orilo · Part 3'], 'Shift+click inside a box takes that agent out');
    assert.equal(await where(), placed, 'and moves nothing');
    const view = () => canvas.locator('.react-flow__viewport').evaluate(item => item.style.transform);
    const before = await view();
    await page.mouse.move(pane.x + 30, pane.y + 30); await page.mouse.down({ button: 'middle' }); await page.mouse.move(pane.x + 130, pane.y + 90, { steps: 6 }); await page.mouse.up({ button: 'middle' });
    assert.notEqual(await view(), before, 'middle-drag pans');
    await fit();

    // Tab opens Add, and typing on the board starts a command with that key.
    const adder = canvas.getByRole('dialog', { name: 'Add agents', exact: true }), command = adder.getByRole('textbox', { name: 'Command', exact: true });
    await off(); await page.keyboard.press('Tab');
    await command.waitFor(); await page.keyboard.press('Escape'); await adder.waitFor({ state: 'hidden' });
    await off(); await page.keyboard.type('build');
    await command.waitFor();
    assert.equal(await command.inputValue(), 'build');
    await page.keyboard.press('Escape');

    // A note is for the user, never sent; it moves by its strip.
    await canvas.getByRole('button', { name: 'Note', exact: true }).click();
    const grip = canvas.locator('.canvas-note-grip').first(), from = await grip.boundingBox();
    await page.mouse.move(from.x + 20, from.y + 5); await page.mouse.down(); await page.mouse.move(from.x + 140, from.y + 65, { steps: 8 }); await page.mouse.up();
    const to = await grip.boundingBox();
    assert.ok(Math.abs(to.x - from.x - 120) < 25 && Math.abs(to.y - from.y - 60) < 25, `the note moved by its strip (${Math.round(to.x - from.x)}, ${Math.round(to.y - from.y)})`);
    await page.keyboard.press('Delete');
    await off(); await page.keyboard.press('Control+z');
    await page.waitForTimeout(450);

    // An agent's dots are easy to hit: a press up to 12 px from a dot's centre still lands on the dot.
    const dot = await node('Quillon · Part 1').locator('.react-flow__handle.source').boundingBox(), centre = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 };
    for (const [dx, dy] of [[12, 0], [0, 12], [-9, -9], [9, 9]])
      assert.ok(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.react-flow__handle')), [centre.x + dx, centre.y + dy]), `a press ${dx}, ${dy} px from the dot lands on it`);

    // The side panel folds away to give the board the whole width (remembered); choosing an agent brings it back.
    const boardWidth = async () => (await canvas.locator('.react-flow').boundingBox()).width;
    const wide = await boardWidth();
    await canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    await canvas.getByRole('complementary').waitFor({ state: 'detached' });
    assert.ok(await boardWidth() > wide + 200, 'the board took the panel\'s width');
    await page.reload(); await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    assert.equal(await canvas.getByRole('complementary').count(), 0, 'the folded panel stays folded');
    await fit(); await node('Quillon · Part 1').click();
    await canvas.getByRole('complementary', { name: 'Selected agent', exact: true }).waitFor();
    await canvas.getByRole('complementary', { name: 'Selected agent', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();

    // The guide to managing agents stays one click away under the board.
    await canvas.getByRole('region', { name: 'Guide' }).getByRole('button', { name: 'Guide to managing agents', exact: true }).waitFor();

    // The header fits a small window: nothing runs past its edge or is cut off.
    for (const width of [1130, 960]) {
      await page.setViewportSize({ width, height: 660 }); await page.waitForTimeout(150);
      assert.deepEqual(await canvas.locator('.canvas-header').evaluate(header => { const box = header.getBoundingClientRect(); return [header.scrollWidth <= header.clientWidth + 1, [...header.children].every(item => { const at = item.getBoundingClientRect(); return at.right <= box.right + 1 && item.scrollWidth <= item.clientWidth + 1; })]; }), [true, true], `the header fits at ${width} px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(150);

    // Undo and redo, off any text field: Ctrl+Z takes back adding an agent; Ctrl+Shift+Z and Ctrl+Y bring it back.
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await agentCount(5, 'added');
    await off(); await page.keyboard.press('Control+z');
    await agentCount(4, 'undone');
    await page.keyboard.press('Control+Shift+z');
    await agentCount(5, 'redone');
    await page.keyboard.press('Control+z'); await agentCount(4, 'undone again');
    await page.keyboard.press('Control+y'); await agentCount(5, 'redone with Ctrl+Y');
    await page.keyboard.press('Control+z'); await agentCount(4, 'back to the default board');

    // Copy and paste keep the wires among the copied agents, never to the originals; the copies are selected.
    await fit();
    await node('Quillon · Part 1').click(); await node('Nuvani · Join the parts').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Control+c');
    const board = await canvas.locator('.react-flow__pane').boundingBox();
    await page.mouse.move(board.x + board.width * 0.5, board.y + board.height * 0.85);
    await page.keyboard.press('Control+v');
    await agentCount(6, 'pasted');
    let graph = await saved();
    const copies = graph.nodes.filter(item => item.data?.title?.endsWith(' · Part 1') || item.data?.title?.endsWith(' · Join the parts'));
    assert.equal(copies.length, 4);
    assert.equal(new Set(graph.nodes.filter(item => item.type === 'agent').map(item => item.data.title)).size, 6, 'copies receive unique names');
    const copyIds = new Set(await canvas.locator('.react-flow__node-agent.selected').evaluateAll(list => list.map(item => item.dataset.id)));
    assert.equal(copyIds.size, 2, 'the two copies are selected');
    assert.ok(graph.edges.some(edge => copyIds.has(edge.source) && copyIds.has(edge.target)), 'the copies keep their wire');
    assert.ok(!graph.edges.some(edge => copyIds.has(edge.source) !== copyIds.has(edge.target)), 'no wire joins a copy to an original');
    // Ctrl+D duplicates the selection in one step, and one Ctrl+Z takes it back.
    await page.keyboard.press('Control+d');
    await agentCount(8, 'duplicated');
    await off(); await page.keyboard.press('Control+z');
    await agentCount(6, 'duplicate undone');

    // Delete keeping the flow (Ctrl+Delete): what waited for the agent now waits for what it waited for.
    await openPatterns(canvas);
    await canvas.getByRole('button', { name: /^Sequential/ }).click();
    await node('Veyra · Step 2: build on it').waitFor();
    await node('Veyra · Step 2: build on it').click();
    await page.keyboard.press('Control+Delete');
    await agentCount(2, 'deleted keeping the flow');
    graph = await saved();
    assert.ok(wired(graph, 'Quillon · Step 1: the base', 'Orilo · Step 3: finish'), 'step 3 now waits for step 1');

    // Right-click menus preserve their actions and append Improve Elpis's "Change this…".
    await node('Quillon · Step 1: the base').click({ button: 'right' });
    const agentMenu = canvas.getByRole('menu', { name: 'Agent Quillon · Step 1: the base', exact: true });
    assert.deepEqual(await agentMenu.getByRole('menuitem').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Info', 'Rename', 'Add agents after it', 'Duplicate', 'Copy', 'Delete, keep the flow', 'Delete', 'Change this…']);
    await agentMenu.getByRole('menuitem', { name: /^Duplicate/ }).click();
    await agentCount(3, 'duplicated from the menu');
    // On the board: add, paste, arrange and fit.
    await fit();
    await page.mouse.click(board.x + 20, board.y + 20, { button: 'right' });
    const boardMenu = canvas.getByRole('menu', { name: 'Board', exact: true });
    assert.deepEqual(await boardMenu.getByRole('menuitem').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Add agents', 'Add a note', 'Paste 2 agents', 'Arrange by run order', 'Fit the view', 'Change this…']);
    await boardMenu.getByRole('menuitem', { name: /^Add agents/ }).click();
    await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    // On a wire: the same menu a click opens.
    const wire = wires.first(), point = await wire.locator('.react-flow__edge-path').evaluate(path => { const at = path.getPointAtLength(path.getTotalLength() / 2), m = path.getScreenCTM(); return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f }; });
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await canvas.getByRole('menu', { name: 'Wire', exact: true }).waitFor();
    await page.keyboard.press('Escape');

    // F2 renames the selected agent: its name field takes the keys, with the name selected.
    await node('Orilo · Step 3: finish').click();
    await page.keyboard.press('F2');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Name');
    assert.deepEqual(await page.evaluate(() => [document.activeElement.getAttribute('aria-label'), document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)]), ['Name', 'Orilo · Step 3: finish']);
    await page.keyboard.type('Finish it');
    assert.deepEqual(await titles(), ['Quillon · Step 1: the base', 'Finish it', 'Veyra · Step 1: the base']);

    // Home fits the whole graph back into view, however far it was zoomed.
    await off();
    for (let index = 0; index < 3; index++) await canvas.getByRole("button", { name: /zoom in/i }).click();
    await page.keyboard.press('Home'); await page.waitForTimeout(400);
    const area = await canvas.locator('.react-flow').boundingBox();
    for (const box of await canvas.locator('.react-flow__node-agent').evaluateAll(list => list.map(item => { const at = item.getBoundingClientRect(); return { x: at.x, y: at.y, right: at.right, bottom: at.bottom }; })))
      assert.ok(box.x >= area.x && box.right <= area.x + area.width && box.y >= area.y && box.bottom <= area.y + area.height, 'every agent is in view');

    // Run graph never stops for a missing goal: Elpis gives each agent what it lacks, from the team as drawn, and the
    // run starts.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('done'), null, { timeout: 10000 });
    assert.match(plans.at(-1).goal, /^Run this team as drawn/);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].tasks.filter(task => task.kind === 'implement').every(task => task.writeScopes.length), 'every agent got a folder');
    // "Let Elpis handle it": from a goal, Elpis designs the team; one Ctrl+Z puts the old board back.
    await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
    const motherPanel = canvas.getByRole('complementary', { name: 'Mother', exact: true });
    await motherPanel.getByRole('textbox', { name: 'Goal', exact: true }).fill('Build a dark theme from scratch');
    await page.waitForTimeout(400);
    await motherPanel.getByRole('button', { name: 'Let Elpis design the team', exact: true }).click();
    await node('Use the theme').waitFor();
    assert.deepEqual(await titles(), ['Build the theme', 'Use the theme']);
    assert.ok(wired(await saved(), 'Build the theme', 'Use the theme'), 'the team is wired as designed');
    assert.equal(plans.at(-1).goal, 'Build a dark theme from scratch');
    assert.equal(plans.at(-1).agents.length, 3, 'existing-board planning keeps the team the person edited');
    await off(); await page.keyboard.press('Control+z');
    await agentCount(3, 'the design undone');
    // Free text in the command line that is no command goes to Elpis, which acts on the board.
    await off(); await page.keyboard.press('Tab'); await command.waitFor();
    await page.keyboard.type('Fix the login bug');
    assert.match(await adder.getByLabel('Will add').innerText(), /^Elpis/);
    await page.keyboard.press('Enter');
    await agentCount(4, 'Elpis added the agent asked for');
    assert.ok((await titles()).includes('Fix the login bug'));

    // Wiring, every way a hand tries it. From a right dot onto any part of another agent: it waits for this one. From a
    // left dot: this one waits for the other. With Alt held: the two work alongside (no order), a dashed line with no
    // arrows. From the Mother's dot: she takes no wires, and says so.
    await fit();
    const dragTo = async (from, end, onto, alt = false) => {
      const dot = await from.locator(`.react-flow__handle.${end}`).boundingBox(), body = await onto.boundingBox();
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2); await page.mouse.down();
      await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 10 }); await page.mouse.up();
      if (alt) await page.keyboard.up('Alt');
      await page.waitForTimeout(450);
    };
    const edgesNow = async () => { const graph = await saved(), title = id => graph.nodes.find(item => item.id === id)?.data?.title ?? id; return graph.edges.map(edge => [title(edge.source), title(edge.target), edge.kind ?? 'waits']); };
    const fixer = node('Fix the login bug'), finisher = node('Finish it'), copy = node('Veyra · Step 1: the base'), base = node('Quillon · Step 1: the base').first();
    await dragTo(fixer, 'source', finisher);
    assert.ok((await edgesNow()).some(([a, b, kind]) => a === 'Fix the login bug' && b === 'Finish it' && kind === 'waits'), 'right dot onto a body: it waits for this one');
    await dragTo(copy, 'target', fixer);
    assert.equal((await edgesNow()).filter(([a, b]) => a === 'Fix the login bug' && b === 'Veyra · Step 1: the base').length, 1, 'left dot onto a body: this one waits for the other');
    await dragTo(base, 'source', node('Fix the login bug'), true);
    const alongside = (await edgesNow()).filter(([, , kind]) => kind === 'alongside');
    assert.deepEqual(alongside, [['Quillon · Step 1: the base', 'Fix the login bug', 'alongside']], 'Alt: the two work alongside');
    assert.equal(await canvas.locator('.react-flow__edge.canvas-edge-alongside .canvas-chevron').count(), 0, 'no arrows on a two-way wire');
    await dragTo(canvas.locator('.react-flow__node-mother'), 'source', finisher);
    await canvas.getByText(/The Mother starts every agent that waits for no one/).waitFor();
    // The wire's menu turns a two-way wire one-way, and back.
    const twoWay = canvas.locator('.react-flow__edge.canvas-edge-alongside .react-flow__edge-path');
    // Clicked where the wire shows, as a hand would: the first point along it that no agent covers.
    const mid = await twoWay.evaluate(path => { const m = path.getScreenCTM(); for (let step = 1; step < 20; step++) { const at = path.getPointAtLength(path.getTotalLength() * step / 20), x = at.x * m.a + at.y * m.c + m.e, y = at.x * m.b + at.y * m.d + m.f; if (document.elementFromPoint(x, y)?.closest('.react-flow__edge') === path.closest('.react-flow__edge')) return { x, y }; } return null; });
    assert.ok(mid, 'part of the two-way wire shows');
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await canvas.getByRole('menu', { name: 'Wire', exact: true }).getByRole('menuitem', { name: /^Make it one-way/ }).click();
    await page.waitForTimeout(450);
    assert.equal((await edgesNow()).filter(([, , kind]) => kind === 'alongside').length, 0, 'now one-way');

    // Both quick-create buttons add a successor linked only from this agent, with its prompt focused and name
    // following the prompt. Nothing lands on anything.
    await fit();
    await node('Finish it').hover();
    await node('Finish it').getByRole('button', { name: 'Add the next agent after Finish it' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Prompt');
    await page.keyboard.type('Write the release notes');
    await node('Write the release notes').waitFor();
    assert.ok((await edgesNow()).some(([a, b]) => a === 'Finish it' && b.endsWith(' · Write the release notes')), 'the next agent waits for it');
    await node('Write the release notes').hover();
    await node('Write the release notes').getByRole('button', { name: /^Add an agent after .* · Write the release notes$/ }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Prompt' && !document.activeElement.value);
    await page.keyboard.type('Update the changelog');
    await node('Update the changelog').waitFor();
    assert.ok((await edgesNow()).some(([a, b]) => a.endsWith(' · Write the release notes') && b.endsWith(' · Update the changelog')), 'the bottom + makes a successor too');
    // Adding after an agent that already feeds others preserves its outputs without copying them.
    await fit(); await node('Quillon · Step 1: the base').first().hover();
    await node('Quillon · Step 1: the base').first().getByRole('button', { name: 'Add an agent after Quillon · Step 1: the base' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Prompt' && !document.activeElement.value);
    await page.keyboard.type('Second base');
    await node('Second base').waitFor();
    assert.deepEqual((await edgesNow()).filter(([a, b]) => a.endsWith(' · Second base') || b.endsWith(' · Second base')), [['Quillon · Step 1: the base', (await titles()).find(title => title.endsWith(' · Second base')), 'waits']], 'only the clicked agent feeds the successor');
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await page.waitForTimeout(450);
    const overlaps = await canvas.locator('.react-flow__node-agent, .react-flow__node-note, .react-flow__node-mother').evaluateAll(list => { const boxes = list.map(item => item.getBoundingClientRect()); let count = 0; boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => { if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) count++; })); return count; });
    assert.equal(overlaps, 0, 'no agent or note lies on another');

    // Colour means state, as on Deus Ex's board: in the dark theme too, an idle wire and the selection outline are a
    // neutral grey, never the theme's gold.
    await page.evaluate(() => localStorage.setItem('elpis-theme', 'dark')); await page.reload();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    await node('Quillon · Step 1: the base').first().click();
    // How colourful a computed colour is, 0 to 1: oklch's chroma (×5) or rgb's saturation.
    const saturation = color => { const values = color.match(/[\d.]+/g).map(Number); if (color.startsWith('oklch')) return values[1] * 5; const [r, g, b] = values.slice(0, 3).map(value => value / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2; return max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1)); };
    const idleWire = await wires.first().locator('.react-flow__edge-path').evaluate(path => getComputedStyle(path).stroke);
    const outline = await canvas.locator('.react-flow__node.selected .agent-node').first().evaluate(item => getComputedStyle(item).outlineColor);
    assert.ok(saturation(idleWire) < 0.2, `an idle wire is ${idleWire}`);
    assert.ok(saturation(outline) < 0.2, `the selection outline is ${outline}`);

    // With no project chosen, Run graph says so and offers the project menu right in its message.
    await page.evaluate(() => localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [], selectedId: null }))); await page.reload();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const alert = canvas.getByRole('alert').filter({ hasText: 'Choose the project the agents work in, then run again.' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /project/i);
    assert.ok(await alert.locator('button').count() >= 1, 'the project menu sits in the message');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

for (const colorScheme of ['light', 'dark']) test(`workflow pattern explicitly chooses Auto or preserves the selected manual pattern (${colorScheme})`, async () => {
  const f = await openCanvas({ desktop: true });
  const selector = () => f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
  const pick = async label => { await selector().click(); await f.page.getByRole('option', { name: label, exact: true }).click(); };
  try {
    if (colorScheme === 'dark') await chooseTheme(f.page, 'dark');
    assert.equal(await selector().getAttribute('data-value'), 'auto');
    await pick('Sequential');
    const request = f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Review the project and report the next steps.');
    const manualPlanned = f.page.waitForResponse(response => response.url().endsWith('/api/canvas/plan') && response.request().method() === 'POST');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click(); await manualPlanned;
    const selected = f.plans.at(-1);
    assert.ok(selected.agents.length > 1, 'manual selection supplies its team rather than an empty automatic request');
    assert.ok(selected.goal.includes('Review the project and report the next steps.'));
    assert.ok(selected.goal.includes('pattern exactly'));
    assert.equal(selected.agents.filter(agent => !agent.waitsFor.length).length, 1, 'the sequential pattern starts with one agent');
    assert.ok(selected.agents.every(agent => agent.waitsFor.length <= 1));
    let saved = await f.saved();
    assert.equal(saved.planningPattern, 'sequential');
    const byId = new Map(selected.agents.map(agent => [agent.key, agent.waitsFor]));
    for (const node of saved.nodes.filter(node => node.type === 'agent')) assert.deepEqual(saved.edges.filter(edge => edge.target === node.id && edge.source !== 'mother').map(edge => edge.source).sort(), [...byId.get(node.id)].sort());
    await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    assert.equal(await selector().getAttribute('data-value'), 'sequential', 'manual selection stays available after planning, renaming and reload');
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Keep my chosen sequence');
    const beforeRefusal = await f.saved();
    await f.page.route('**/api/canvas/plan', async route => {
      const changed = planFor(route.request().postDataJSON());
      changed.agents[1].waitsFor = [];
      await route.fulfill({ json: changed });
    });
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.canvas.getByRole('alert').filter({ hasText: 'Elpis changed the selected pattern.' }).waitFor();
    assert.deepEqual(await f.saved(), beforeRefusal, 'a redesigned dependency cannot replace the chosen manual pattern');
    await f.page.unroute('**/api/canvas/plan');
    await pick('Auto · Elpis chooses');
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Fix the parser');
    const planned = f.page.waitForResponse(response => response.url().endsWith('/api/canvas/plan') && response.request().method() === 'POST');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click(); await planned;
    assert.deepEqual(f.plans.at(-1).agents, [], 'Auto starts from the task, without carrying over the manual team');
    saved = await f.saved(); assert.equal(saved.planningPattern, 'auto');
    assert.equal(f.runs.length, 0, 'choosing/designing never runs the team before an explicit Run');
    await captureReview(f.page, `workflow-auto-manual-${colorScheme}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 27 Oct: scrolling in Workflows moved the whole window up, leaving an empty band at the bottom. The page itself never
// scrolls, even when something placed on it (a popover, a hint) reaches past the window's bottom.
test('scrolling over Workflows never scrolls the whole page', async () => {
  const f = await fixture({ width: 1440, height: 900 });
  try {
    const { page } = f;
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.locator('.react-flow').waitFor();
    await page.evaluate(() => { const tall = document.createElement('div'); tall.style.cssText = 'position:absolute;top:0;left:0;width:4px;height:1300px'; document.body.append(tall); });
    for (const [x, y] of [[1300, 300], [900, 500], [150, 400]]) { await page.mouse.move(x, y); await page.mouse.wheel(0, 900); await page.waitForTimeout(200); }
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, 'the window content stays in place');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// SPEC.md, 23 October: the isometric view was removed (R38, R57); the flat board is the only board.
test('the Workflows page has no Flat/Isometric toggle', async () => {
  const { page, canvas, errors, close } = await openCanvas();
  try {
    await page.locator('.react-flow').waitFor();
    assert.equal(await canvas.locator('.react-flow').count(), 1, 'the flat board is shown');
    assert.equal(await page.getByRole('radio', { name: 'Isometric' }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: 'Flat' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

// 28 Oct (arch-drawer, filming for Masih): "Ctrl+click on agent nodes does not multi-select, so the shared Model menu
// cannot put a team on one model." Ctrl+click adds an agent to the selection, a second Ctrl+click takes it out again,
// and the selected team shares one Model menu.
test('Ctrl+click picks several agents, and their shared Model menu puts the team on one model', async () => {
  const f = await openCanvas();
  try {
    const node = title => f.canvas.locator('.react-flow__node-agent').filter({ hasText: title }).first();
    const selected = f.canvas.locator('.react-flow__node-agent.selected');
    await node('Part 1').click(); await node('Part 2').click({ modifiers: ['Control'] }); await node('Part 3').click({ modifiers: ['Control'] });
    assert.equal(await selected.count(), 3, 'three agents picked');
    await node('Part 3').click({ modifiers: ['Control'] });
    assert.equal(await selected.count(), 2, 'a second Ctrl+click takes one out');
    const group = f.canvas.getByRole('complementary', { name: 'Selected agents', exact: true });
    await group.getByText(/^2 agents selected$/i).waitFor();
    await chooseOption(group.getByRole('combobox', { name: 'Model', exact: true }), '|gpt-6.1-sol');
    await f.page.waitForTimeout(400);
    const models = (await f.saved()).nodes.filter(n => n.type === 'agent' && /Part [12]/.test(n.data.title)).map(n => n.data.model);
    assert.deepEqual(models, ['gpt-6.1-sol', 'gpt-6.1-sol']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
