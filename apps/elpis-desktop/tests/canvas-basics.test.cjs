// The basics every node editor has (Blender, ComfyUI, Resolve, Node-RED, Slate; lat.md/tasks.md, 17 October 2026):
// undo and redo, copy and paste with the wires among the copies, duplicate, delete keeping the flow, right-click
// menus on agents, the board and wires, F2 to rename, and Home to fit the whole graph.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas, planFor } = require('./canvas-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { captureReview, chooseOption, chooseTheme } = require('./controls.cjs');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const reportPlan = body => ({ name: 'Harbor review', agents: [{ key: 'evidence', title: 'Review evidence', prompt: body.goal, folders: [], doneWhen: ['Return the observed findings'], waitsFor: [] }] });

for (const colorScheme of ['light']) test(`workflows start in their sandbox without a project and keep reports scoped (${colorScheme})`, async () => {
  const sandbox = '/tmp/elpis-workflow-sandbox';
  const root = { id: 'sandbox-root', name: 'Harbor review', cwd: sandbox, status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
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
    const goal = 'Review Harbor and tell me the next three steps.';
    await request.fill(goal);
    await canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-agent').length === 1);
    const plan = f.posts.find(post => post.path === '/api/canvas/plan');
    assert.equal(plan.body.cwd, sandbox); assert.equal(plan.body.goal, goal); assert.deepEqual(plan.body.agents, []);
    const sent = page.waitForResponse(response => response.url().endsWith('/api/workflows/run') && response.request().method() === 'POST');
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click(); await sent;
    assert.equal(f.posts.find(post => post.path === '/api/threads').body.cwd, sandbox);
    const run = f.posts.find(post => post.path === '/api/workflows/run').body;
    // The session's agents-at-once limit: Elpis's default 6 when settings name none (components/agents-canvas.tsx `allowed`).
    assert.equal(run.maxConcurrency, 6); assert.equal(run.isolation, undefined);
    assert.ok(run.tasks.every(task => task.writeScopes.length === 1 && task.writeScopes[0].startsWith('agents/')), 'review tasks write only their own report/check folders');
    assert.equal(await request.inputValue(), goal);
    assert.equal(f.posts.filter(post => post.path === '/api/workflows/workspace').length, 1);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-sandbox-${colorScheme}.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('choosing a workflow project stays on the board, preserves its request and can return to the sandbox', async () => {
  const sandbox = '/tmp/elpis-workflow-sandbox', project = { id: 'harbor', name: 'Harbor', cwd: '/tmp/harbor' };
  const f = await fixture({ cwd: '', storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [project], selectedId: null }),
  }, routes: { '/api/workflows/workspace': () => ({ cwd: sandbox }), '/api/folders': () => ({ data: [] }), '/api/canvas/plan': reportPlan } });
  try {
    const { page } = f; await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Keep this exact review request.');
    await canvas.getByRole('button', { name: 'Choose project', exact: true }).click();
    await page.getByRole('menuitem', { name: /Harbor/ }).click();
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

// 29 Oct, Masih: "similar to autocad design where I could press space and then pick a number and it would create my agents that
// way - space again, pick another number". The number acts at once: an empty board gets that pattern's team, a team is rewired.
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
    for (const theme of ['light']) for (const width of [1440, 960]) {
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

for (const colorScheme of ['light']) test(`workflow pattern explicitly chooses Auto or preserves the selected manual pattern (${colorScheme})`, async () => {
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
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-auto-manual-${colorScheme}.png` });
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
    await chooseOption(group.getByRole('combobox', { name: 'Model', exact: true }), 'openai|gpt-6.1-sol');
    await f.page.waitForTimeout(400);
    const models = (await f.saved()).nodes.filter(n => n.type === 'agent' && /Part [12]/.test(n.data.title)).map(n => n.data.model);
    assert.deepEqual(models, ['gpt-6.1-sol', 'gpt-6.1-sol']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct, Masih: Mother as a parent who does a simple request herself and splits a complex one; the planner decides in
// its one call and says why, and New workflow shows that reason. A plan with no reason adds no notice.
for (const [planned, said] of [[{ mode: 'direct', why: 'One file, one line: no team needed.' }, 'One agent does it: One file, one line: no team needed.'],
  [{ mode: 'team', why: 'Two independent parts.' }, 'A team of 2: Two independent parts.'], [{}, null]]) test(`New workflow ${said ? `says "${said.split(':')[0]}"` : 'adds no notice without a reason'}`, async () => {
  const f = await openCanvas({ planned });
  try {
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Write hello.txt from scratch');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.request ?? '').includes('hello.txt'));
    await f.page.waitForTimeout(400);
    if (said) await f.canvas.getByText(said, { exact: true }).waitFor();
    else assert.equal(await f.canvas.getByText(/^(One agent does it|A team of \d+):/).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a started workflow opens its Mother agent chat in a background tab and leaves New workflow usable', async () => {
  const saved = { name: 'Background run', request: 'Keep the board available.', workflowId: 'background-run', nodes: [
    { id: 'writer', type: 'agent', position: { x: 300, y: 0 }, data: { title: 'Writer', instruction: 'Return one short report.', model: null, provider: null, effort: null, writeScopes: [], acceptanceCriteria: ['A report is returned'] } },
  ], edges: [] };
  const f = await openCanvas({ desktop: true, graph: saved, listed: run => ({ id: run.graphId, rootThreadId: run.rootThreadId, name: run.name, status: 'running', tasks: run.tasks.map(task => ({ id: task.id, title: task.title, status: 'running', assignedThreadId: null })) }) });
  try {
    const { page, canvas } = f;
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-chat-tabs-v1')));
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-chat-tabs-v1') || '{"tabs":[]}').tabs.some(tab => tab.threadId === 'chat-1'));
    assert.equal(await canvas.getByRole('button', { name: 'New workflow', exact: true }).isEnabled(), true, 'the board remains ready for the next workflow');
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-chat-tabs-v1')));
    assert.equal(after.activeId, before.activeId, 'the running workflow does not take the board away');
    assert.equal(after.tabs.filter(tab => tab.threadId === 'chat-1').length, 1, 'the Mother agent chat gets one background tab');
    if (process.env.ELPIS_SHOTS) {
      await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-run-tab-light.png` });
      await chooseTheme(page, 'dark');
      await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-run-tab-dark.png` });
      await chooseTheme(page, 'light');
    }
    await canvas.getByRole('button', { name: 'Open run chat', exact: true }).click();
    const strip = page.getByRole('tablist', { name: 'Chat tabs', exact: true });
    await strip.getByRole('tab', { name: saved.name, exact: true }).waitFor();
    assert.equal(await strip.getByRole('tab').count(), before.tabs.length + 1, 'opening the run activates its existing tab instead of replacing or duplicating one');
    if (process.env.ELPIS_SHOTS) {
      await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-run-chat-light.png` });
      await chooseTheme(page, 'dark');
      await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/workflow-run-chat-dark.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
