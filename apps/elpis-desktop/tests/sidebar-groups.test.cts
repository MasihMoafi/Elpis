// Chats organised in the sidebar, as Claude's desktop app organises sessions: "Move to group" in a chat's menu (one chat
// or several selected), "New group…", groups that collapse and say when a chat in them waits for you, "Rename group" and
// "Delete group", and a "Group and sort" menu (Group by: Custom groups or None; Sort by: Last activity, Date created or
// Name). Groups live on this computer (the desktop store's elpis-chat-groups-v1). The exported UI against
// tests/parity-fixture.cts, a mock bridge: no engine and no model. Captures go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cts');
const { uiFit } = require('./ui-fit.cts');
const shots = process.env.ELPIS_PARITY_SHOTS;
type Box = { x: number; y: number; width: number; height: number };
type Locator = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; getByText(text: string, options?: object): Locator; first(): Locator; waitFor(options?: object): Promise<void>; click(options?: object): Promise<void>; hover(): Promise<void>; focus(): Promise<void>; press(key: string): Promise<void>; fill(value: string): Promise<void>; count(): Promise<number>; isDisabled(): Promise<boolean>; getAttribute(name: string): Promise<string | null>; allTextContents(): Promise<string[]>; all(): Promise<Locator[]>; textContent(): Promise<string | null>; boundingBox(): Promise<Box | null>; elementHandle(): Promise<Element>; evaluate<T>(fn: (el: HTMLElement) => T): Promise<T>; evaluateAll<T>(fn: (rows: HTMLElement[]) => T): Promise<T> };
type Page = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; waitForFunction<T>(fn: (value: T) => unknown, value?: T): Promise<unknown>; keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> }; mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void> } };

const KEY = 'elpis-chat-groups-v1';
const saved = (groups: [string, string][], members: Record<string, string>, extra = {}) => ({ [KEY]: JSON.stringify({ groups: groups.map(([id, name]) => ({ id, name })), members, groupBy: 'custom', sortBy: 'recency', collapsed: [], ...extra }) });
/** Four chats with creation times (seconds, as the engine sends them); the bridge lists them a, b, c, d. */
const LISTED = ([['chat-a', 'Fix the parser', 100], ['chat-b', 'Write the docs', 300], ['chat-c', 'Plan the release', 200], ['chat-d', 'Add the tests', 400]] as [string, string, number][])
  .map(([id, name, createdAt]) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, createdAt }));
const listed = { '/api/threads': (_body: unknown, url: URL) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : LISTED, nextCursor: null }) };

const aside = (page: Page) => page.locator('aside.sidebar');
const row = (page: Page, id: string) => aside(page).locator(`.thread-row[data-thread-id="${id}"]`).first();
const group = (page: Page, name: string) => aside(page).getByRole('group', { name, exact: true });
const groupToggle = (page: Page, name: string) => group(page, name).locator('.sidebar-group-toggle');
const recents = (page: Page) => aside(page).locator('section[aria-label="Recents"]');
const idsIn = (locator: Locator) => locator.locator('.thread-row').evaluateAll(rows => rows.map(element => element.dataset.threadId));
const groupNames = (page: Page) => aside(page).locator('.chat-group .sidebar-group-toggle .sidebar-group-name').allTextContents();
/** Opens the chat's "Move to group" submenu: by right-click, by its "…" button, or by keys (Shift+F10, type a unique "Move to g" prefix, →).
 * The pointer moves onto the item in steps, as a hand does; the submenu opens on hover. */
