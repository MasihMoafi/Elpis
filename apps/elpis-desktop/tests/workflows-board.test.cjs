const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { chooseOption, chooseTheme } = require('./controls.cjs');
const KEY = 'elpis-workflow-draft-v1';
const pet = (id, x, character = 'researcher') => ({ id, type: 'agent', position: { x, y: 120 }, data: { character, title: id, instruction: `Role ${id}`, model: null, writeScopes: [], acceptanceCriteria: [] } });
async function open({ graph, project = false, fail = false } = {}) {
  const runs = [], polls = [];
  const thread = id => ({ id, name: id === 'team-root' ? 'Team run' : 'Researcher result', cwd: '/workspace', modelProvider: 'openai', model: 'sol', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
  const f = await fixture({ width: 1440, height: 900, storage: {
    [KEY]: JSON.stringify(graph || { name: 'Team', nodes: [], edges: [] }),
    'elpis-projects-v1': JSON.stringify({ projects: project ? [{ id: 'p1', name: 'demo', cwd: '/tmp/demo' }] : [], selectedId: project ? 'p1' : null }),
  }, routes: {
    '/api/settings': () => ({ main: { model: 'sol', provider: 'openai' }, providers: [], background: {}, memory: {}, smartPrune: {}, write: {} }),
    '/api/models': () => ({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }, { id: 'luna', model: 'luna', displayName: 'Luna' }], nextCursor: null }),
    '/api/threads': body => body ? { thread: { id: 'team-root', name: body.name, cwd: body.cwd || '/workspace', modelProvider: 'openai', status: { type: 'idle' } } } : { data: [{ id: 'chat-a', name: 'Existing', status: { type: 'idle' } }], nextCursor: null },
    ...Object.fromEntries(['team-root', 'pet-Researcher'].flatMap(id => [
      [`/api/threads/${id}`, () => ({ thread: thread(id), data: [], nextCursor: null })],
      [`/api/threads/${id}/resume`, () => ({ thread: thread(id), activeTurnId: null })],
    ])),
    '/api/workflows/run': body => { runs.push(body); return fail ? { __http: 400, error: 'Engine refused this run' } : { graphId: 'run-1', threadId: body.rootThreadId }; },
    '/api/workflows': (_, url) => { polls.push(url.searchParams.get('threadId')); return { data: runs.length ? [{ id: 'run-1', status: polls.length > 1 ? 'succeeded' : 'running', tasks: runs[0].tasks.map(t => ({ ...t, status: polls.length > 1 ? 'succeeded' : 'running', assignedThreadId: `pet-${t.id}`, ...(polls.length > 1 ? { result: { summary: `**${t.id}** result: RESULT_${t.id}` } } : {}) })) }] : [] }; },
  } });
  await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
  f.board = f.page.getByRole('region', { name: 'Workflows', exact: true });
  await f.board.waitFor();
  f.nodes = f.board.locator('.react-flow__node-pet');
  f.saved = () => f.page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
  return Object.assign(f, { runs, polls });
}
async function add(f, name) {
  await f.board.getByRole('button', { name: 'Add', exact: true }).click();
  await f.page.getByRole('menuitem', { name, exact: true }).click();
}
async function connect(f, first, second) {
  // The board refits after pets are added or deleted; measure the handles once it has settled.
  await f.page.waitForTimeout(400);
  const a = await first.locator('.react-flow__handle-right').boundingBox(), b = await second.locator('.react-flow__handle-left').boundingBox();
  await f.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await f.page.mouse.down();
  await f.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 }); await f.page.mouse.up();
}
test('W2 W3 W4: six pets share Add, artwork, editing, model menu, arrows and Delete', async () => {
  const f = await open();
  try {
    assert.equal(await f.board.getByRole('button', { name: 'Run', exact: true }).isDisabled(), true);
    await f.board.getByText('Add a pet to start.', { exact: true }).waitFor();
    for (const name of ['Researcher', 'Builder', 'Reviewer', 'Tester', 'Writer', 'Critic']) {
      await add(f, name);
      const node = f.nodes.filter({ hasText: name }); await node.waitFor();
      assert.ok(await node.locator('img').evaluate(async img => { await img.decode(); return img.naturalWidth > 0; }), `${name} artwork loads`);
      await node.click(); await node.getByRole('button', { name: 'Edit', exact: true }).click();
      const edit = f.page.getByRole('dialog', { name: 'Edit pet', exact: true });
      assert.ok((await edit.getByRole('textbox', { name: 'Role prompt', exact: true }).inputValue()).length > 40);
      assert.equal(await edit.getByRole('combobox', { name: 'Model', exact: true }).getAttribute('data-value'), 'sol');
      await chooseOption(edit.getByRole('combobox', { name: 'Model', exact: true }), 'luna');
      await edit.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} pet`);
      await edit.getByRole('switch', { name: 'Edits files', exact: true }).click();
      await f.page.keyboard.press('Escape');
      const savedPet = (await f.saved()).nodes.find(pet => pet.data.title === `${name} pet`);
      assert.equal(savedPet.data.model, 'luna'); assert.equal(savedPet.data.editsFiles, true);
    }
    // Keep two pets for real handle dragging and arrow deletion.
    for (const name of ['Reviewer', 'Tester', 'Writer', 'Critic']) {
      await f.nodes.filter({ hasText: `${name} pet` }).click(); await f.page.keyboard.press('Delete');
    }
    const a = f.nodes.filter({ hasText: 'Researcher pet' }), b = f.nodes.filter({ hasText: 'Builder pet' });
    await connect(f, a, b);
    // A level arrow has no height, so it is never "visible" to Playwright: wait for it in the page and click its middle.
    const edges = f.board.locator('.react-flow__edge'); await edges.waitFor({ state: 'attached' });
    const from = await a.locator('.react-flow__handle-right').boundingBox(), to = await b.locator('.react-flow__handle-left').boundingBox();
    await f.page.mouse.click((from.x + to.x + to.width) / 2, from.y + from.height / 2); await f.page.keyboard.press('Delete'); assert.equal(await edges.count(), 0);
    await connect(f, a, b); await edges.waitFor({ state: 'attached' });
    await a.click(); await f.page.keyboard.press('Delete'); assert.equal(await edges.count(), 0);
    assert.equal(await f.nodes.count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const project of [false, true]) test(`W4 W6: task keys, ${project ? 'project' : 'workspace'} folder, run chat, polling and pet chat`, async () => {
  const f = await open({ project, graph: { name: 'Team', nodes: [{ ...pet('Researcher', 100), data: { ...pet('Researcher', 100).data, editsFiles: project } }, pet('Writer', 390, 'writer')], edges: [{ id: 'a-b', source: 'Researcher', target: 'Writer' }] } });
  try {
    const run = f.board.getByRole('button', { name: 'Run', exact: true }), task = f.board.getByRole('textbox', { name: 'Give the team a task', exact: true });
    assert.ok(await run.isDisabled()); await f.board.getByText('Give the team a task.', { exact: true }).waitFor();
    await task.fill('Find facts'); await task.press('Shift+Enter'); await task.press('x');
    assert.equal(f.runs.length, 0); assert.equal(await task.inputValue(), 'Find facts\nx');
    await task.press('Enter');
    await f.page.getByRole('complementary', { name: 'Results', exact: true }).waitFor();
    assert.equal(await f.board.isVisible(), true, 'board stays beside the results');
    const created = f.posts.find(p => p.path === '/api/threads'); assert.equal(created.body.agents, true);
    assert.equal(created.body.cwd, project ? '/tmp/demo' : undefined);
    assert.equal(f.runs[0].maxConcurrency, 4); assert.equal(f.runs[0].rootThreadId, 'team-root');
    assert.deepEqual(f.runs[0].tasks.map(t => [t.kind, t.dependsOn]), project ? [['implement', []], ['verify', ['Researcher']], ['explore', ['Researcher', 'Researcher-check']]] : [['explore', []], ['explore', ['Researcher']]]);
    await f.nodes.first().getByLabel('done', { exact: true }).waitFor({ timeout: 8000 });
    // Each pet's result is shown, in run order, rendered as Markdown (W5).
    const results = f.page.getByRole('complementary', { name: 'Results', exact: true });
    await results.getByText('RESULT_Researcher', { exact: false }).waitFor();
    assert.deepEqual(await results.locator('li > div:first-child > strong').allInnerTexts(), ['Researcher', 'Writer']);
    assert.equal(await results.locator('li').first().locator('p strong').innerText(), 'Researcher');
    assert.ok(f.polls.length >= 2 && f.polls.every(id => id === 'team-root'));
    await f.nodes.first().click();
    const resumed = f.page.waitForResponse(response => response.url().endsWith('/api/threads/pet-Researcher/resume'));
    await f.nodes.first().getByRole('button', { name: 'Chat', exact: true }).click(); await resumed;
    await f.page.locator('.app-shell[data-workspace=chat]').waitFor();
    await f.page.locator('.header-titles').getByText('Researcher result', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('W8 W1: old agents and arrows survive reload; removed concepts go; light and dark fit', async () => {
  const f = await open({ graph: { name: 'Old', template: 'sequential', mother: { brief: 'old' }, nodes: [
    { id: 'mother', type: 'mother', position: { x: 0, y: 0 }, data: {} }, pet('Researcher', 100), pet('Builder', 400, 'builder'),
    { id: 'father', type: 'father', position: { x: 900, y: 0 }, data: {} }, { id: 'note', type: 'note', position: { x: 0, y: 0 }, data: { text: 'obsolete' } },
  ], edges: [{ id: 'm-a', source: 'mother', target: 'Researcher' }, { id: 'a-b', source: 'Researcher', target: 'Builder' }] } });
  try {
    assert.equal(await f.nodes.count(), 2); assert.equal(await f.board.locator('.react-flow__edge').count(), 1);
    await f.nodes.first().click(); await f.nodes.first().getByRole('button', { name: 'Edit', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Name', exact: true }).fill('Evidence'); await f.page.keyboard.press('Escape');
    await f.page.reload(); await f.page.getByRole('button', { name: 'Workflows', exact: true }).click(); await f.nodes.filter({ hasText: 'Evidence' }).waitFor();
    const saved = await f.saved(); assert.equal(saved.nodes.length, 2); assert.equal(saved.edges.length, 1); assert.equal(saved.mother, undefined); assert.equal(saved.template, undefined);
    await fs.mkdir('/home/masih/.cache/wf-live', { recursive: true });
    for (const theme of ['light', 'dark']) {
      if ((await f.page.locator('html').evaluate(el => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      for (const node of await f.nodes.all()) {
        const box = await node.boundingBox(); assert.ok(box.x > 0 && box.y > 0 && box.x + box.width < 1440 && box.y + box.height < 900);
      }
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await f.page.screenshot({ path: `/home/masih/.cache/wf-live/sol-${theme}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a refused run explains the failure and lets the task be retried', async () => {
  const f = await open({ fail: true, graph: { name: 'Team', nodes: [pet('Researcher', 100)], edges: [] } });
  try {
    await f.board.getByRole('textbox', { name: 'Give the team a task', exact: true }).fill('Test');
    await f.board.getByRole('button', { name: 'Run', exact: true }).click();
    await f.board.getByRole('alert').filter({ hasText: 'Engine refused this run' }).waitFor();
    assert.equal(await f.board.getByRole('button', { name: 'Run', exact: true }).isEnabled(), true);
  } finally { await f.close(); }
});
