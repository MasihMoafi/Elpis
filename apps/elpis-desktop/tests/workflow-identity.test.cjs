const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { captureReview, chooseTheme, openSettings, leaveSettings } = require('./controls.cjs');

const runs = ['Fix a bug', 'Fix a bug', 'Research pricing', 'Ship exporter'].map((name, i) => ({
  id: `run-${i}`, rootThreadId: i ? `root-${i}` : 'chat-a', name, status: i < 2 ? 'running' : 'succeeded', startedAt: 100 + i,
  tasks: ['Inspect', 'Build', 'Review'].map((title, j) => ({ id: `step-${j}`, title, assignedThreadId: `step-${i}-${j}`, status: i < 2 ? 'running' : 'succeeded' })),
}));
const base = (id, name, active = false) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: active ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const graph = { workflowId: 'run-0', name: 'Fix a bug', nodes: [{ id: 'mother', type: 'mother', position: { x: 0, y: 0 }, data: {} }, { id: 'writer', type: 'agent', position: { x: 400, y: 0 }, data: { title: 'Build', instruction: 'Return the requested evidence.', model: null, writeScopes: ['.'], acceptanceCriteria: ['Return evidence'] } }], edges: [] };
const open = async (colorScheme, savedRuns = runs, state = {}, names = {}, routes = {}, models = {}) => {
  const listed = [...new Map(savedRuns.flatMap(run => [base(run.rootThreadId, run.name), ...(run.tasks ?? []).filter(task => typeof task.assignedThreadId === 'string' && task.assignedThreadId).map(task => base(task.assignedThreadId, `Workflows · ${task.title}`, task.status === 'running')), ...(run.mother?.sessionId ? [base(run.mother.sessionId, 'Workflows · Mother')] : []), ...(run.tasks ?? []).flatMap(task => (task.threads ?? []).map(id => base(id, `Workflows · ${task.title}`))), ...(run.mother?.threads ?? []).map(id => base(id, 'Workflows · Mother'))]).map(thread => [thread.id, thread])).values()].map(thread => ({ ...thread, name: names[thread.id] ?? thread.name, model: models[thread.id] ?? thread.model }));
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, threads: listed,
  // The fixture waits for chat-a, a workflow here, so the Workflows section is open (it starts folded: sidebar-organize.runtime.mjs).
  storage: { 'elpis-sidebar-folds-v1': JSON.stringify({ sections: { workflows: false }, projects: {} }), 'elpis-workflow-draft-v1': JSON.stringify(graph), 'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p', name: 'Fixture', cwd: CWD }], selectedId: 'p' }), ...state },
  routes: { '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : listed, nextCursor: null }), '/api/workflows/history': () => ({ data: savedRuns }), '/api/folders': () => ({ data: [] }), '/api/workflows': () => ({ data: [] }), ...routes } });
  return f;
};
const sidebar = page => page.locator('aside.sidebar');
const workflows = page => sidebar(page).locator('section[aria-label="Workflows"]');
const row = (page, id) => sidebar(page).locator(`.thread-row[data-thread-id="${id}"]`);
const markColor = locator => locator.evaluate(el => getComputedStyle(el).backgroundColor);
async function eventually(check) { const deadline = Date.now() + 5000; for (;;) { try { return await check(); } catch (e) { if (Date.now() > deadline) throw e; await new Promise(resolve => setTimeout(resolve, 40)); } } }
async function shot(page, name) { const dir = process.env.ELPIS_PARITY_SHOTS || path.join(os.homedir(), '.cache/elpis-shots'); await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `wfident-${name}.png`) }); }