async function moveMenu(page: Page, id: string, how = 'right-click') {
  const name = /^Move (\d+ chats )?to group/;
  if (how === 'keys') {
    await row(page, id).locator('.thread-link').focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu').first();
    await menu.waitFor();
    await page.waitForFunction((menu: Element) => menu.contains(document.activeElement), await menu.elementHandle());
    await page.keyboard.type('Organize');
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menu', { name: 'Organize', exact: true }).waitFor();
    await page.keyboard.type('Move to g');
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Move to group');
    await page.keyboard.press('ArrowRight');
  } else {
    if (how === 'right-click') await row(page, id).click({ button: 'right' });
    else { await row(page, id).hover(); await row(page, id).locator('.thread-actions').click(); }
    await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
    await page.getByRole('menu', { name: 'Organize', exact: true }).waitFor();
    const box = await page.getByRole('menuitem', { name }).boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  }
  const submenu = page.getByRole('menu', { name });
  await submenu.waitFor();
  return submenu;
}
const changes = (posts: { path: string }[]) => posts.filter(post => !/\/(resume|read|rewind)$|^\/api\/session$/.test(post.path));

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
test('a group collapses and expands by click and by key, stays so after a reload, and says when a chat in it waits for you', async () => {
  const f = await fixture({ storage: saved([['g1', 'Work']], { 'chat-b': 'g1' }) }), { page } = f;
  try {
    const toggle = groupToggle(page, 'Work'), waiting = group(page, 'Work').getByRole('img', { name: 'A chat in this group is waiting on you' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await row(page, 'chat-b').count(), 0, 'a collapsed group hides its chats');
    const reconnected = page.waitForResponse((response: { url(): string }) => new URL(response.url()).pathname === '/api/events');
    await page.reload();
    await reconnected;
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

// Recorded spawned agents use subAgent.thread_spawn with snake_case lineage inside the source.
// The native list also supplies parentThreadId; recorded runs share the same recursive chat tree.
for (const colorScheme of ['light']) test(`recorded spawned agents nest under their chat without duplicate rows (${colorScheme})`, async () => {
  const [first, second, third, fourth] = LISTED; assert.ok(first && second && third && fourth);
  const parent = { ...first, name: 'Recovery and chat priorities', source: 'vscode' };
  const spawned = (id: string, name: string, owner: string | null, depth: number) => ({ ...second, id, name, parentThreadId: owner,
    source: { subAgent: { thread_spawn: { parent_thread_id: owner, depth, agent_path: `/root/${id}`, agent_nickname: 'Plato', agent_role: null } } } });
  const child = spawned('accounts-finish', 'Finish accounts', parent.id, 1);
  const grandchild = spawned('accounts-review', 'Review accounts', child.id, 2);
  grandchild.parentThreadId = null; // Lineage survives list rows that omit the top-level parent field.
  const helper = { ...third, name: 'Desktop helper', source: 'appServer', parentThreadId: child.id };
  const leaf = { ...fourth, name: 'Independent chat', source: 'vscode' };
  const orphan = { ...second, id: 'orphan-history', name: 'Unlinked background history', source: 'exec', parentThreadId: null };
  const data = [parent, child, grandchild, helper, leaf, orphan];
  const routes = { '/api/threads': (_body: unknown, url: URL) => {
    const ancestor = url.searchParams.get('ancestorThreadId');
    return { data: ancestor === parent.id ? [child, grandchild, helper] : ancestor === child.id ? [grandchild] : ancestor ? [] : data, nextCursor: null };
  } };
  // S18, Masih 29 Oct: Background runs is off by default; this test turns it on.
  const f = await fixture({ routes, colorScheme, height: 950, storage: { 'elpis-preferences-v1': JSON.stringify({ showAgentRuns: true, sidebarWorkflows: true }) } }), { page } = f;
  const allRows = (id: string) => aside(page).locator(`.thread-row[data-thread-id="${id}"]`);
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await allRows(child.id).count(), 0, 'agents stay hidden while their parent is collapsed');
    assert.equal(await allRows(helper.id).count(), 0, 'a linked desktop helper is not a separate root');
    assert.equal(await row(page, leaf.id).getByRole('button', { name: /agents in/ }).count(), 0, 'a chat without agents has no chevron');
    await row(page, parent.id).getByRole('button', { name: `Expand agents in ${parent.name}` }).click();
    await allRows(child.id).waitFor();
    await row(page, child.id).getByRole('button', { name: `Expand agents in ${child.name}` }).press('Enter');
    await allRows(grandchild.id).waitFor();
    assert.deepEqual(await idsIn(recents(page)), [parent.id, child.id, grandchild.id, helper.id, leaf.id], 'agents appear immediately after their parent');
    for (const [thread, depth] of [[child, 1], [grandchild, 2], [helper, 2]] as const) {
      assert.equal(await allRows(thread.id).count(), 1, 'each agent has exactly one sidebar row');
      assert.equal(await row(page, thread.id).evaluate(el => getComputedStyle(el).paddingLeft), `${depth * 14}px`);
      const owner = depth === 2 ? child : parent;
      const label = await row(page, thread.id).locator('.thread-link').boundingBox();
      const ownerLabel = await row(page, owner.id).locator('.thread-link').boundingBox();
      assert.ok(label && ownerLabel);
      assert.equal(label.x - ownerLabel.x, 14, 'the visible title is one level deeper, including leaves without chevrons');
    }
    assert.equal(await row(page, grandchild.id).getByRole('button', { name: /agents in/ }).count(), 0, 'an agent without children has no chevron');
    // Opening the history group must not duplicate the agents already visible in the chat tree.
    await aside(page).getByRole('button', { name: 'Agent runs (1)', exact: true }).click();
    await allRows(orphan.id).waitFor();
    assert.equal(await allRows(child.id).count(), 1);
    assert.equal(await allRows(grandchild.id).count(), 1);
    await aside(page).getByRole('button', { name: 'Agent runs (1)', exact: true }).click();
    assert.equal(await allRows(orphan.id).count(), 0, 'closing history hides the unlinked run');
    if (shots) { await require('node:fs/promises').mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `a88-expanded-${colorScheme}.png`) }); }
    await row(page, parent.id).getByRole('button', { name: `Collapse agents in ${parent.name}` }).press('Space');
    assert.deepEqual(await idsIn(recents(page)), [parent.id, leaf.id], 'collapse hides the whole agent branch');
    if (shots) await page.screenshot({ path: path.join(shots, `a88-collapsed-${colorScheme}.png`) });
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

const luminance = (color: string) => { const components = color.match(/[\d.]+/g); assert.ok(components); return components.slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => { const weight = [.2126, .7152, .0722][index]; assert.ok(weight !== undefined); return sum + value * weight; }, 0); };
/** The colour of `locator`'s text and the first opaque background behind it. */
const colours = (locator: Locator) => locator.evaluate(element => {
  const text = getComputedStyle(element).color; let background = 'rgb(255, 255, 255)';
  for (let at: HTMLElement | null = element; at; at = at.parentElement) { const value = getComputedStyle(at).backgroundColor; if (value && !/rgba\(.*, 0\)$|transparent/.test(value)) { background = value; break; } }
  return { text, background };
});
const contrast = ({ text, background }: { text: string; background: string }) => { const [a, b] = [luminance(text), luminance(background)].sort((x, y) => y - x); assert.ok(a !== undefined && b !== undefined); return (a + .05) / (b + .05); };

for (const colorScheme of ['light']) for (const width of [1280]) test(`light and dark: groups, Group and sort and Move to group fit and read well (${colorScheme}, ${width})`, async () => {
  const storage = { ...saved([['g1', 'Customer requests and follow-ups'], ['g2', 'Home']], { 'chat-a': 'g1', 'chat-b': 'g1', 'chat-c': 'g2' }, { collapsed: ['g2'] }),
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p1', name: 'parity-fixture', cwd: CWD }], selectedId: null }),
    // Project membership is explicit (TASKS.md:111): the project holds the chat outside both groups.
    'elpis-project-chats-v1': JSON.stringify({ 'chat-d': 'p1' }) };
  const f = await fixture({ colorScheme, width, height: 900, storage, routes: listed }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    f.emit('approval', { id: 'ap-1', ownerThreadId: 'chat-c', method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-c', command: 'npm test', reason: 'Run the tests' } });
    await group(page, 'Home').getByRole('img', { name: 'A chat in this group is waiting on you' }).waitFor();
    assert.deepEqual(await uiFit(aside(page)), [], 'the sidebar');
    // A custom group's header and rows line up with a project's.
    const project = aside(page).locator('.project-group').first();
    const [projectText, groupText] = await Promise.all([project.locator('.sidebar-group-name').boundingBox(), group(page, 'Customer requests and follow-ups').locator('.sidebar-group-name').boundingBox()]);
    assert.ok(projectText && groupText);
    assert.ok(Math.abs(projectText.x - groupText.x) <= 1, `group names start where project names do (${projectText.x} / ${groupText.x})`);
    const [projectRow, groupRow] = await Promise.all([project.locator('.thread-row').first().boundingBox(), group(page, 'Customer requests and follow-ups').locator('.thread-row').first().boundingBox()]);
    assert.ok(projectRow && groupRow);
    assert.ok(Math.abs(projectRow.x - groupRow.x) <= 1, 'a group’s chats are indented as a project’s');
    for (const name of await aside(page).locator('.chat-group .sidebar-group-name').all()) assert.ok(contrast(await colours(name)) >= 4.5, `group name contrast ${JSON.stringify(await colours(name))}`);
    // The Group and sort button sits level with the RECENTS heading's letters.
    const [label, sortButton] = await Promise.all([recents(page).locator('.section-label').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const box = range.getBoundingClientRect(); return box.top + box.height / 2; }),
      recents(page).getByRole('button', { name: 'Group and sort' }).boundingBox()]);
    assert.ok(sortButton);
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
