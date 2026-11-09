// Chats organised in the sidebar, as Claude's desktop app organises sessions: "Move to group" in a chat's menu (one chat
// or several selected), "New group…", groups that collapse and say when a chat in them waits for you, "Rename group" and
// "Delete group", and a "Group and sort" menu (Group by: Custom groups or None; Sort by: Last activity, Date created or
// Name). Groups live on this computer (the desktop store's elpis-chat-groups-v1). The exported UI against
// tests/parity-fixture.cts, a mock bridge: no engine and no model. Captures go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cts');
const shots = process.env.ELPIS_PARITY_SHOTS;
type Box = { x: number; y: number; width: number; height: number };
type Locator = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; getByText(text: string, options?: object): Locator; first(): Locator; waitFor(options?: object): Promise<void>; click(options?: object): Promise<void>; hover(): Promise<void>; focus(): Promise<void>; press(key: string): Promise<void>; fill(value: string): Promise<void>; count(): Promise<number>; isDisabled(): Promise<boolean>; getAttribute(name: string): Promise<string | null>; allTextContents(): Promise<string[]>; all(): Promise<Locator[]>; textContent(): Promise<string | null>; boundingBox(): Promise<Box | null>; elementHandle(): Promise<Element>; evaluate<T>(fn: (el: HTMLElement) => T): Promise<T>; evaluateAll<T>(fn: (rows: HTMLElement[]) => T): Promise<T> };
type Page = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; waitForFunction<T>(fn: (value: T) => unknown, value?: T): Promise<unknown>; keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> }; mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void> } };
/** Four chats with creation times (seconds, as the engine sends them); the bridge lists them a, b, c, d. */
const LISTED = ([['chat-a', 'Fix the parser', 100], ['chat-b', 'Write the docs', 300], ['chat-c', 'Plan the release', 200], ['chat-d', 'Add the tests', 400]] as [string, string, number][])
  .map(([id, name, createdAt]) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, createdAt }));

const aside = (page: Page) => page.locator('aside.sidebar');
const row = (page: Page, id: string) => aside(page).locator(`.thread-row[data-thread-id="${id}"]`).first();
const recents = (page: Page) => aside(page).locator('section[aria-label="Recents"]');
const idsIn = (locator: Locator) => locator.locator('.thread-row').evaluateAll(rows => rows.map(element => element.dataset.threadId));

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
