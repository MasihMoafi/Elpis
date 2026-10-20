// Chats organised in the sidebar, as Claude's desktop app organises sessions: "Move to group" in a chat's menu (one chat
// or several selected), "New group…", groups that collapse and say when a chat in them waits for you, "Rename group" and
// "Delete group", and a "Group and sort" menu (Group by: Custom groups or None; Sort by: Last activity, Date created or
// Name). Groups live on this computer (the desktop store's elpis-chat-groups-v1). The exported UI against
// tests/parity-fixture.cjs, a mock bridge: no engine and no model. Captures go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { uiFit } = require('./ui-fit.cjs');
const shots = process.env.ELPIS_PARITY_SHOTS;

const KEY = 'elpis-chat-groups-v1';
const saved = (groups, members, extra = {}) => ({ [KEY]: JSON.stringify({ groups: groups.map(([id, name]) => ({ id, name })), members, groupBy: 'custom', sortBy: 'recency', collapsed: [], ...extra }) });
/** Four chats with creation times (seconds, as the engine sends them); the bridge lists them a, b, c, d. */
const LISTED = [['chat-a', 'Fix the parser', 100], ['chat-b', 'Write the docs', 300], ['chat-c', 'Plan the release', 200], ['chat-d', 'Add the tests', 400]]
  .map(([id, name, createdAt]) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, createdAt }));
