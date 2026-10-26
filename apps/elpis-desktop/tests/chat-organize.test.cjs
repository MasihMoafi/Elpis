// Real sidebar clicks, keys and pointer drags against the exported renderer and a mock bridge.
// Owns display nesting and after-the-fact bulk project creation; engine acceptance remains separate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

const children = ['chat-b', 'chat-c', 'chat-d', 'chat-e', 'chat-f', 'chat-g'];
const chats = [
  ['chat-a', 'car-scraper-pro'],
  ...children.map((id, i) => [id, `BoomDeal · ${['Parser', 'Search', 'Listings', 'Prices', 'Export', 'Review'][i]}`]),
  ['chat-z', 'Unrelated chat'],
].map(([id, name]) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: id === 'chat-b' ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } }));
const native = { ...chats[0], id: 'native-agent', name: 'Native worker', parentThreadId: 'chat-a', source: 'subAgentThreadSpawn', agentRole: 'explorer', status: { type: 'idle' } };
const storage = {
  'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'existing', name: 'Existing project', cwd: '/work/existing' }], selectedId: null }),
};
const open = (options = {}) => fixture({ desktop: true, width: 1440, height: 900, threads: [...chats, native], storage,
  routes: { '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? url.searchParams.get('ancestorThreadId') === 'chat-a' ? [native] : [] : url.searchParams.get('archived') === 'true' ? [] : [...chats, native], nextCursor: null }) }, ...options });
const aside = page => page.locator('aside.sidebar');
const row = (page, id) => aside(page).locator(`.thread-row[data-thread-id="${id}"]`).first();
const recents = page => aside(page).locator('section[aria-label="Recents"]');
const project = (page, name) => aside(page).getByRole('group', { name, exact: true });
const ids = container => container.locator('.thread-row').evaluateAll(rows => rows.map(row => row.dataset.threadId));
async function eventually(check) {
  const end = Date.now() + 5000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}
async function mark(page, values = children) {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  for (const id of values) await row(page, id).locator('.thread-link').click({ modifiers: ['Control'] });
}
async function action(page, id, name) {
  await row(page, id).getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function putUnder(page, id = children[0], target = 'car-scraper-pro', theme) {
  await action(page, id, 'Put under…');
  const dialog = page.getByRole('alertdialog', { name: 'Put chats under a chat' });
  await dialog.getByRole('combobox', { name: 'Parent chat', exact: true }).click();
  await page.getByRole('option', { name: target, exact: true }).click();
  if (theme) { await assertUiFit(dialog, 'parent picker fits'); await shot(page, `put-under-${theme}`); }
  await dialog.getByRole('button', { name: 'Put under', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function drag(page, from, to, where = 'middle', during) {
  const start = await row(page, from).locator('.thread-link').boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 5, start.y + start.height / 2 + 5, { steps: 3 });
  const end = await row(page, to).boundingBox();
  await page.mouse.move(end.x + end.width / 2, where === 'top' ? end.y + 2 : where === 'bottom' ? end.y + end.height - 2 : end.y + end.height / 2, { steps: 10 });
  if (during) await during();
  await page.mouse.up();
}
const shot = async (page, name) => {
  const dir = process.env.ELPIS_PARITY_SHOTS;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `organize-${name}.png`) });
};

for (const colorScheme of ['light', 'dark']) test(`native agent generations drag out, reparent with descendants and keep folds and drafts (${colorScheme})`, async () => {
  const make = (id, name, parentThreadId) => ({ id, name, ...(parentThreadId ? { parentThreadId } : {}), source: 'cli', cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true } });
  const tree = [make('tree-root', 'Tree root'), make('tree-worker', 'Tree worker', 'tree-root'), make('tree-grandchild', 'Tree grandchild', 'tree-worker'),
    { ...make('tree-leaf', 'Tree leaf', 'tree-grandchild'), source: { subAgent: { thread_spawn: { parent_thread_id: 'tree-grandchild' } } } },
    make('tree-peer', 'Tree peer', 'tree-grandchild'), make('tree-sibling', 'Tree sibling', 'tree-root'), make('tree-other', 'Other root'), make('tree-orphan', 'Orphan worker', 'not-loaded')];
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, threads: tree,
    storage: { 'elpis-chat-groups-v1': JSON.stringify({ groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [], branches: { 'tree-root': true, 'tree-worker': true, 'tree-grandchild': true } }) } });
  const { page } = f;
  const depth = async (id, expected) => eventually(async () => assert.equal(await row(page, id).getAttribute('data-depth'), String(expected), id));
  try {
    for (const [id, level] of [['tree-root', 0], ['tree-worker', 1], ['tree-grandchild', 2], ['tree-leaf', 3]]) await depth(id, level);
    for (const id of ['tree-leaf', 'tree-peer', 'tree-sibling', 'tree-orphan']) assert.equal(await row(page, id).getByRole('button', { name: /^(Expand|Collapse) / }).count(), 0, 'leaves have no expansion control');
    const sidebarBox = await aside(page).boundingBox();
    const geometry = await Promise.all(['tree-root', 'tree-worker', 'tree-grandchild', 'tree-leaf'].map(async id => {
      const item = row(page, id), chevron = item.getByRole('button', { name: /^(Expand|Collapse) / });
      return { id, row: await item.boundingBox(), name: await item.locator('.thread-title').boundingBox(), dot: await item.locator('.thread-dot').boundingBox(),
        chevron: await chevron.count() ? await chevron.locator('svg').boundingBox() : null };
    }));
    const right = box => box.x + box.width, bottom = box => box.y + box.height, centerY = box => box.y + box.height / 2;
    const inside = (box, container) => box && box.width > 0 && box.height > 0 && box.x >= container.x - 1 && right(box) <= right(container) + 1 && box.y >= container.y - 1 && bottom(box) <= bottom(container) + 1;
    const nameIndent = geometry[1].name.x - geometry[0].name.x;
    assert.ok(nameIndent > 1, 'a child name is visibly indented from its parent');
    for (let index = 0; index < geometry.length; index++) {
      const current = geometry[index], previous = geometry[index - 1];
      assert.ok(inside(current.row, sidebarBox), `${current.id}: row stays within the sidebar`);
      for (const [part, box] of [['name', current.name], ['status dot', current.dot], ...(current.chevron ? [['chevron', current.chevron]] : [])]) {
        assert.ok(inside(box, current.row), `${current.id}: ${part} stays within its row`);
        if (part !== 'name') assert.ok(Math.abs(centerY(box) - centerY(current.row)) < 2, `${current.id}: ${part} aligns vertically with its row`);
      }
      assert.ok(right(current.dot) < current.name.x, `${current.id}: status and name do not overlap`);
      if (current.chevron) assert.ok(right(current.chevron) < current.dot.x && right(current.chevron) < current.name.x, `${current.id}: the chevron stays clear of its status and name`);
      if (previous) {
        assert.ok(bottom(previous.row) <= current.row.y + 1, 'successive generations do not overlap vertically');
        for (const part of ['name', 'dot']) {
          const indent = current[part].x - previous[part].x;
          assert.ok(indent > 1 && Math.abs(indent - nameIndent) < 1, `${current.id}: rendered ${part} advances by the shared generation indent`);
        }
        if (current.chevron) assert.ok(Math.abs(current.chevron.x - previous.chevron.x - nameIndent) < 1, `${current.id}: its rendered chevron follows the same tree indent`);
      }
    }
    await row(page, 'tree-worker').getByRole('button', { name: /^Collapse / }).click();
    await page.reload();
    await row(page, 'tree-worker').waitFor(); assert.equal(await row(page, 'tree-grandchild').count(), 0);
    const expand = row(page, 'tree-worker').getByRole('button', { name: /^Expand / });
    await expand.focus(); await page.keyboard.press('Enter'); await depth('tree-leaf', 3);
    await f.open('tree-grandchild'); await f.composer.fill('Keep my nested chat draft');
    await drag(page, 'tree-grandchild', 'tree-other', 'top');
    await depth('tree-grandchild', 0); await depth('tree-leaf', 1);
    assert.equal(await f.shown(), 'tree-grandchild'); assert.equal(await f.composer.inputValue(), 'Keep my nested chat draft');
    await page.reload(); await depth('tree-grandchild', 0); await depth('tree-leaf', 1);
    assert.equal(await f.composer.inputValue(), 'Keep my nested chat draft');
    assert.equal(await page.evaluate(() => JSON.parse(window.elpisDesktop.storage.getItem('elpis-chat-groups-v1')).parents['tree-grandchild']), null, 'taking a native grandchild out saves an explicit root override');
    await drag(page, 'tree-grandchild', 'tree-sibling'); await depth('tree-grandchild', 2); await depth('tree-leaf', 3);
    await drag(page, 'tree-sibling', 'tree-other'); await depth('tree-sibling', 1); await depth('tree-grandchild', 2); await depth('tree-leaf', 3);
    await drag(page, 'tree-other', 'tree-leaf'); await depth('tree-other', 0); await depth('tree-leaf', 3);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await row(page, 'tree-other').locator('.thread-link').click({ modifiers: ['Control'] });
    await row(page, 'tree-grandchild').locator('.thread-link').click({ modifiers: ['Control'] });
    await drag(page, 'tree-other', 'tree-leaf'); await depth('tree-other', 0); await depth('tree-grandchild', 2);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await row(page, 'tree-leaf').locator('.thread-link').focus(); await page.keyboard.press('Alt+ArrowDown');
    await eventually(async () => { const visible = await ids(recents(page)); assert.equal(visible.indexOf('tree-peer') + 1, visible.indexOf('tree-leaf')); });
    await page.reload(); await depth('tree-leaf', 3);
    await eventually(async () => { const visible = await ids(recents(page)); assert.equal(visible.indexOf('tree-peer') + 1, visible.indexOf('tree-leaf')); });
    await row(page, 'tree-orphan').waitFor();
    for (const thread of tree) assert.equal(await aside(page).locator(`.thread-row[data-thread-id="${thread.id}"]`).count(), 1, 'each loaded chat remains reachable once');
    await assertUiFit(aside(page), 'recursive native agent tree fits'); await shot(page, `recursive-${colorScheme}`);
    assert.equal(f.posts.some(post => /\/(parent|folder|permissions|turns|steer)$/.test(post.path)), false, 'display moves do not mutate runtime threads');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('workflow descendants and manual branches use the same recursive placement and corrupt cycles stay visible', async () => {
  const tree = ['flow-root', 'flow-step', 'flow-grandchild', 'manual-root', 'manual-child', 'cycle-a', 'cycle-b'].map(id => ({ id, name: id, source: 'cli', model: 'sol', modelProvider: 'openai', status: { type: 'idle' },
    ...(id === 'flow-step' ? { parentThreadId: 'flow-root' } : id === 'flow-grandchild' ? { parentThreadId: 'flow-step' } : {}) }));
  const f = await fixture({ desktop: true, threads: tree,
    storage: { 'elpis-sidebar-folds-v1': JSON.stringify({ sections: { workflows: false }, projects: {} }),
      'elpis-chat-groups-v1': JSON.stringify({ groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [], parents: { 'manual-child': 'manual-root', 'cycle-a': 'cycle-b', 'cycle-b': 'cycle-a' }, branches: { 'workflow:flow-run': true, 'flow-step': true, 'manual-root': true } }) },
    routes: { '/api/workflows/history': () => ({ data: [{ id: 'flow-run', rootThreadId: 'flow-root', name: 'Nested workflow', status: 'succeeded', tasks: [{ id: 'step', title: 'flow-step', assignedThreadId: 'flow-step' }, { id: 'grandchild', title: 'flow-grandchild', assignedThreadId: 'flow-grandchild' }] }] }) } });
  const { page } = f;
  try {
    await eventually(async () => assert.equal(await row(page, 'flow-grandchild').getAttribute('data-depth'), '2'));
    await row(page, 'manual-child').waitFor(); await row(page, 'cycle-a').waitFor(); await row(page, 'cycle-b').waitFor();
    await drag(page, 'manual-child', 'flow-step');
    await eventually(async () => assert.equal(await row(page, 'manual-child').getAttribute('data-depth'), '2'));
    await action(page, 'flow-grandchild', 'Take out');
    await eventually(async () => assert.equal(await row(page, 'flow-grandchild').getAttribute('data-depth'), '0'));
    await page.reload();
    await eventually(async () => assert.equal(await row(page, 'manual-child').getAttribute('data-depth'), '2'));
    assert.equal(await row(page, 'flow-grandchild').getAttribute('data-depth'), '0');
    await page.getByLabel('Search conversations', { exact: true }).fill('flow');
    const results = aside(page).locator('section[aria-label="Results"]');
    await eventually(async () => assert.equal(await results.locator('.thread-row').count(), 3));
    assert.equal(await results.locator('.thread-row.child').count(), 0, 'recursive matches stay flat while searching');
    assert.equal(f.posts.some(post => /\/(parent|folder|permissions|turns|steer)$/.test(post.path)), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('ordinary recursive branches expose the second child and grandchild pages without Background runs', async () => {
  const make = (id, name, parentThreadId) => ({ id, name, ...(parentThreadId ? { parentThreadId } : {}), source: 'cli', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } });
  const root = make('paged-root', 'Pagination root');
  const workers = Array.from({ length: 101 }, (_, i) => make(`paged-worker-${i}`, `Pagination worker ${i}`, root.id));
  const grandchildren = Array.from({ length: 101 }, (_, i) => make(`paged-grandchild-${i}`, `Pagination grandchild ${i}`, workers[0].id));
  const reads = [];
  const f = await fixture({ desktop: true, threads: [root], width: 1440, height: 900,
    storage: { 'elpis-chat-groups-v1': JSON.stringify({ groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [], branches: { [root.id]: true } }) },
    routes: { '/api/threads': (_body, url) => {
      const parent = url.searchParams.get('ancestorThreadId'), cursor = url.searchParams.get('cursor');
      if (!parent) return { data: url.searchParams.get('archived') === 'true' ? [] : [root], nextCursor: null };
      reads.push({ parent, cursor, limit: url.searchParams.get('limit') });
      const children = parent === root.id ? workers : parent === workers[0].id ? grandchildren : [];
      return { data: cursor ? children.slice(100) : children.slice(0, 100), nextCursor: !cursor && children.length > 100 ? 'second-page' : null };
    } } });
  const { page } = f;
  try {
    await row(page, workers[99].id).waitFor();
    const moreRoot = aside(page).getByRole('button', { name: 'More agents from Pagination root', exact: true });
    await moreRoot.waitFor(); assert.equal(await row(page, workers[100].id).count(), 0);
    assert.equal(await aside(page).getByRole('region', { name: 'Agent runs', exact: true }).count(), 0);
    await moreRoot.click(); await row(page, workers[100].id).waitFor();
    assert.equal(await row(page, workers[100].id).getAttribute('data-depth'), '1');
    assert.equal(await moreRoot.count(), 0);
    await row(page, workers[0].id).getByRole('button', { name: /^Expand agents/ }).click();
    await row(page, grandchildren[99].id).waitFor();
    const moreGrandchildren = aside(page).getByRole('button', { name: 'More agents from Pagination worker 0', exact: true });
    await moreGrandchildren.click(); await row(page, grandchildren[100].id).waitFor();
    assert.equal(await row(page, grandchildren[100].id).getAttribute('data-depth'), '2');
    assert.equal(await moreGrandchildren.count(), 0);
    for (const parent of [root.id, workers[0].id]) assert.ok(reads.some(read => read.parent === parent && read.cursor === 'second-page' && read.limit === '100'));
    assert.equal(await aside(page).locator('.thread-row').count(), 203, 'both pages at both generations stay visible once');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('several roots from malformed native lineage can be put under one chat and survive reload', async () => {
  const tree = [{ id: 'native-cycle-a', name: 'Native cycle A', parentThreadId: 'native-cycle-b' }, { id: 'native-cycle-b', name: 'Native cycle B', parentThreadId: 'native-cycle-a' }, { id: 'native-cycle-target', name: 'Safe parent' }]
    .map(thread => ({ ...thread, source: 'cli', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } }));
  const f = await fixture({ desktop: true, threads: tree }), { page } = f;
  try {
    await row(page, 'native-cycle-a').waitFor(); await row(page, 'native-cycle-b').waitFor();
    await mark(page, ['native-cycle-a', 'native-cycle-b']); await putUnder(page, 'native-cycle-a', 'Safe parent');
    for (const id of ['native-cycle-a', 'native-cycle-b']) assert.equal(await row(page, id).getAttribute('data-depth'), '1');
    await page.reload();
    for (const id of ['native-cycle-a', 'native-cycle-b']) await eventually(async () => assert.equal(await row(page, id).getAttribute('data-depth'), '1'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a refused final order save leaves the subtree, projects, order and selection unchanged', async () => {
  const tree = [{ id: 'save-parent', name: 'Project parent' }, { id: 'save-child', name: 'Moving child', parentThreadId: 'save-parent' }, { id: 'save-grandchild', name: 'Moving grandchild', parentThreadId: 'save-child' }, { id: 'save-target', name: 'Recent target' }]
    .map(thread => ({ ...thread, source: 'cli', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } }));
  const f = await fixture({ desktop: true, threads: tree, storage: { ...storage,
    'elpis-project-chats-v1': JSON.stringify({ 'save-parent': 'existing', 'save-child': 'existing', 'save-grandchild': 'existing' }),
    'elpis-chat-groups-v1': JSON.stringify({ groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: ['save-target', 'save-parent', 'save-child', 'save-grandchild'], branches: { 'save-parent': true, 'save-child': true } }) } });
  const { page } = f;
  try {
    await mark(page, ['save-child', 'save-grandchild']);
    const before = await page.evaluate(() => ({ groups: window.elpisDesktop.storage.getItem('elpis-chat-groups-v1'), projects: window.elpisDesktop.storage.getItem('elpis-project-chats-v1') }));
    await page.evaluate(() => {
      const store = window.elpisDesktop.storage, setItem = store.setItem;
      window.restorePlacementStore = () => { store.setItem = setItem; };
      store.setItem = (key, value) => {
        // The old two-stage drag saved its parent first, then failed while saving Manual order.
        if (key === 'elpis-chat-groups-v1' && JSON.parse(value).sortBy === 'manual') throw Error('Final order write refused');
        return setItem(key, value);
      };
    });
    await drag(page, 'save-child', 'save-target', 'top');
    await page.getByRole('alert').filter({ hasText: 'Could not save chat placement' }).waitFor();
    assert.equal(await row(page, 'save-child').getAttribute('data-depth'), '1');
    assert.equal(await row(page, 'save-grandchild').getAttribute('data-depth'), '2');
    assert.equal(await aside(page).locator('.thread-row.selected').count(), 2, 'a refused placement keeps the selected branch');
    const after = await page.evaluate(() => ({ groups: window.elpisDesktop.storage.getItem('elpis-chat-groups-v1'), projects: window.elpisDesktop.storage.getItem('elpis-project-chats-v1') }));
    assert.deepEqual(after, before, 'no intermediate placement or project membership was committed');
    assert.deepEqual((await ids(project(page, 'Existing project'))).sort(), ['save-child', 'save-grandchild', 'save-parent']);
    await page.evaluate(() => window.restorePlacementStore());
    await drag(page, 'save-child', 'save-target', 'top');
    await eventually(async () => assert.equal(await row(page, 'save-child').getAttribute('data-depth'), '0'));
    assert.equal(await row(page, 'save-grandchild').getAttribute('data-depth'), '1');
    await page.reload(); await eventually(async () => assert.equal(await row(page, 'save-child').getAttribute('data-depth'), '0'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`six chats nest, fold, persist, take out, then form a new project (${colorScheme})`, async () => {
  const f = await open({ colorScheme }), { page } = f;
  try {
    await mark(page);
    await putUnder(page, children[0], 'car-scraper-pro', colorScheme);
    await eventually(async () => assert.equal(await aside(page).locator('.thread-row.child').count(), 7));
    for (const id of children) {
      assert.equal(await row(page, id).getAttribute('class').then(value => value.includes('child')), true);
      assert.equal(await row(page, id).evaluate(el => getComputedStyle(el).paddingLeft), await row(page, 'native-agent').evaluate(el => getComputedStyle(el).paddingLeft), 'same indent as native agents');
      assert.equal(await aside(page).locator(`.thread-row[data-thread-id="${id}"]`).count(), 1);
    }
    await assertUiFit(aside(page), 'nested chats fit');
    await shot(page, `nested-${colorScheme}`);
    await row(page, 'chat-a').getByRole('button', { name: /^Collapse .*car-scraper-pro/ }).click();
    assert.equal(await row(page, children[0]).count(), 0, 'collapse hides display children');
    await row(page, 'chat-a').getByRole('button', { name: /^Expand .*car-scraper-pro/ }).click();
    await row(page, children[0]).waitFor();
    await page.reload();
    await row(page, children[0]).waitFor();
    await row(page, 'chat-a').getByRole('button', { name: /^Collapse .*car-scraper-pro/ }).click();
    await page.reload();
    assert.equal(await row(page, children[0]).count(), 0, 'the folded branch survives reload');
    await row(page, 'chat-a').getByRole('button', { name: /^Expand .*car-scraper-pro/ }).click();
    await page.getByLabel('Search conversations', { exact: true }).fill('BoomDeal');
    const results = aside(page).locator('section[aria-label="Results"]');
    await eventually(async () => assert.equal(await results.locator('.thread-row').count(), 6));
    assert.equal(await results.locator('.thread-row.child').count(), 0, 'search hits remain flat');
    await page.getByLabel('Search conversations', { exact: true }).fill('');
    await row(page, children[0]).waitFor();
    await mark(page);
    await action(page, children[0], 'Take out');
    await eventually(async () => assert.equal(await aside(page).locator('.thread-row.child').count(), 1));
    await mark(page);
    await action(page, children[0], 'New project from these…');
    const dialog = page.getByRole('alertdialog', { name: 'New project', exact: true });
    await dialog.getByLabel('Project name', { exact: true }).fill('BoomDeal');
    await dialog.getByRole('combobox', { name: 'Working folder', exact: true }).click();
    await page.getByRole('option', { name: CWD, exact: true }).click();
    await assertUiFit(dialog, 'project folder choices fit');
    await shot(page, `project-dialog-${colorScheme}`);
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await eventually(async () => assert.deepEqual((await ids(project(page, 'BoomDeal'))).sort(), children));
    assert.deepEqual(await ids(recents(page)), ['chat-a', 'native-agent', 'chat-z'], 'only unrelated root and expanded native agent remain in Recents');
    await assertUiFit(aside(page), 'new project fits');
    await shot(page, `project-${colorScheme}`);
    await page.reload();
    await eventually(async () => assert.deepEqual((await ids(project(page, 'BoomDeal'))).sort(), children));
    assert.equal(f.posts.some(post => /\/(folder|parent|turns)$/.test(post.url || post.path || '')), false, 'organizing must not change engine folders or turns');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('middle drag nests every marked chat; edge and keyboard moves reorder; cycles are refused and nested parents are available', async () => {
  const f = await open(), { page } = f;
  try {
    await mark(page);
    await drag(page, children[0], 'chat-a', 'middle', async () => eventually(async () => assert.equal(await row(page, 'chat-a').getAttribute('data-drop'), 'into')));
    await eventually(async () => assert.equal(await aside(page).locator('.thread-row.child').count(), 7));
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await drag(page, 'chat-a', children[0]);
    assert.equal(await row(page, 'chat-a').getAttribute('class').then(value => value.includes('child')), false, 'a parent cannot become its own descendant');
    await action(page, 'chat-z', 'Put under…');
    const dialog = page.getByRole('alertdialog', { name: 'Put chats under a chat' });
    await dialog.getByRole('combobox', { name: 'Parent chat', exact: true }).click();
    assert.equal(await page.getByRole('option', { name: 'Unrelated chat', exact: true }).count(), 0, 'self is excluded');
    assert.equal(await page.getByRole('option', { name: /^BoomDeal/ }).count(), 6, 'nested chats can parent another branch');
    await page.getByRole('option', { name: 'car-scraper-pro', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await drag(page, 'chat-g', 'chat-c', 'top');
    await eventually(async () => { const list = await ids(recents(page)); assert.equal(list.indexOf('chat-g') + 1, list.indexOf('chat-c')); });
    assert.equal(await row(page, 'chat-g').getAttribute('class').then(value => value.includes('child')), true, 'edge reorder inside a parent keeps nesting');
    await row(page, 'chat-g').locator('.thread-link').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await eventually(async () => { const list = await ids(recents(page)); assert.equal(list.indexOf('chat-c') + 1, list.indexOf('chat-g')); });
    await mark(page);
    await action(page, children[0], 'Take out');
    await eventually(async () => assert.equal(await aside(page).locator('.thread-row.child').count(), 1, 'Take out restores ordinary rows; native agents keep their parent'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('bulk project moves include running chats, fail without partial changes, and can be reversed', async () => {
  const f = await open(), { page } = f;
  try {
    await mark(page);
    await action(page, children[0], 'Move to project…');
    const dialog = page.getByRole('alertdialog');
    await page.evaluate(() => { window.elpisDesktop.storage.saveItem = async () => { throw Error('Membership write refused'); }; });
    await dialog.getByRole('button', { name: 'Existing project', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Membership write refused' }).waitFor();
    assert.deepEqual(await ids(project(page, 'Existing project')), []);
    assert.equal((await ids(recents(page))).filter(id => children.includes(id)).length, 6);
    await page.evaluate(() => { delete window.elpisDesktop.storage.saveItem; });
    await dialog.getByRole('button', { name: 'Existing project', exact: true }).click();
    await eventually(async () => assert.deepEqual((await ids(project(page, 'Existing project'))).sort(), children));
    assert.equal(await row(page, 'chat-b').locator('.thread-dot').getAttribute('data-state'), 'working');
    await mark(page);
    await action(page, children[0], 'Move to project…');
    await page.getByRole('alertdialog').getByRole('button', { name: 'No project', exact: true }).click();
    await eventually(async () => assert.deepEqual(await ids(project(page, 'Existing project')), []));
    await page.reload();
    await row(page, children[0]).waitFor();
    assert.equal((await ids(recents(page))).filter(id => children.includes(id)).length, 6);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('moving a nested child to a project detaches it; moving its parent carries its remaining children', async () => {
  const f = await open(), { page } = f;
  try {
    await mark(page); await putUnder(page);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await action(page, children[0], 'Move to project…');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Existing project', exact: true }).click();
    await project(page, 'Existing project').locator(`[data-thread-id="${children[0]}"]`).waitFor();
    assert.equal(await row(page, children[0]).getAttribute('class').then(value => value.includes('child')), false);
    await action(page, 'chat-a', 'Move to project…');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Existing project', exact: true }).click();
    await eventually(async () => assert.equal((await ids(project(page, 'Existing project'))).length, 8));
    assert.deepEqual(await ids(recents(page)), ['chat-z']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('new-project cancellation and membership failure leave no project or moved chats', async () => {
  const f = await open(), { page } = f;
  try {
    await mark(page); await action(page, children[0], 'New project from these…');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await aside(page).locator('.project-group').count(), 1);
    await action(page, children[0], 'New project from these…');
    const dialog = page.getByRole('alertdialog', { name: 'New project', exact: true });
    await dialog.getByLabel('Project name', { exact: true }).fill('Will fail');
    await dialog.getByRole('combobox', { name: 'Working folder', exact: true }).click();
    await page.getByRole('option', { name: CWD, exact: true }).click();
    await page.evaluate(() => { window.elpisDesktop.storage.saveItem = async (key, value) => { if (key === 'elpis-project-chats-v1') throw Error('Membership write refused'); localStorage.setItem(key, value); }; });
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Membership write refused' }).waitFor();
    assert.equal(await aside(page).locator('.project-group').count(), 1, 'failed membership rolls the new project back');
    assert.equal((await ids(recents(page))).filter(id => children.includes(id)).length, 6);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.reload();
    await row(page, children[0]).waitFor();
    assert.equal(await aside(page).locator('.project-group').count(), 1, 'no orphan project after reload');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const desktop of [true, false]) test(`single-chat organizing actions are shared by row and ${desktop ? 'tab' : 'header'} menus`, async () => {
  const f = await open({ desktop }), { page } = f;
  try {
    await f.open('chat-z');
    for (const trigger of [row(page, 'chat-z').getByRole('button', { name: 'Actions for Unrelated chat', exact: true }), page.locator('.workspace-header').getByRole('button', { name: 'Chat actions', exact: true })]) {
      await trigger.click();
      await page.getByRole('menuitem', { name: 'Put under…', exact: true }).waitFor();
      for (const name of ['Put under…', 'Move to project…', 'New project from these…']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1, name);
      await page.getByRole('menuitem', { name: 'Put under…', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await row(page, 'chat-a').getByRole('button', { name: /^Expand agents/ }).click();
    await row(page, 'native-agent').getByRole('button', { name: 'Actions for Native worker', exact: true }).click();
    await page.getByRole('menu').waitFor();
    for (const name of ['Put under…', 'Move to project…', 'New project from these…', 'Take out']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1, 'native agents share the same display organization actions');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('new project uses the desktop folder chooser; cancelling the chooser keeps the selection', async () => {
  const f = await open(), { page } = f;
  try {
    await page.evaluate(() => { window.elpisDesktop.chooseFolder = async () => null; });
    await mark(page); await action(page, children[0], 'New project from these…');
    const dialog = page.getByRole('alertdialog', { name: 'New project', exact: true });
    await dialog.getByLabel('Project name', { exact: true }).fill('Chosen folder');
    await dialog.getByRole('button', { name: 'Choose folder…', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Save project', exact: true }).isDisabled(), true, 'cancel must not choose a folder');
    assert.equal(await aside(page).locator('.thread-row.selected').count(), 6);
    await page.evaluate(() => { window.elpisDesktop.chooseFolder = async () => '/work/chosen'; window.elpisDesktop.resolveFolder = async folder => folder; });
    await dialog.getByRole('button', { name: 'Choose folder…', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await eventually(async () => assert.deepEqual((await ids(project(page, 'Chosen folder'))).sort(), children));
    assert.equal(await project(page, 'Chosen folder').getByRole('button', { name: 'Chosen folder', exact: true }).getAttribute('title'), '/work/chosen');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