for (const colorScheme of ['light', 'dark']) test(`workflow history keeps running work visible, reports a failed Remove and restores with Undo (${colorScheme})`, async () => {
  const saved = [{ ...runs[0], removable: false, removalReason: 'Finish this workflow before removing it from history.' }, { ...runs[2], removable: true }];
  const removed = []; let refuse = true;
  const f = await open(colorScheme, saved, {}, {}, {
    '/api/workflows/history': () => ({ data: saved.filter(run => !removed.includes(run.id)), canUndo: removed.length > 0 }),
    '/api/workflows/history/run-2/remove': () => { if (refuse) return { __http: 503, error: 'Could not save workflow history. Nothing was removed.' }; removed.push('run-2'); return { removed: 'run-2', canUndo: true }; },
    '/api/workflows/history/undo': () => ({ restored: removed.pop(), canUndo: removed.length > 0 }),
  });
  const { page } = f;
  const show = async () => { await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click(); await page.getByRole('button', { name: 'History', exact: true }).click(); return page.getByRole('region', { name: 'Workflow history', exact: true }); };
  try {
    let history = await show();
    const active = history.locator('li').filter({ hasText: 'Fix a bug' });
    await active.getByRole('button', { name: /Remove .* from history/ }).waitFor();
    assert.equal(await active.getByRole('button', { name: /Remove .* from history/ }).isDisabled(), true);
    assert.match(await active.innerText(), /Finish this workflow/);
    await assertUiFit(history, 'history actions and running-work reason fit');
    const finished = () => history.locator('li').filter({ hasText: 'Research pricing' });
    await finished().getByRole('button', { name: /Remove .* from history/ }).click();
    await history.getByRole('alert').filter({ hasText: 'Nothing was removed' }).waitFor();
    assert.equal(await finished().count(), 1, 'a failed persistence request keeps the entry');
    await assertUiFit(history, 'history persistence failure fits beside its actions');
    refuse = false;
    await finished().getByRole('button', { name: /Remove .* from history/ }).click();
    await eventually(async () => assert.equal(await finished().count(), 0));
    assert.equal(await active.count(), 1, 'removing history cannot hide ongoing work');
    await page.reload(); history = await show();
    assert.equal(await finished().count(), 0);
    await history.getByRole('button', { name: 'Undo history removal', exact: true }).click();
    await finished().waitFor();
    assert.equal(f.posts.some(post => /\/(?:archive|delete|interrupt|stop)$/.test(post.path)), false, 'Remove and Undo do not archive chats or stop work');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`four saved workflows have distinct names, one status indicator and twelve nested legacy step chats (${colorScheme})`, async () => {
  const f = await open(colorScheme), { page } = f;
  try {
    await eventually(async () => assert.equal(await workflows(page).locator('.thread-row:not(.child)').count(), 4));
    const names = await workflows(page).locator('.thread-row:not(.child) .thread-title').allTextContents();
    assert.equal(new Set(names).size, 4, 'legacy duplicate run names get distinct display names');
    assert.ok(names.includes('Fix a bug 2'));
    assert.equal(await workflows(page).locator('.workflow-mark').count(), 0, 'workflow names and their section identify them without extra coloured dots');
    assert.equal(await workflows(page).getByRole('button', { name: /^Colour for / }).count(), 0, 'manual colour belongs to the context menu, separate from runtime status');
    await sidebar(page).locator('section[aria-label="Projects"]').getByRole('button', { name: 'Projects', exact: true }).click();
    await page.mouse.move(800, 90);
    await shot(page, `sidebar-default-${colorScheme}`);
    await assertUiFit(sidebar(page), 'default workflow sidebar text fits');
    for (const run of runs) {
      const root = row(page, run.rootThreadId);
      assert.equal(await root.locator('.thread-dot[data-state="working"]').count(), run.status === 'running' ? 1 : 0);
      assert.equal(await row(page, run.tasks[0].assignedThreadId).count(), 0, 'Masih, 24 Oct: all chats must already be collapsed every time');
      await root.getByRole('button', { name: /^Expand / }).click();
    }
    assert.equal(await workflows(page).locator('.thread-row.child').count(), 12);
    for (const run of runs) for (const task of run.tasks) {
      assert.equal(await row(page, task.assignedThreadId).locator('.thread-title').innerText(), task.title, 'saved task title removes the Workflows prefix');
      assert.equal(await row(page, task.assignedThreadId).getAttribute('class').then(value => value.includes('child')), true);
      const parentX = await row(page, run.rootThreadId).locator('.thread-title').evaluate(el => el.getBoundingClientRect().x);
      const childX = await row(page, task.assignedThreadId).locator('.thread-title').evaluate(el => el.getBoundingClientRect().x);
      assert.ok(childX >= parentX + 12, 'step text visibly indents beyond its parent, without a duplicate colour control');
      assert.equal(await sidebar(page).locator(`[data-thread-id="${task.assignedThreadId}"]`).count(), 1, 'no flat duplicate');
    }
    await page.mouse.move(800, 90);
    await row(page, 'chat-a').scrollIntoViewIfNeeded();
    await shot(page, `sidebar-${colorScheme}`);
    await assertUiFit(sidebar(page), 'expanded workflow rows fit their containers');
    await row(page, 'chat-a').getByRole('button', { name: /^Collapse / }).click();
    assert.equal(await row(page, 'step-0-0').count(), 0);
    await row(page, 'chat-a').getByRole('button', { name: /^Expand / }).click();
    await row(page, 'step-0-0').locator('.thread-link').click();
    assert.equal(await page.locator('.workspace-header').innerText().then(text => text.includes('Workflows ·')), false);
    await page.getByLabel('Search conversations', { exact: true }).fill('Build');
    await eventually(async () => assert.equal(await sidebar(page).locator('section[aria-label="Results"] .thread-row').count(), 4));
    assert.equal(await sidebar(page).locator('section[aria-label="Results"] .thread-row.child').count(), 0, 'search stays flat');
    await page.reload();
    await eventually(async () => assert.equal(await workflows(page).locator('.thread-row:not(.child)').count(), 4));
    assert.deepEqual(await workflows(page).locator('.thread-row:not(.child) .thread-title').allTextContents(), names, 'identity survives reload');
    assert.equal(f.posts.some(post => /\/name$/.test(post.path)), false, 'legacy engine threads are never renamed');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct: a retried step's first chat and Mother's earlier review chats lay loose in Workflows ("currently they are all
// merged"): only the latest chat of each was linked to its run. Every chat a run opened folds under it.
// 28 Oct, Masih: "mother should be here", at the run's row, where her reviews sat under it as one more worker. The row is
// the Mother: it says so, with her model, and her reviews fold into it; a retried step's chats still sit under it.
// 28 Oct, Masih: "mothers all over the place ... wrong stuff", in the sidebar: every run row said Mother, and a run's checks
// were rows of their own in no order. A run's row says how it went, in the board's words; its steps follow in run order,
// a retried step's chats each once, every check folded into its step as Mother's reviews fold into the run's row.
test('a run row says how the run went; its steps follow in run order with their checks and Mother’s reviews folded in', async () => {
  const run = { ...runs[0], status: 'succeeded', tasks: [
    { id: 'build', title: 'Build', threads: ['build-0', 'build-1'], status: 'succeeded' },
    { id: 'build-check', kind: 'verify', dependsOn: ['build'], title: 'Check: Build', assignedThreadId: 'check-2', threads: ['check-1', 'check-2'], status: 'succeeded' },
    { id: 'join', title: 'Join', assignedThreadId: 'join-1', status: 'succeeded' },
    { id: 'join-check', kind: 'verify', dependsOn: ['join'], title: 'Check: Join', assignedThreadId: 'join-check-1', status: 'succeeded' }],
    mother: { assignedThreadId: 'mother-2', threads: ['mother-1', 'mother-2'] } };
  const f = await open('light', [run], {}, {}, {}, { [run.rootThreadId]: 'claude/opus', 'build-1': 'agy/gemini-3.8-flash-high' });
  try {
    const page = f.page, model = id => row(page, id).locator('.agent-model').innerText();
    assert.equal(await model(run.rootThreadId), '2 of 2 done', 'the run says how it went, not "Mother"');
    await row(page, run.rootThreadId).getByRole('button', { name: /^Expand / }).click();
    await row(page, 'join-1').waitFor();
    assert.deepEqual(await workflows(page).locator('.thread-row').evaluateAll(rows => rows.map(item => item.dataset.threadId)), [run.rootThreadId, 'build-0', 'build-1', 'join-1'],
      'its steps in run order (build-0 and build-1 are listed after join-1); no check or review is a row');
    assert.equal(await model('build-1'), 'Antigravity · gemini-3.8-flash-high', 'a subscription is named by its model, not the engine');
    await captureReview(page, 'workflow-run-rows');
    assert.equal(await workflows(page).locator('.thread-origin').count(), 0, 'the section names the origin: no row repeats "Workflows"');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct, Masih: "mothers all over the place". A run going on in another window told this one nothing, so its new step,
// check and Mother chats stayed loose here until a restart. A workflow chat no run claims, or a run still going, makes the
// sidebar read the runs again by itself.
test('a run moving on elsewhere reaches this sidebar by itself: its new step folds in and its row counts on', async () => {
  const early = { ...runs[0], tasks: [{ id: 'build', title: 'Build', assignedThreadId: 'step-0-0', status: 'running' }] };
  const final = { ...runs[0], status: 'succeeded', tasks: [{ ...early.tasks[0], status: 'succeeded' }, { id: 'join', title: 'Join', assignedThreadId: 'late-join', status: 'succeeded' }] };
  let reads = 0;
  const f = await open('light', [final], {}, {}, { '/api/workflows/history': () => ({ data: [reads++ ? final : early] }) });
  try {
    const page = f.page, root = row(page, final.rootThreadId);
    await eventually(async () => assert.equal(await root.locator('.agent-model').innerText(), '2 of 2 done'));
    assert.equal(await row(page, 'late-join').count(), 0, 'the new step is not loose');
    await root.getByRole('button', { name: /^Expand / }).click();
    assert.match(await row(page, 'late-join').getAttribute('class'), /child/, 'it sits under its run');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct, Masih: "I meant the workflows in the chat side bar" ("it should be able to hide"). Hidden, the section and its
// chats leave the sidebar (none spill into Recents) and stay hidden after a reload; Settings → General shows them again.
test('the Workflows section hides from the sidebar, stays hidden, and comes back from Settings', async () => {
  const f = await open('light');
  try {
    const page = f.page, recents = sidebar(page).locator('section[aria-label="Recents"]');
    await workflows(page).hover();
    await workflows(page).getByRole('button', { name: 'Hide Workflows from the sidebar', exact: true }).click();
    await workflows(page).waitFor({ state: 'detached' });
    for (const run of runs) assert.equal(await recents.locator(`[data-thread-id="${run.rootThreadId}"]`).count(), 0, 'a hidden workflow does not spill into Recents');
    await page.reload(); await sidebar(page).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await workflows(page).count(), 0, 'still hidden after a reload');
    await page.getByRole('button', { name: 'Workflows', exact: true }).first().waitFor();
    await openSettings(page, 'General');
    const show = page.getByRole('switch', { name: 'Show workflows in the sidebar', exact: true });
    assert.equal(await show.getAttribute('aria-checked'), 'false');
    await show.click();
    await leaveSettings(page);
    await workflows(page).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('two runs in one root chat stay separate and never borrow one another’s steps', async () => {
  const saved = [{ ...runs[0], status: 'succeeded', mother: { sessionId: 'review-old' }, tasks: [...runs[0].tasks, { id: 'bad', title: 'Ignore self membership', assignedThreadId: 'chat-a' }] }, { ...runs[1], rootThreadId: 'chat-a' }];
  const f = await open('light', saved), { page } = f;
  try {
    await eventually(async () => assert.equal(await workflows(page).locator('.thread-row:not(.child)').count(), 2));
    const old = workflows(page).locator('.thread-row[data-workflow-run="run-0"]');
    const latest = workflows(page).locator('.thread-row[data-workflow-run="run-1"]');
    await old.getByRole('button', { name: /^Expand / }).click();
    assert.equal(await row(page, 'step-0-0').count(), 1);
    assert.equal(await row(page, 'review-old').count(), 0, 'her saved review folds into its run’s row, never loose');
    await latest.getByRole('button', { name: /^Expand / }).click();
    await latest.getByRole('button', { name: /^Collapse / }).click();
    assert.equal(await row(page, 'step-1-0').count(), 0);
    assert.equal(await row(page, 'step-0-0').count(), 1, 'folding the latest run cannot hide a different run’s steps');
    await latest.getByRole('button', { name: /^Expand / }).click();
    f.emit('message', { method: 'thread/status/changed', params: { threadId: 'step-1-0', status: { type: 'idle' } } });
    await eventually(async () => assert.equal(await row(page, 'step-1-0').locator('.thread-dot[data-state="working"]').count(), 0));
    assert.equal(await latest.locator('.thread-dot[data-state="working"]').count(), 1, 'the run stays working while its own remaining siblings are active');
    saved[1].status = 'succeeded';
    for (const task of saved[1].tasks) {
      task.status = 'succeeded';
      f.emit('message', { method: 'thread/status/changed', params: { threadId: task.assignedThreadId, status: { type: 'idle' } } });
    }
    await eventually(async () => assert.equal(await latest.locator('.thread-dot[data-state="working"]').count(), 0));
    await eventually(async () => assert.equal(await row(page, 'step-1-0').count(), 0, 'completion folds even a manually expanded run'));
    assert.equal(await row(page, 'step-0-0').count(), 1, 'completion cannot fold another run');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('workflow names reject duplicates; canvas colour and separate sidebar names persist after duplication', async () => {
  const f = await open('light'), { page } = f;
  try {
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true }), name = canvas.getByRole('textbox', { name: 'Graph name', exact: true });
    await name.waitFor();
    await name.fill('Research pricing'); await name.press('Tab');
    await canvas.locator('.canvas-header').getByRole('alert').filter({ hasText: 'A workflow with this name already exists.' }).waitFor();
    await assertUiFit(canvas.locator('.canvas-header'), 'duplicate-name reason fits beside the field');
    await shot(page, 'name-refused-light');
    assert.equal(await row(page, 'chat-a').locator('.thread-title').innerText(), 'Fix a bug', 'refused rename keeps saved identity');
    await name.fill('Fix checkout'); await name.press('Enter');
    await eventually(async () => assert.equal(await row(page, 'chat-a').locator('.thread-title').innerText(), 'Fix checkout'));
    await canvas.getByRole('button', { name: 'Workflow colour', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Violet', exact: true }).click();
    const header = canvas.locator('.canvas-header .workflow-mark').first();
    const chosenColour = await markColor(header);
    assert.equal(await row(page, 'chat-a').locator('.workflow-mark').count(), 0, 'the canvas colour is not a duplicate sidebar dot');
    assert.equal(await markColor(canvas.locator('.mother-node .workflow-mark')), await markColor(header), 'Mother and header use the same mark');
    await page.keyboard.press('Escape');
    await assertUiFit(canvas.locator('.canvas-header'), 'identity controls fit');
    await shot(page, 'identity-light');
    await chooseTheme(page, 'dark');
    assert.equal(await markColor(canvas.locator('.mother-node .workflow-mark')), await markColor(header));
    await shot(page, 'identity-dark');
    assert.equal(await row(page, 'root-1').getByRole('button', { name: /^Colour for / }).count(), 0);
    await row(page, 'root-1').locator('.thread-actions').click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('alertdialog', { name: 'Rename conversation', exact: true });
    await rename.getByLabel('Conversation name', { exact: true }).fill('Research pricing');
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await rename.getByRole('alert').filter({ hasText: 'A workflow with this name already exists.' }).waitFor();
    await assertUiFit(rename, 'workflow rename refusal fits');
    await shot(page, 'name-refused-dark');
    await rename.getByLabel('Conversation name', { exact: true }).fill('Fix an import');
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    assert.equal(await row(page, 'root-1').locator('.thread-title').innerText(), 'Fix an import');
    await canvas.getByRole('button', { name: 'Duplicate workflow', exact: true }).click();
    await eventually(async () => assert.equal(await name.inputValue(), 'Fix checkout 2'));
    assert.notEqual(await markColor(canvas.locator('.canvas-header .workflow-mark').first()), chosenColour, 'the duplicated canvas gets its own intentional colour');
    await page.reload(); await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await eventually(async () => assert.equal(await name.inputValue(), 'Fix checkout 2'));
    assert.equal(await row(page, 'chat-a').locator('.thread-title').innerText(), 'Fix checkout');
    assert.equal(await row(page, 'root-1').locator('.thread-title').innerText(), 'Fix an import');
    assert.equal(await row(page, 'root-1').locator('.workflow-mark').count(), 0);
    await name.fill('Typed without leaving the field');
    await page.reload(); await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await eventually(async () => assert.equal(await name.inputValue(), 'Typed without leaving the field', 'workflow-name typing survives reload before blur'));
    const storedBefore = await page.evaluate(() => localStorage.getItem('elpis-workflow-identities-v1'));
    await page.evaluate(() => { const set = window.elpisDesktop.storage.setItem; window.elpisDesktop.storage.setItem = (key, value) => { if (key === 'elpis-workflow-identities-v1') throw Error('Identity write refused'); set(key, value); }; });
    await name.fill('Rejected disk rename'); await name.press('Enter');
    await canvas.locator('.canvas-header').getByRole('alert').filter({ hasText: 'Could not save workflow names and colours' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('elpis-workflow-identities-v1')), storedBefore, 'failed rename does not replace saved identities');
    assert.equal(await name.inputValue(), 'Rejected disk rename', 'a refused save does not discard typed text');
    assert.equal(f.posts.some(post => /\/name$/.test(post.path)), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a rename in the sidebar is no board edit: Ctrl+Z on the board undoes his mute and keeps the new name', async () => {
  const f = await open('light'), { page } = f;
  try {
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true }), name = canvas.getByRole('textbox', { name: 'Graph name', exact: true });
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')));
    const muted = async () => (await saved()).nodes.find(node => node.id === 'writer').data.muted;
    const off = () => page.evaluate(() => document.activeElement?.blur());
    await canvas.locator('.react-flow__node[data-id="writer"]').click(); await off(); await page.keyboard.press('m');
    await eventually(async () => assert.equal(await muted(), true));
    await row(page, 'chat-a').locator('.thread-actions').click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('alertdialog', { name: 'Rename conversation', exact: true });
    await rename.getByLabel('Conversation name', { exact: true }).fill('Fix checkout');
    await rename.getByRole('button', { name: 'Save', exact: true }).click(); await rename.waitFor({ state: 'detached' });
    await eventually(async () => assert.equal(await name.inputValue(), 'Fix checkout'));
    await off(); await page.keyboard.press('Control+z');
    await eventually(async () => assert.equal(await muted(), undefined, 'Ctrl+Z undoes the mute'));
    assert.equal((await saved()).name, 'Fix checkout'); assert.equal(await name.inputValue(), 'Fix checkout');
    assert.equal(await row(page, 'chat-a').locator('.thread-title').innerText(), 'Fix checkout');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('saved chat nesting keeps a workflow and its own collapse control visible', async () => {
  const saved = runs.map(run => run.id === 'run-2' ? { ...run, status: 'running' } : run);
  const f = await open('light', saved), { page } = f;
  try {
    // Restore after the fixture's initial chat-a readiness check: chat-a is now hidden inside a folded parent.
    await page.evaluate(() => localStorage.setItem('elpis-chat-groups-v1', JSON.stringify({ groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [], parents: { 'chat-a': 'root-2' } })));
    await page.reload();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await row(page, 'root-2').getByRole('button', { name: /^Expand / }).click();
    await row(page, 'chat-a').waitFor();
    assert.equal(await row(page, 'chat-a').getAttribute('class').then(value => value.includes('child')), true);
    assert.equal(await row(page, 'step-0-0').count(), 0, 'a nested workflow also starts folded');
    await row(page, 'chat-a').getByRole('button', { name: /^Expand / }).click();
    await row(page, 'step-0-0').waitFor();
    await row(page, 'chat-a').getByRole('button', { name: /^Collapse / }).click();
    assert.equal(await row(page, 'step-0-0').count(), 0, 'the workflow controls only its own descendants');
    assert.equal(await row(page, 'step-2-0').count(), 1, 'the containing chat keeps its own steps');
    await row(page, 'chat-a').getByRole('button', { name: /^Expand / }).click();
    assert.equal(await row(page, 'step-0-0').count(), 1);
    assert.equal(await row(page, 'chat-a').count(), 1, 'no hidden or duplicate workflow row');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a manually named step keeps its name while legacy names use recorded step titles', async () => {
  const f = await open('light', runs, {}, { 'step-0-0': 'Chosen step name' }), { page } = f;
  try {
    await row(page, 'chat-a').getByRole('button', { name: /^Expand / }).click();
    await eventually(async () => assert.equal(await row(page, 'step-0-0').locator('.thread-title').innerText(), 'Chosen step name'));
    assert.equal(await row(page, 'step-0-1').locator('.thread-title').innerText(), 'Build');
    assert.equal(f.posts.some(post => /\/name$/.test(post.path)), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('saved failed workflow opens its live team in chat and on the board without replacing the draft', async () => {
  const supervisionReport = 'Mother observed the source check and steered the current report toward verified evidence.';
  const saved = { id: 'legal-run', rootThreadId: 'chat-a', name: 'Legal current state', status: 'failed', startedAt: 100,
    mother: { decisions: [{ kind: 'checkpoint', taskId: 'evidence', decision: 'steer', status: 'delivered', summary: supervisionReport, reasons: 'The completed read lacked a source citation.' }] },
    tasks: [{ id: 'evidence', kind: 'research', title: 'Inspect Pointt evidence', instruction: 'Review the saved project evidence.', dependsOn: [], writeScopes: [], acceptanceCriteria: ['Return evidence'], assignedThreadId: 'legal-step', status: 'failed', failureReason: 'Weekly usage limit reached.', routing: { actual: { model: 'gpt-6-luna', provider: 'openai' } } },
      { id: 'synthesis', kind: 'research', title: 'Write next steps', instruction: 'Summarize the evidence.', dependsOn: ['evidence'], writeScopes: [], acceptanceCriteria: ['Return next steps'], assignedThreadId: 'legal-synthesis', status: 'failed', failureReason: 'Claude (ACP) error: You have hit your weekly limit.', model: 'requested-only-model' }] };
  const draft = { ...graph, name: 'Unfinished personal draft', workflowId: 'draft-kept' };
  const f = await open('light', [saved], { 'elpis-workflow-draft-v1': JSON.stringify(draft) }, {}, { '/api/workflows': () => ({ data: [saved] }), '/api/threads/chat-a': () => ({ thread: base('chat-a', saved.name), data: [], nextCursor: null }),
    '/api/threads/legal-step': () => ({ thread: { ...base('legal-step', 'Inspect Pointt evidence'), model: 'gpt-6-luna', parentThreadId: 'chat-a' }, data: [
      { turnId: 'evidence-turn', item: { id: 'evidence-command', type: 'commandExecution', command: 'rg --files lat.md', status: 'completed', aggregatedOutput: 'lat.md/tasks.md', exitCode: 0 } },
      { turnId: 'evidence-turn', item: { id: 'evidence-answer', type: 'agentMessage', text: 'Inspected the saved Pointt evidence.' } },
    ], nextCursor: null }) });
  try {
    const { page } = f;
    await row(page, 'chat-a').locator('.thread-link').click();
    await page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    const summary = page.getByRole('region', { name: 'Workflow run', exact: true });
    await summary.getByText('Inspect Pointt evidence', { exact: true }).waitFor();
    await summary.getByRole('status', { name: 'Mother supervision', exact: true }).getByText(supervisionReport, { exact: true }).waitFor();
    await summary.getByText('Weekly usage limit reached.', { exact: true }).waitFor();
    assert.equal(await page.getByText('This conversation has no messages yet.', { exact: true }).count(), 0);
    const savedTasks = summary.getByRole('list', { name: 'Saved workflow tasks', exact: true });
    const marks = await savedTasks.getByRole('img', { name: /^Agent mark / }).evaluateAll(items => items.map(item => item.getAttribute('aria-label')));
    assert.equal(marks.length, 2); assert.equal(new Set(marks).size, 2, 'different agents have distinct stable marks');
    await savedTasks.getByText('OpenAI · gpt-6-luna', { exact: true }).waitFor();
    const legacy = savedTasks.locator('li').filter({ has: page.getByText('Write next steps', { exact: true }) });
    await legacy.getByText('Claude (ACP) error: You have hit your weekly limit.', { exact: true }).waitFor();
    assert.equal(await legacy.locator('.agent-model').count(), 0, 'a historical failure without recorded routing never borrows the assigned chat’s current OpenAI model');
    assert.equal(await summary.getByText('requested-only-model', { exact: false }).count(), 0, 'a configured model is not presented as an observed actual model');
    await summary.getByRole('button', { name: 'Open Inspect Pointt evidence chat', exact: true }).click();
    await page.getByText('Inspected the saved Pointt evidence.', { exact: true }).waitFor();
    await page.locator('.activity-group > summary').click();
    await page.getByText('rg --files lat.md', { exact: true }).waitFor();
    const output = page.getByText('lat.md/tasks.md', { exact: true }); await output.waitFor();
    await page.locator('.activity-group .step > summary').click(); await output.waitFor({ state: 'hidden' });
    await page.locator('.activity-group .step > summary').click(); await output.waitFor();
    await row(page, 'chat-a').locator('.thread-link').click();
    await summary.getByText('Inspect Pointt evidence', { exact: true }).waitFor();
    assert.deepEqual(await savedTasks.getByRole('img', { name: /^Agent mark / }).evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), marks, 'opening an agent chat does not change its identity');

    await shot(page, 'workflow-live-team');
    const before = await page.evaluate(() => localStorage.getItem('elpis-workflow-draft-v1'));
    await summary.getByRole('button', { name: 'Open workflow canvas', exact: true }).click();
    const board = page.getByRole('region', { name: 'Workflows', exact: true });
    await board.locator('.react-flow__node[data-id="evidence"]').waitFor();
    await board.getByRole('status', { name: 'Mother supervision', exact: true }).getByText(supervisionReport, { exact: true }).waitFor();
    const previousAttempt = board.locator('details.canvas-log-panel[aria-label="Previous attempt"]');
    await previousAttempt.locator('summary').click();
    await board.getByRole('region', { name: 'Run clock', exact: true }).getByText('Duration not recorded', { exact: true }).waitFor();
    assert.equal(await board.getByRole('log', { name: 'Run log', exact: true }).locator('time').count(), 0, 'a saved task state is not assigned an invented observation timestamp');
    await previousAttempt.locator('summary').click();
    assert.match(await board.locator('.react-flow__node[data-id="evidence"]').innerText(), /Inspect Pointt evidence/);
    await shot(page, 'workflow-recorded-flat');
    await board.getByRole('status', { name: 'Mother supervision', exact: true }).getByText(supervisionReport, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('elpis-workflow-draft-v1')), before, 'viewing the actual saved run never overwrites an unfinished draft');
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workflow request', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')))).name, draft.name);
    assert.equal(f.posts.some(post => /^\/api\/workflows\/(?:run|(?:[^/]+\/)?(?:interrupt|cancel|resume))$/.test(post.path)), false, 'opening or leaving a run does not restart or stop it');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('failed workflow follows a resumed agent and paginated descendants without duplicate recovery', async () => {
  const saved = { id: 'observed-run', rootThreadId: 'chat-a', name: 'Observed team', status: 'failed', tasks: [
    { id: 'inspect', title: 'Inspect evidence', kind: 'research', assignedThreadId: 'observed-child', status: 'failed', failureReason: 'Previous attempt reached the weekly limit.', writeScopes: [], acceptanceCriteria: [], dependsOn: [] },
  ] };
  let working = true, rootHistoryReads = 0;
  const mother = () => base('chat-a', saved.name, working);
  const child = () => ({ ...base('observed-child', 'Evidence agent', working), parentThreadId: 'chat-a' });
  const helper = () => ({ ...base('observed-helper', 'Source checker', working), parentThreadId: 'observed-child' });
  const other = { ...base('other-run-child', 'Unrelated workflow worker', true), parentThreadId: 'other-root' };
  const f = await open('light', [saved], {}, {}, {
    '/api/workflows': () => ({ data: [saved] }),
    '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? url.searchParams.has('cursor') ? [helper(), other] : [child()] : [mother(), child()], nextCursor: url.searchParams.has('ancestorThreadId') && !url.searchParams.has('cursor') ? 'second-page' : null }),
    '/api/threads/chat-a': (_body, url) => { if (url.searchParams.get('limit') === '100') rootHistoryReads++; return { thread: mother(), data: [{ turnId: 'mother-turn', item: { id: 'mother-update', type: 'agentMessage', text: 'The evidence agent is checking the source material.' }, completedAtMs: 200 }], nextCursor: null }; },
    '/api/threads/observed-child': () => ({ thread: child(), data: [], nextCursor: null }),
    '/api/threads/observed-helper': () => ({ thread: helper(), data: [], nextCursor: null }),
  });
  try {
    const { page } = f;
    await row(page, 'chat-a').locator('.thread-link').click();
    const summary = page.getByRole('region', { name: 'Workflow run', exact: true });
    const progress = page.getByRole('region', { name: 'Live workflow progress', exact: true });
    await progress.getByText(/Live: 2 working/).waitFor();
    await progress.getByText('Mother', { exact: true }).waitFor();
    await progress.getByText('Source checker', { exact: true }).waitFor();
    await progress.getByText(/Mother: The evidence agent is checking/).waitFor();
    for (const colorScheme of ['light', 'dark']) {
      if (await sidebar(page).getByRole('button', { name: `Use ${colorScheme} theme`, exact: true }).count()) await chooseTheme(page, colorScheme);
      for (const width of [1440, 820]) {
        await page.setViewportSize({ width, height: 900 });
        const columns = await progress.locator('.workflow-progress-row').evaluateAll(rows => rows.map(row => {
          const status = row.querySelector('.workflow-progress-status').getBoundingClientRect(), open = row.querySelector('button').getBoundingClientRect(), identity = row.querySelector('.agent-identity').getBoundingClientRect();
          return { statusX: status.x, actionX: open.x, actionRight: open.right, identityRight: identity.right };
        }));
        assert.equal(columns.length, 3, 'Mother, child and nested child share the row layout');
        for (const column of columns) {
          assert.ok(Math.abs(column.statusX - columns[0].statusX) <= 1, `${colorScheme}/${width}: statuses share a column`);
          assert.ok(Math.abs(column.actionX - columns[0].actionX) <= 1 && Math.abs(column.actionRight - columns[0].actionRight) <= 1, `${colorScheme}/${width}: Open buttons share a column`);
          assert.ok(column.identityRight <= column.statusX, `${colorScheme}/${width}: identity fits before status`);
        }
      }
    }
    await chooseTheme(page, 'light'); await page.setViewportSize({ width: 1440, height: 900 });
    await eventually(async () => assert.ok(f.posts.some(post => post.path === '/api/threads/chat-a/resume')));
    const beforeOpen = { history: rootHistoryReads, resumes: f.posts.filter(post => post.path === '/api/threads/chat-a/resume').length };
    await f.composer.fill('Keep this unsent draft');
    for (const target of [progress.getByRole('button', { name: 'Open Mother chat', exact: true }), row(page, 'chat-a').locator('.thread-link')]) {
      await target.click(); await target.click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(rootHistoryReads, beforeOpen.history, 'opening the visible chat does not reload its history');
      assert.equal(f.posts.filter(post => post.path === '/api/threads/chat-a/resume').length, beforeOpen.resumes, 'opening the visible chat does not resume it again');
      assert.equal(await f.composer.inputValue(), 'Keep this unsent draft');
      assert.equal(await f.shown(), 'chat-a');
    }
    assert.equal(await progress.getByText('Unrelated workflow worker', { exact: true }).count(), 0, 'another run cannot enter this team');
    assert.equal(await summary.getByRole('button', { name: 'Resume workflow', exact: true }).isDisabled(), true, 'a resumed child prevents duplicate recovery');
    await shot(page, 'resumed-team-chat');
    await summary.getByRole('button', { name: 'Open workflow canvas', exact: true }).click();
    const board = page.getByRole('region', { name: 'Workflows', exact: true });
    await board.locator('.react-flow__node[data-id="live:observed-helper"]').waitFor();
    assert.equal(await board.locator('.mother-node[data-status="running"]').count(), 1, 'Mother shows the observed active root');
    assert.equal(await board.locator('.react-flow__node[data-id="inspect"] .agent-node').getAttribute('data-status'), 'running');
    const visibleHeight = locator => locator.evaluate(element => { const box = element.getBoundingClientRect(); return Math.min(innerHeight, box.bottom) - Math.max(0, box.top); });
    assert.ok(await visibleHeight(board.locator('.canvas-board > .react-flow')) >= 300, 'the actual flat canvas has at least 300 visible pixels');
    assert.equal(await board.locator('details.canvas-log-panel').getAttribute('open'), null, 'historical failure starts collapsed');
    await shot(page, 'resumed-team-flat');
    working = false;
    await board.getByRole('button', { name: 'Refresh live progress', exact: true }).click();
    await board.getByRole('region', { name: 'Live workflow progress', exact: true }).getByText(/Live: 0 working/).waitFor();
    assert.match(await board.locator('details.canvas-log-panel > summary').innerText(), /Previous attempt.*failed/, 'a live idle transition does not invent workflow success');
    assert.equal(f.posts.some(post => /^\/api\/workflows\/(?:run|[^/]+\/resume)$/.test(post.path)), false, 'viewing and refreshing never starts a model request');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('cancelled workflow offers explicit same-run recovery without replaying completed tasks', async () => {
  const saved = { id: 'cancelled-run', rootThreadId: 'chat-a', name: 'Interrupted evidence review', status: 'cancelled', tasks: [
    { id: 'done', title: 'Retained evidence', kind: 'research', status: 'succeeded', result: { summary: 'Observed completed evidence' }, dependsOn: [], writeScopes: [], acceptanceCriteria: [] },
    { id: 'interrupted', title: 'Interrupted summary', kind: 'research', status: 'cancelled', dependsOn: ['done'], writeScopes: [], acceptanceCriteria: [] },
  ] };
  const f = await open('light', [saved], {}, {}, {
    '/api/workflows': () => ({ data: [saved] }),
    '/api/threads/chat-a': () => ({ thread: base('chat-a', saved.name), data: [], nextCursor: null }),
    '/api/workflows/cancelled-run/resume': () => ({ graphId: saved.id, threadId: saved.rootThreadId }),
  });
  try {
    const { page } = f;
    await row(page, 'chat-a').locator('.thread-link').click();
    const summary = page.getByRole('region', { name: 'Workflow run', exact: true });
    await summary.getByRole('list', { name: 'Saved workflow tasks', exact: true }).locator('li').filter({ hasText: 'Retained evidence' }).locator('details > summary').click();
    await summary.getByText('Observed completed evidence', { exact: true }).waitFor();
    const resume = summary.getByRole('button', { name: 'Resume workflow', exact: true });
    await eventually(async () => assert.equal(await resume.isEnabled(), true));
    assert.equal(f.posts.some(post => /^\/api\/workflows\/[^/]+\/resume$/.test(post.path)), false, 'opening a stopped run cannot resume it');
    assert.equal(f.posts.some(post => /^\/api\/threads\/[^/]+\/(?:turns|steer)$/.test(post.path)), false, 'reading the retained history cannot start or steer a model turn');
    await resume.click();
    await eventually(async () => assert.equal(f.posts.filter(post => post.path === '/api/workflows/cancelled-run/resume').length, 1));
    assert.equal(f.posts.some(post => post.path === '/api/workflows/run'), false, 'recovery sends the retained identity rather than starting another workflow');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