const listed = { '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : LISTED, nextCursor: null }) };

const aside = page => page.locator('aside.sidebar');
const row = (page, id) => aside(page).locator(`.thread-row[data-thread-id="${id}"]`).first();
const group = (page, name) => aside(page).getByRole('group', { name, exact: true });
const groupToggle = (page, name) => group(page, name).locator('.sidebar-group-toggle');
const recents = page => aside(page).locator('section[aria-label="Recents"]');
const idsIn = locator => locator.locator('.thread-row').evaluateAll(rows => rows.map(element => element.dataset.threadId));
const groupNames = page => aside(page).locator('.chat-group .sidebar-group-toggle .sidebar-group-name').allTextContents();
/** Opens the chat's "Move to group" submenu: by right-click, by its "…" button, or by keys (Shift+F10, type "Mo", →).
 * The pointer moves onto the item in steps, as a hand does; the submenu opens on hover. */
async function moveMenu(page, id, how = 'right-click') {
  const name = /^Move (\d+ chats )?to group/;
  if (how === 'keys') {
    await row(page, id).locator('.thread-link').focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menu').first().waitFor();
    await page.keyboard.type('Mo');
    await page.keyboard.press('ArrowRight');
  } else {
    if (how === 'right-click') await row(page, id).click({ button: 'right' });
    else { await row(page, id).hover(); await row(page, id).locator('.thread-actions').click(); }
    const box = await page.getByRole('menuitem', { name }).boundingBox();
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  }
  const submenu = page.getByRole('menu', { name });
  await submenu.waitFor();
  return submenu;
}
async function eventually(check, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}
const changes = posts => posts.filter(post => !/\/(resume|read|rewind)$|^\/api\/session$/.test(post.path));

test('a chat moves into a new group from its menu; the list switches to custom groups and keeps it after a reload', async () => {
  const f = await fixture(), { page } = f;
  try {
    const submenu = await moveMenu(page, 'chat-b');
    assert.deepEqual(await submenu.getByRole('menuitemradio').allTextContents(), ['Ungrouped'], 'no groups yet');
    assert.equal(await submenu.getByRole('menuitem', { name: 'Change this…' }).count(), 0, 'Improve Elpis’s item stays in the chat’s menu, not in the submenu');
    assert.equal(await page.getByRole('menu').first().getByRole('menuitem', { name: 'Change this…' }).count(), 1);
    assert.equal(await submenu.getByRole('menuitemradio', { name: 'Ungrouped' }).getAttribute('aria-checked'), 'true');
    await submenu.getByRole('menuitem', { name: 'New group…' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'New group' });
    await dialog.getByText('The list will switch to Custom groups to show it.').waitFor();
    const create = dialog.getByRole('button', { name: 'Create group' });
    assert.equal(await create.isDisabled(), true, 'an empty name cannot be created');
    await dialog.getByRole('textbox', { name: 'Group name' }).fill('  Docs ');
    await create.click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await groupNames(page), ['Docs']);
    assert.deepEqual(await idsIn(group(page, 'Docs')), ['chat-b']);
    assert.deepEqual(await idsIn(recents(page)), ['chat-a', 'chat-c'], 'the chat is no longer under Recents');
    // The "…" menu has the same item; a name already taken, in any case, is refused.
    const again = await moveMenu(page, 'chat-a', '…');
    assert.deepEqual(await again.getByRole('menuitemradio').allTextContents(), ['Docs', 'Ungrouped']);
    assert.equal(await again.getByRole('menuitemradio', { name: 'Docs' }).getAttribute('aria-checked'), 'false');
    await again.getByRole('menuitem', { name: 'New group…' }).click();
    const second = page.getByRole('alertdialog', { name: 'New group' });
    assert.equal(await second.getByText('The list will switch to Custom groups to show it.').count(), 0, 'the list already shows groups');
    await second.getByRole('textbox', { name: 'Group name' }).fill(' docs ');
    await second.getByText('A group with this name already exists.').waitFor();
    assert.equal(await second.getByRole('button', { name: 'Create group' }).isDisabled(), true);
    await second.getByRole('button', { name: 'Cancel' }).click();
    await page.reload();
    await row(page, 'chat-b').waitFor();
    assert.deepEqual(await idsIn(group(page, 'Docs')), ['chat-b'], 'the group and its chat survive a reload');
    assert.deepEqual(changes(f.posts), [], 'nothing about groups goes to the bridge');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('"Ungrouped" and another group move a chat; two selected chats move together', async () => {
  const f = await fixture({ storage: saved([['g1', 'Work'], ['g2', 'Home']], { 'chat-a': 'g1' }) }), { page } = f;
  try {
    assert.deepEqual(await idsIn(group(page, 'Work')), ['chat-a']);
    let submenu = await moveMenu(page, 'chat-a');
    assert.equal(await submenu.getByRole('menuitemradio', { name: 'Work' }).getAttribute('aria-checked'), 'true');
    await submenu.getByRole('menuitemradio', { name: 'Home' }).click();
    await eventually(async () => assert.deepEqual(await idsIn(group(page, 'Home')), ['chat-a']));
    assert.deepEqual(await idsIn(group(page, 'Work')), []);
    assert.equal(await page.getByRole('menu').count(), 0, 'choosing closes the menu');
    submenu = await moveMenu(page, 'chat-a', 'keys');
    // By keys: → opens the submenu on its first choice; ↓ to Ungrouped, Enter takes it.
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Work'));
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Ungrouped');
    await page.keyboard.press('Enter');
    await eventually(async () => assert.deepEqual(await idsIn(recents(page)), ['chat-a', 'chat-b', 'chat-c']));
    // Ctrl+click marks two chats; the menu then acts on both.
    await row(page, 'chat-b').locator('.thread-link').click({ modifiers: ['Control'] });
    await row(page, 'chat-c').locator('.thread-link').click({ modifiers: ['Control'] });
    submenu = await moveMenu(page, 'chat-c');
    assert.equal(await page.getByRole('menuitem', { name: 'Move 2 chats to group' }).count(), 1);
    await submenu.getByRole('menuitemradio', { name: 'Work' }).click();
    await eventually(async () => assert.deepEqual(await idsIn(group(page, 'Work')), ['chat-b', 'chat-c']));
    assert.deepEqual(await idsIn(recents(page)), ['chat-a']);
    assert.deepEqual(changes(f.posts), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a group collapses and expands by click and by key, stays so after a reload, and says when a chat in it waits for you', async () => {
  const f = await fixture({ storage: saved([['g1', 'Work']], { 'chat-b': 'g1' }) }), { page } = f;
  try {
    const toggle = groupToggle(page, 'Work'), waiting = group(page, 'Work').getByRole('img', { name: 'A chat in this group is waiting on you' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await row(page, 'chat-b').count(), 0, 'a collapsed group hides its chats');
    await page.reload();
    await row(page, 'chat-a').waitFor();
    assert.equal(await groupToggle(page, 'Work').getAttribute('aria-expanded'), 'false', 'collapsed after a reload');
    assert.equal(await waiting.count(), 0);
    f.emit('approval', { id: 'ap-1', ownerThreadId: 'chat-b', method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-b', command: 'npm test', reason: 'Run the tests' } });
    await waiting.waitFor();
    assert.equal(await waiting.getAttribute('title'), 'A chat in this group is waiting on you');
    await groupToggle(page, 'Work').focus();
    await page.keyboard.press('Enter');
    assert.equal(await groupToggle(page, 'Work').getAttribute('aria-expanded'), 'true');
    await row(page, 'chat-b').waitFor();
    assert.equal(await waiting.count(), 0, 'open, the chat shows its own state');
    await page.keyboard.press('Space');
    assert.equal(await groupToggle(page, 'Work').getAttribute('aria-expanded'), 'false');
    f.emit('approvalResolved', { id: 'ap-1' });
    await waiting.waitFor({ state: 'detached' });
    // A plan waiting for review needs you too.
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-b', turn: { id: 'tp', status: 'inProgress', items: [] } } });
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-b', turnId: 'tp', item: { id: 'plan-1', type: 'plan', text: '1. Rename' } } });
    f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-b', turn: { id: 'tp', status: 'completed', items: [] } } });
    await waiting.waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a thread row expands and collapses its agents by click and keyboard', async () => {
  const parent = { ...LISTED[0], name: 'Task ID: CI-GATE-1 (make the Elpis desktop test gate on GitHub Actions)' };
  const child = { ...LISTED[1], id: 'agent-child', name: 'Nested agent', parentThreadId: parent.id };
  const grandchild = { ...LISTED[2], id: 'nested-agent-child', name: 'Agent under the task', parentThreadId: child.id };
  const routes = { '/api/threads': (_body, url) => {
    const ancestor = url.searchParams.get('ancestorThreadId');
    return { data: ancestor === parent.id ? [child] : ancestor === child.id ? [grandchild] : ancestor ? [] : [parent, ...LISTED.slice(1)], nextCursor: null };
  } };
  const f = await fixture({ routes }), { page } = f;
  try {
    const parentRow = row(page, parent.id);
    await parentRow.locator('.thread-link').click();
    await row(page, child.id).waitFor();
    const childRow = row(page, child.id);
    const expand = childRow.getByRole('button', { name: `Expand agents in ${child.name}` });
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    await expand.click();
    await row(page, grandchild.id).waitFor();
    const collapse = childRow.getByRole('button', { name: `Collapse agents in ${child.name}` });
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
    await collapse.click();
    assert.equal(await row(page, grandchild.id).count(), 0, 'collapsing hides nested agents');
    const collapsed = childRow.getByRole('button', { name: `Expand agents in ${child.name}` });
    await collapsed.focus();
    await page.keyboard.press('Enter');
    await row(page, grandchild.id).waitFor();
    assert.equal(await childRow.getByRole('button', { name: `Collapse agents in ${child.name}` }).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a group is renamed and deleted from its menu; deleting puts its chats back under Recents and posts nothing', async () => {
  const f = await fixture({ storage: saved([['g1', 'Work']], { 'chat-a': 'g1', 'chat-b': 'g1' }) }), { page } = f;
  try {
    await group(page, 'Work').locator('.sidebar-group-row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename group' }).click();
    const rename = page.getByRole('alertdialog', { name: 'Rename group' });
    const field = rename.getByRole('textbox', { name: 'Group name' });
    assert.equal(await field.inputValue(), 'Work');
    await field.fill('Errands');
    await rename.getByRole('button', { name: 'Save' }).click();
    await rename.waitFor({ state: 'detached' });
    assert.deepEqual(await groupNames(page), ['Errands']);
    assert.deepEqual(await idsIn(group(page, 'Errands')), ['chat-a', 'chat-b']);
    await group(page, 'Errands').locator('.sidebar-group-row').hover();
    await page.getByRole('button', { name: 'Group actions for Errands' }).click();
    await page.getByRole('menuitem', { name: 'Delete group' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete group?' });
    await confirm.getByText('“Errands” will be removed. The 2 chats in it will no longer be grouped.').waitFor();
    await confirm.getByRole('button', { name: 'Delete group' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.deepEqual(await groupNames(page), []);
    assert.deepEqual(await idsIn(recents(page)), ['chat-a', 'chat-b', 'chat-c']);
    assert.deepEqual(changes(f.posts), [], 'no chat was archived or deleted');
    await page.reload();
    await row(page, 'chat-a').waitFor();
    assert.deepEqual(await groupNames(page), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Group and sort: Name, Date created and Last activity order Pinned, groups and Recents; None shows every chat under Recents; Reset to defaults', async () => {
  const storage = { ...saved([['g1', 'Work']], { 'chat-b': 'g1', 'chat-c': 'g1' }, { groupBy: 'none' }), 'elpis-pinned-chats-v1': JSON.stringify(['chat-d', 'chat-a']) };
  const f = await fixture({ storage, routes: listed }), { page } = f;
  try {
    const pinned = aside(page).locator('section[aria-label="Pinned"]'), button = recents(page).getByRole('button', { name: 'Group and sort' });
    await row(page, 'chat-d').waitFor();
    assert.deepEqual([await idsIn(pinned), await groupNames(page), await idsIn(recents(page))], [['chat-a', 'chat-d'], [], ['chat-b', 'chat-c']]);
    assert.equal(await button.getAttribute('data-active'), null);
    await button.click();
    const menu = page.getByRole('menu', { name: 'Group and sort' });
    assert.deepEqual(await menu.getByRole('menuitemradio').allTextContents(), ['Custom groups', 'None', 'Last activity', 'Date created', 'Name', 'Manual (drag or Alt+Up/Down)']);
    assert.equal(await menu.getByRole('menuitem', { name: 'Reset to defaults' }).count(), 0, 'nothing to reset yet');
    const choose = async name => { await menu.getByRole('menuitemradio', { name, exact: true }).click(); await page.waitForTimeout(50); };
    await choose('Name');
    assert.deepEqual([await idsIn(pinned), await idsIn(recents(page))], [['chat-d', 'chat-a'], ['chat-c', 'chat-b']], 'A to Z');
    assert.equal(await menu.isVisible(), true, 'the menu stays open for another choice');
    await choose('Custom groups');
    assert.deepEqual([await groupNames(page), await idsIn(group(page, 'Work')), await idsIn(recents(page))], [['Work'], ['chat-c', 'chat-b'], []]);
    await choose('Date created');
    assert.deepEqual([await idsIn(pinned), await idsIn(group(page, 'Work'))], [['chat-d', 'chat-a'], ['chat-b', 'chat-c']], 'newest first');
    await choose('Last activity');
    assert.deepEqual([await idsIn(pinned), await idsIn(group(page, 'Work'))], [['chat-a', 'chat-d'], ['chat-b', 'chat-c']], 'the bridge’s order');
    await choose('None');
    assert.deepEqual([await groupNames(page), await idsIn(recents(page))], [[], ['chat-b', 'chat-c']]);
    await choose('Name');
    await page.keyboard.press('Escape');
    assert.equal(await button.getAttribute('data-active'), 'true', 'away from the defaults the button says so');
    await page.reload();
    await row(page, 'chat-d').waitFor();
    assert.deepEqual(await idsIn(recents(page)), ['chat-c', 'chat-b'], 'the order survives a reload');
    await button.click();
    assert.equal(await menu.getByRole('menuitemradio', { name: 'Name' }).getAttribute('aria-checked'), 'true');
    assert.equal(await menu.getByRole('menuitemradio', { name: 'None' }).getAttribute('aria-checked'), 'true');
    await menu.getByRole('menuitem', { name: 'Reset to defaults' }).click();
    await eventually(async () => assert.deepEqual(await idsIn(recents(page)), ['chat-b', 'chat-c']));
    assert.equal(await button.getAttribute('data-active'), null);
    assert.deepEqual(changes(f.posts), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('next and previous chat follow the sidebar’s order with groups and skip a collapsed group', async () => {
  const f = await fixture({ storage: saved([['g1', 'Work']], { 'chat-c': 'g1' }) }), { page } = f;
  try {
    await f.open('chat-c');
    await page.keyboard.press('Control+Shift+BracketRight');
    await aside(page).locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    await page.keyboard.press('Control+Shift+BracketLeft');
    await aside(page).locator('.thread-row.active[data-thread-id="chat-c"]').waitFor();
    await groupToggle(page, 'Work').click();
    await f.open('chat-a');
    await page.keyboard.press('Control+Shift+BracketLeft');
    await page.waitForTimeout(200);
    assert.equal(await f.shown(), 'chat-a', 'the chat in the collapsed group is skipped');
    await page.keyboard.press('Control+Shift+BracketRight');
    await aside(page).locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
/** The colour of `locator`'s text and the first opaque background behind it. */
const colours = locator => locator.evaluate(element => {
  const text = getComputedStyle(element).color; let background = 'rgb(255, 255, 255)';
  for (let at = element; at; at = at.parentElement) { const value = getComputedStyle(at).backgroundColor; if (value && !/rgba\(.*, 0\)$|transparent/.test(value)) { background = value; break; } }
  return { text, background };
});
const contrast = ({ text, background }) => { const [a, b] = [luminance(text), luminance(background)].sort((x, y) => y - x); return (a + .05) / (b + .05); };

for (const colorScheme of ['light', 'dark']) for (const width of [1280, 1440]) test(`light and dark: groups, Group and sort and Move to group fit and read well (${colorScheme}, ${width})`, async () => {
  const storage = { ...saved([['g1', 'Customer requests and follow-ups'], ['g2', 'Home']], { 'chat-a': 'g1', 'chat-b': 'g1', 'chat-c': 'g2' }, { collapsed: ['g2'] }),
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p1', name: 'parity-fixture', cwd: CWD }], selectedId: null }) };
  const f = await fixture({ colorScheme, width, height: 900, storage, routes: listed }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    f.emit('approval', { id: 'ap-1', ownerThreadId: 'chat-c', method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-c', command: 'npm test', reason: 'Run the tests' } });
    await group(page, 'Home').getByRole('img', { name: 'A chat in this group is waiting on you' }).waitFor();
    assert.deepEqual(await uiFit(aside(page)), [], 'the sidebar');
    // A custom group's header and rows line up with a project's.
    const project = aside(page).locator('.project-group').first();
    const [projectText, groupText] = await Promise.all([project.locator('.sidebar-group-name').boundingBox(), group(page, 'Customer requests and follow-ups').locator('.sidebar-group-name').boundingBox()]);
    assert.ok(Math.abs(projectText.x - groupText.x) <= 1, `group names start where project names do (${projectText.x} / ${groupText.x})`);
    const [projectRow, groupRow] = await Promise.all([project.locator('.thread-row').first().boundingBox(), group(page, 'Customer requests and follow-ups').locator('.thread-row').first().boundingBox()]);
    assert.ok(Math.abs(projectRow.x - groupRow.x) <= 1, 'a group’s chats are indented as a project’s');
    for (const name of await aside(page).locator('.chat-group .sidebar-group-name').all()) assert.ok(contrast(await colours(name)) >= 4.5, `group name contrast ${JSON.stringify(await colours(name))}`);
    // The Group and sort button sits level with the RECENTS heading's letters.
    const [label, sortButton] = await Promise.all([recents(page).locator('.section-label').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const box = range.getBoundingClientRect(); return box.top + box.height / 2; }),
      recents(page).getByRole('button', { name: 'Group and sort' }).boundingBox()]);
    assert.ok(Math.abs(label - (sortButton.y + sortButton.height / 2)) <= 1.5, `level with RECENTS (${label} / ${sortButton.y + sortButton.height / 2})`);
    if (shots) await page.screenshot({ path: path.join(shots, `groups-${colorScheme}-${width}.png`) });
    await recents(page).getByRole('button', { name: 'Group and sort' }).click();
    const menu = page.getByRole('menu', { name: 'Group and sort' });
    await menu.waitFor();
    assert.deepEqual(await uiFit(menu), [], 'the Group and sort menu');
    for (const item of await menu.locator('[role="menuitemradio"], [data-slot="dropdown-menu-label"]').all()) assert.ok(contrast(await colours(item)) >= 4.5, `menu text contrast ${await item.textContent()}`);
    if (shots) await page.screenshot({ path: path.join(shots, `group-and-sort-${colorScheme}-${width}.png`) });
    await page.keyboard.press('Escape');
    const submenu = await moveMenu(page, 'chat-d');
    assert.deepEqual(await uiFit(submenu), [], 'the Move to group submenu');
    assert.deepEqual(await uiFit(aside(page)), [], 'the sidebar under the menus');
    if (shots) await page.screenshot({ path: path.join(shots, `move-to-group-${colorScheme}-${width}.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
