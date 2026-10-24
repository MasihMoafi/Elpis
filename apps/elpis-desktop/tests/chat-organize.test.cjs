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
    await row(page, 'chat-a').getByRole('button', { name: /^Expand .*car-scraper-pro/ }).click();
    await row(page, children[0]).waitFor();
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

test('middle drag nests every marked chat; edge and keyboard moves reorder; cycles and deeper nesting are refused', async () => {
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
    assert.equal(await page.getByRole('option', { name: /^BoomDeal/ }).count(), 0, 'nested chats cannot be parents');
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
    for (const name of ['Put under…', 'Move to project…', 'New project from these…', 'Take out']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 0, 'native agent relationships cannot be reorganized');
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
