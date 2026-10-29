const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const notice = 'Run by an agent in the background; open its parent to talk to it';
const normal = (id, name) => ({ id, name, cwd: CWD, source: 'cli', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
async function mixed({ continueError = false, restoredRun = false, pagedChildren = false, nestedChildren = false, ...options } = {}) {
  const parent = normal('chat-a', 'Fix the parser'), own = normal('chat-b', 'Worker · my own chat');
  const run = { ...normal('exec-run', 'Worker · inspect'), source: 'exec', parentThreadId: parent.id, desktopAccess: { writable: false, mode: 'continue', canContinue: true, reason: notice } };
  const child = { ...run, id: 'child-run', name: 'Review the fix', source: { subAgent: { thread_spawn: { agent_path: '/root/review' } } }, status: { type: 'active' }, desktopAccess: { ...run.desktopAccess, canContinue: false } };
  const nested = { ...child, id: 'nested-run', name: 'Nested agent', parentThreadId: run.id };
  const orphan = { ...run, id: 'orphan-run', name: 'Unlinked background run', parentThreadId: null };
  const additional = { ...run, id: 'more-run', name: 'Another background task' };
  const continued = { ...normal('continued', 'Worker · inspect (continued)'), source: 'appServer', forkedFromId: run.id };
  const threads = [parent, own, run, child, orphan];
  const routes = { '/api/threads': (_body, url) => {
    if (!url.searchParams.has('ancestorThreadId')) return { data: threads, nextCursor: null };
    if (nestedChildren && url.searchParams.get('ancestorThreadId') === run.id) return { data: [nested], nextCursor: null };
    if (!pagedChildren || url.searchParams.get('ancestorThreadId') !== parent.id) return { data: [], nextCursor: null };
    return { data: url.searchParams.has('cursor') ? [additional] : [run], nextCursor: url.searchParams.has('cursor') ? null : 'child-page' };
  } };
  for (const thread of [parent, own, run, child, nested, orphan, continued, additional]) {
    routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [{ turnId: 'result', item: { id: 'result', type: 'agentMessage', text: 'Recorded background result.' } }], nextCursor: null });
    routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: thread.status.type === 'active' ? 'working' : null });
  }
  routes['/api/threads/exec-run/continue'] = () => { if (continueError) return { __http: 409, error: 'The engine cannot continue this run.' }; threads.push(continued); return { thread: continued }; };
  routes['/api/threads/continued/turns'] = () => ({ turn: { id: 'new-turn' } });
  // Project membership is explicit (TASKS.md:111): the two personal chats belong to the project.
  // S18, Masih 29 Oct: Background runs and the sidebar's Workflows section are off by default; these tests turn them on.
  const storage = { 'elpis-preferences-v1': JSON.stringify({ showAgentRuns: true, sidebarWorkflows: true }), 'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'parser', name: 'Parser project', cwd: CWD }], selectedId: null }), 'elpis-project-chats-v1': JSON.stringify({ 'chat-a': 'parser', 'chat-b': 'parser' }), 'elpis-pinned-chats-v1': JSON.stringify(['exec-run']), 'elpis-chat-attention-v1': JSON.stringify({ unread: ['exec-run', 'child-run'], plans: {} }) };
  if (restoredRun) storage['elpis-chat-tabs-v1'] = JSON.stringify({ tabs: [{ id: 'saved-tab', threadId: 'exec-run', title: 'Worker · inspect' }], activeId: 'saved-tab' });
  const f = await fixture({ ...options, routes, storage });
  return { ...f, run, child, threads };
}
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();
const expandParent = page => row(page, 'chat-a').getByRole('button', { name: 'Expand agents in Fix the parser', exact: true }).click();

