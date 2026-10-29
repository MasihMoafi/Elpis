// S18, Masih 29 Oct: "those extra useless chats like the ones saying Task ID ... or chats I didn't start should not show in
// my side-bar chats. I want that place to be organized". Pinned, Projects, Groups and Recents list only his own chats. Workflow
// runs keep the Workflows section and agent runs (codex exec, including the "Task ID …" chats), orphaned agents and chats whose
// maker is not listed sit in Background runs; both follow their switches, off by default. Nothing is lost or deleted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const spawn = parent => ({ subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: null, agent_nickname: 'Ampere', agent_role: null } } });
const chats = [
  { id: 'own-named', name: 'Fix the parser', preview: 'Fix the parser', source: 'vscode', updatedAt: 90 },
  { id: 'own-unnamed', name: null, preview: 'Plan the trip', source: 'vscode', updatedAt: 80 },
  { id: 'task', name: null, preview: 'Task ID: VOICE-RA-1 (spec and feasibility only)', source: 'exec', updatedAt: 70 },
  { id: 'exec-run', name: 'Worker', preview: 'Count the TODOs', source: 'exec', updatedAt: 60 },
  { id: 'sub-agent', name: null, preview: 'Check the parser', source: spawn('own-named'), parentThreadId: 'own-named', agentNickname: 'Ampere', updatedAt: 50 },
  { id: 'orphan-agent', name: null, preview: 'Review the diff', source: spawn('gone'), parentThreadId: 'gone', agentNickname: 'Banach', updatedAt: 40 },
  { id: 'made-by-chat', name: 'Made by another chat', preview: 'Draft the README', source: 'vscode', parentThreadId: 'gone-maker', updatedAt: 30 },
  { id: 'workflow-run', name: 'Workflows · Logo', preview: 'Make a logo', source: 'vscode', updatedAt: 20 },
].map(chat => ({ cwd: CWD, status: { type: 'idle' }, ...chat }));
const OWN = ['own-named', 'own-unnamed'];

const open = (preferences = {}) => fixture({ threads: chats, readyThreadId: 'own-named', storage: {
  'elpis-sidebar-folds-v1': JSON.stringify({ sections: { workflows: false }, projects: {} }), ...(Object.keys(preferences).length ? { 'elpis-preferences-v1': JSON.stringify(preferences) } : {}) }, routes: {
  '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : chats, nextCursor: null }),
  ...Object.fromEntries(chats.map(thread => [`/api/threads/${thread.id}`, () => ({ thread, data: [], nextCursor: null })])),
} });
const rows = locator => locator.locator('.thread-row[data-thread-id]').evaluateAll(items => [...new Set(items.map(row => row.dataset.threadId))].sort());

test('by default the sidebar lists only the chats Masih started; agents, task runs, made chats and workflow runs stay out', async () => {
  const f = await open();
  try {
    const sidebar = f.page.locator('aside.sidebar');
    await sidebar.locator('.thread-row[data-thread-id="own-unnamed"]').waitFor();
    const listed = await sidebar.locator('.thread-row[data-thread-id]').evaluateAll(rows => rows.map(row => row.dataset.threadId));
    assert.deepEqual([...new Set(listed)].sort(), OWN, 'only his own chats are rows');
    for (const selector of ['section[aria-label="Background runs"]', 'section[aria-label="Workflows"]', '[aria-label="Agents whose parent is not listed"]'])
      assert.equal(await sidebar.locator(selector).count(), 0, `nothing matches ${selector}`);
    assert.deepEqual(f.posts.filter(post => /archive|delete|trash/.test(post.path)), [], 'a display rule: nothing is archived or deleted');
  } finally { await f.close(); }
});

test('with their switches on, workflow runs show in Workflows and every other chat he did not start in Background runs, never in Recents', async () => {
  const f = await open({ showAgentRuns: true, sidebarWorkflows: true });
  try {
    const sidebar = f.page.locator('aside.sidebar');
    await sidebar.locator('section[aria-label="Workflows"] .thread-row[data-thread-id="workflow-run"]').waitFor();
    assert.deepEqual(await rows(sidebar.locator('section[aria-label="Recents"]')), OWN);
    await sidebar.getByRole('button', { name: 'Agent runs (4)', exact: true }).click();
    assert.deepEqual(await rows(sidebar.getByRole('region', { name: 'Agent runs', exact: true })), ['exec-run', 'made-by-chat', 'orphan-agent', 'task']);
    assert.equal(await sidebar.locator('[aria-label="Agents whose parent is not listed"]').count(), 0, 'no separate list of loose agents');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
