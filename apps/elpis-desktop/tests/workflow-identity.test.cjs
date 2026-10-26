const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { chooseTheme } = require('./controls.cjs');

const runs = ['Fix a bug', 'Fix a bug', 'Research pricing', 'Ship exporter'].map((name, i) => ({
  id: `run-${i}`, rootThreadId: i ? `root-${i}` : 'chat-a', name, status: i < 2 ? 'running' : 'succeeded', startedAt: 100 + i,
  tasks: ['Inspect', 'Build', 'Review'].map((title, j) => ({ id: `step-${j}`, title, assignedThreadId: `step-${i}-${j}`, status: i < 2 ? 'running' : 'succeeded' })),
}));
const base = (id, name, active = false) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: active ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const graph = { workflowId: 'run-0', name: 'Fix a bug', nodes: [{ id: 'mother', type: 'mother', position: { x: 0, y: 0 }, data: {} }, { id: 'writer', type: 'agent', position: { x: 400, y: 0 }, data: { title: 'Build', instruction: 'Return the requested evidence.', model: null, writeScopes: ['.'], acceptanceCriteria: ['Return evidence'] } }], edges: [] };
const open = async (colorScheme, savedRuns = runs, state = {}, names = {}, routes = {}) => {
  const listed = [...new Map(savedRuns.flatMap(run => [base(run.rootThreadId, run.name), ...(run.tasks ?? []).map(task => base(task.assignedThreadId, `Workflows · ${task.title}`, task.status === 'running')), ...(run.mother?.sessionId ? [base(run.mother.sessionId, 'Workflows · Mother')] : [])]).map(thread => [thread.id, thread])).values()].map(thread => ({ ...thread, name: names[thread.id] ?? thread.name }));
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

for (const colorScheme of ['light', 'dark']) test(`four saved workflows have distinct names/colours and twelve nested legacy step chats (${colorScheme})`, async () => {
  const f = await open(colorScheme), { page } = f;
  try {
    await eventually(async () => assert.equal(await workflows(page).locator('.thread-row:not(.child)').count(), 4));
    const names = await workflows(page).locator('.thread-row:not(.child) .thread-title').allTextContents();
    assert.equal(new Set(names).size, 4, 'legacy duplicate run names get distinct display names');
    assert.ok(names.includes('Fix a bug 2'));
    const colours = await workflows(page).locator('.thread-row:not(.child) .workflow-mark').evaluateAll(items => items.map(el => getComputedStyle(el).backgroundColor));
    assert.equal(new Set(colours).size, 4, 'automatic colours distinguish all four neighbours');
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
      assert.ok(childX >= parentX + 12, 'step text visibly indents beyond its parent, including the colour control');
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

test('two runs in one root chat stay separate and never borrow one another’s steps', async () => {
  const saved = [{ ...runs[0], status: 'succeeded', mother: { sessionId: 'review-old' }, tasks: [...runs[0].tasks, { id: 'bad', title: 'Ignore self membership', assignedThreadId: 'chat-a' }] }, { ...runs[1], rootThreadId: 'chat-a' }];
  const f = await open('light', saved), { page } = f;
  try {
    await eventually(async () => assert.equal(await workflows(page).locator('.thread-row:not(.child)').count(), 2));
    const old = workflows(page).locator('.thread-row[data-workflow-run="run-0"]');
    const latest = workflows(page).locator('.thread-row[data-workflow-run="run-1"]');
    await old.getByRole('button', { name: /^Expand / }).click();
    assert.equal(await row(page, 'step-0-0').count(), 1);
    assert.equal(await row(page, 'review-old').locator('.thread-title').innerText(), 'Mother', 'saved review chat belongs under its run too');
    await latest.getByRole('button', { name: /^Expand / }).click();
    await latest.getByRole('button', { name: /^Collapse / }).click();
    assert.equal(await row(page, 'step-1-0').count(), 0);
    assert.equal(await row(page, 'step-0-0').count(), 1, 'folding the latest run cannot hide a different run’s steps');
    await latest.getByRole('button', { name: /^Expand / }).click();
    saved[1].status = 'succeeded';
    f.emit('message', { method: 'thread/status/changed', params: { threadId: 'step-1-0', status: { type: 'idle' } } });
    await eventually(async () => assert.equal(await latest.locator('.thread-dot[data-state="working"]').count(), 0));
    await eventually(async () => assert.equal(await row(page, 'step-1-0').count(), 0, 'completion folds even a manually expanded run'));
    assert.equal(await row(page, 'step-0-0').count(), 1, 'completion cannot fold another run');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('workflow names reject duplicates beside the field; colour and duplication persist across header/Mother/sidebar', async () => {
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
    await eventually(async () => assert.equal(await markColor(row(page, 'chat-a').locator('.workflow-mark')), await markColor(header)));
    assert.equal(await markColor(canvas.locator('.mother-node .workflow-mark')), await markColor(header), 'Mother and header use the same mark');
    await page.keyboard.press('Escape');
    await assertUiFit(canvas.locator('.canvas-header'), 'identity controls fit');
    await shot(page, 'identity-light');
    await chooseTheme(page, 'dark');
    assert.equal(await markColor(canvas.locator('.mother-node .workflow-mark')), await markColor(header));
    await shot(page, 'identity-dark');
    await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    await canvas.getByRole('button', { name: 'Fit view', exact: true }).click();
    await page.waitForFunction(() => {
      const world = document.querySelector('.iso-world'), target = world?.transform.baseVal.consolidate()?.matrix;
      if (!target) return false;
      const drawn = new DOMMatrix(getComputedStyle(world).transform);
      return ['a', 'b', 'c', 'd', 'e', 'f'].every(key => Math.abs(drawn[key] - target[key]) < .01);
    });
    await eventually(async () => assert.equal(await markColor(canvas.locator('.iso-label[data-for="mother"] .workflow-mark')), await markColor(header)));
    await shot(page, 'identity-iso-dark');
    await canvas.getByRole('radio', { name: 'Flat', exact: true }).click();
    await row(page, 'root-1').getByRole('button', { name: 'Colour for Fix a bug 2', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Green', exact: true }).click();
    await page.keyboard.press('Escape');
    const otherColour = await markColor(row(page, 'root-1').locator('.workflow-mark'));
    assert.notEqual(otherColour, await markColor(header), 'recolouring another run leaves the current workflow alone');
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
    assert.notEqual(await markColor(canvas.locator('.canvas-header .workflow-mark').first()), await markColor(row(page, 'chat-a').locator('.workflow-mark')), 'duplicate gets its own colour');
    await page.reload(); await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await eventually(async () => assert.equal(await name.inputValue(), 'Fix checkout 2'));
    assert.equal(await row(page, 'chat-a').locator('.thread-title').innerText(), 'Fix checkout');
    assert.equal(await row(page, 'root-1').locator('.thread-title').innerText(), 'Fix an import');
    assert.equal(await markColor(row(page, 'root-1').locator('.workflow-mark')), otherColour);
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