test('mixed chats keep projects, pins, tabs and searches while linked agents fold under their parent and unlinked runs fold at the end', async () => {
  const f = await mixed(), { page } = f;
  try {
    const aside = page.locator('aside.sidebar');
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await row(page, 'chat-b').count(), 1, 'titles do not classify a chat as a run');
    assert.equal(await row(page, 'exec-run').count(), 0);
    assert.equal(await row(page, 'child-run').count(), 0);
    const project = aside.locator('.project-group').filter({ hasText: 'Parser project' });
    assert.equal(await project.locator('.thread-row').count(), 2, 'the collapsed parent keeps its agents out of the project root list');
    assert.equal(await aside.locator('section[aria-label="Pinned"] .thread-row').count(), 0, 'previously pinned agents stay under their parent without a duplicate row');
    const toggle = aside.getByRole('button', { name: 'Agent runs (1)', exact: true });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    f.emit('message', { method: 'turn/completed', params: { threadId: 'exec-run', turn: { id: 'done', status: 'completed' } } });
    await page.waitForTimeout(150);
    assert.equal(await aside.getByRole('button', { name: 'Mark all as read' }).count(), 0, 'run completions do not enter unread counts');
    f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-b', turn: { id: 'personal-reply', status: 'completed' } } });
    await aside.getByRole('button', { name: 'Mark all as read' }).click();
    await row(page, 'chat-b').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    assert.equal(await aside.locator('section[aria-label="Pinned"]').getByText('Worker · my own chat', { exact: true }).count(), 1);
    await row(page, 'chat-b').locator('.thread-link').click(); await f.composer.waitFor();
    await page.getByRole('tab', { name: /Worker · my own chat/ }).waitFor();
    await toggle.click();
    const group = aside.getByRole('region', { name: 'Agent runs', exact: true });
    await row(page, 'orphan-run').waitFor();
    assert.equal(await group.locator('.thread-row').count(), 1, 'only the unlinked run belongs to the background group');
    await expandParent(page);
    await row(page, 'exec-run').waitFor();
    assert.equal(await project.locator('.thread-row[data-thread-id="exec-run"]').count(), 1, 'the linked agent appears once under its project parent');
    assert.equal(await row(page, 'child-run').count(), 1);
    assert.equal(await row(page, 'exec-run').getByText('from Fix the parser', { exact: true }).count(), 1);
    await toggle.press('Enter');
    assert.equal(await row(page, 'orphan-run').count(), 0, 'keyboard folds the background group');
    assert.equal(await row(page, 'exec-run').count(), 1, 'the linked branch is independent of the background group');
    await row(page, 'chat-a').getByRole('button', { name: 'Collapse agents in Fix the parser', exact: true }).click();
    assert.equal(await row(page, 'exec-run').count(), 0, 'collapsing the parent hides its linked agents');
    const search = aside.getByRole('textbox', { name: /Search/ });
    await search.fill('Worker');
    await row(page, 'exec-run').waitFor();
    assert.equal(await row(page, 'chat-b').count(), 1);
    assert.equal(await row(page, 'exec-run').count(), 1, 'search finds a linked agent even when its parent is collapsed');
    assert.equal(await row(page, 'exec-run').getAttribute('data-depth'), '0', 'search results are flat rather than repeating the parent branch');
    assert.equal(await aside.getByRole('region', { name: 'Agent runs', exact: true }).count(), 0, 'search does not mix in the background group');
    await search.fill('');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command menu' });
    await dialog.getByRole('combobox').fill('Worker');
    await page.waitForTimeout(400);
    assert.equal(await dialog.getByText('Worker · inspect', { exact: true }).count(), 0);
    assert.equal(await dialog.getByText('Worker · my own chat', { exact: true }).count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a background run restored in a tab shows the read-only notice instead of the composer', async () => {
  const f = await mixed({ restoredRun: true }), { page } = f;
  try {
    await page.getByText('Recorded background result.', { exact: true }).waitFor();
    await page.getByText(notice, { exact: true }).waitFor();
    assert.equal(await f.composer.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Show agents opens the background group while child pagination belongs to the linked parent branch', async () => {
  const f = await mixed({ pagedChildren: true }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await row(page, 'chat-a').locator('.thread-link').click(); await f.composer.waitFor();
    await row(page, 'chat-a').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show agents', exact: true }).click();
    const group = page.getByRole('region', { name: 'Agent runs', exact: true });
    await group.getByText('Unlinked background run', { exact: true }).waitFor();
    await expandParent(page);
    const more = page.locator('aside.sidebar .project-group').getByRole('button', { name: 'More agents from Fix the parser', exact: true });
    await more.waitFor();
    await row(page, 'chat-a').getByRole('button', { name: 'Collapse agents in Fix the parser', exact: true }).click();
    assert.equal(await more.count(), 0, 'pagination folds with its parent branch');
    assert.equal(await page.locator('aside.sidebar').getByRole('button', { name: 'More agents', exact: true }).count(), 0);
    await expandParent(page); await more.click();
    await row(page, 'more-run').waitFor();
    assert.equal(await page.locator('aside.sidebar .thread-row[data-thread-id="more-run"]').count(), 1, 'the next page appears once in the parent branch');
    assert.equal(await row(page, 'more-run').getAttribute('data-depth'), '1');
    assert.equal(await page.getByRole('button', { name: 'Agent runs (1)', exact: true }).count(), 1, 'loading linked agents does not add them to the background group');
    assert.equal(await row(page, 'more-run').getByText('from Fix the parser', { exact: true }).isVisible(), true);
    await row(page, 'chat-a').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide agents', exact: true }).click();
    assert.equal(await group.count(), 0);
    assert.equal(await row(page, 'more-run').count(), 1, 'hiding the background group preserves the expanded parent branch');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a background run expands and collapses its nested agents', async () => {
  const f = await mixed({ nestedChildren: true }), { page } = f;
  try {
    await expandParent(page);
    const run = row(page, 'exec-run'), expand = run.getByRole('button', { name: 'Expand agents in Worker · inspect' });
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    await expand.click();
    const nestedRows = page.locator('aside.sidebar .thread-row[data-thread-id="nested-run"]');
    await nestedRows.first().waitFor();
    assert.equal(await nestedRows.count(), 1, 'the nested run is shown under its parent only');
    const collapse = run.getByRole('button', { name: 'Collapse agents in Worker · inspect' });
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
    await collapse.click();
    assert.equal(await nestedRows.count(), 0, 'collapsing hides nested agents');
    await run.getByRole('button', { name: 'Expand agents in Worker · inspect' }).focus();
    await page.keyboard.press('Enter');
    await nestedRows.first().waitFor();
    assert.equal(await nestedRows.count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`runs open read-only, parent navigation works and Continue here creates a writable chat (${colorScheme})`, async () => {
  const f = await mixed({ colorScheme, height: 950 }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await expandParent(page);
    await row(page, 'child-run').locator('.thread-link').click();
    await page.getByText(notice, { exact: true }).waitFor();
    assert.equal(await f.composer.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue here', exact: true }).count(), 0, 'a running agent cannot be continued');
    await page.keyboard.press('Escape');
    assert.equal(f.posts.filter(post => post.path.endsWith('/interrupt')).length, 0, 'read-only keyboard navigation cannot interrupt the run');
    await page.getByRole('button', { name: 'Open parent: Fix the parser', exact: true }).click();
    await f.composer.waitFor();
    await row(page, 'exec-run').locator('.thread-link').click();
    await page.getByText(notice, { exact: true }).waitFor();
    await page.getByText('Recorded background result.', { exact: true }).waitFor();
    assert.equal(await f.composer.count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Continue here' && !button.disabled));
    if (process.env.ELPIS_PARITY_SHOTS) {
      await fs.mkdir(process.env.ELPIS_PARITY_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `agent-runs-${colorScheme}.png`) });
    }
    await page.getByRole('button', { name: 'Continue here', exact: true }).click();
    await f.composer.waitFor();
    assert.equal(f.posts.filter(post => post.path === '/api/threads/exec-run/continue').length, 1);
    assert.equal(f.posts.filter(post => post.path.endsWith('/turns')).length, 0, 'continuing sends no message');
    await f.composer.fill('I can talk here'); await f.composer.press('Enter');
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(f.posts.filter(post => post.path === '/api/threads/exec-run/turns').length, 0);
    assert.equal(f.posts.filter(post => post.path === '/api/threads/continued/turns').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a refused continuation keeps the run read-only and shows the engine error', async () => {
  const f = await mixed({ continueError: true }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await expandParent(page);
    await row(page, 'exec-run').locator('.thread-link').click();
    await page.getByRole('button', { name: 'Continue here', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'The engine cannot continue this run.' }).waitFor();
    assert.equal(await f.composer.count(), 0);
    assert.equal(await row(page, 'exec-run').getAttribute('class').then(value => value.includes('active')), true);
    assert.equal(f.posts.filter(post => post.path === '/api/threads/exec-run/continue').length, 1, 'a failed write is not replayed');
    assert.equal(f.posts.filter(post => post.path.endsWith('/turns')).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
