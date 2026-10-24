// Manual order in the sidebar: dragging a chat onto another reorders it (not only into a group), the order is saved on
// this computer (elpis-chat-groups-v1) and survives a reload, Pinned / each group / Recents keep their own chats, Alt+Up/Down
// does the same from the keyboard, and the first move switches Sort by to Manual from the order shown. Real pointer drags
// against tests/parity-fixture.cjs, a mock bridge: no engine and no model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const KEY = 'elpis-chat-groups-v1';
const LISTED = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter, index) => ({ id: `chat-${letter}`, name: `Chat ${letter.toUpperCase()}`, preview: `Chat ${letter.toUpperCase()}`, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, createdAt: 100 + index }));
const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : LISTED, nextCursor: null }) };
// Pinned: a, b. Group "Work": c. Recents: d, e, f. Last activity (the bridge's order).
const storage = (extra = {}) => ({
  'elpis-pinned-chats-v1': JSON.stringify(['chat-a', 'chat-b']),
  [KEY]: JSON.stringify({ groups: [{ id: 'g1', name: 'Work' }], members: { 'chat-c': 'g1' }, groupBy: 'custom', sortBy: 'recency', collapsed: [], ...extra }),
});
const open = (extra, more = {}) => fixture({ routes, storage: storage(extra), height: 1100, ...more });

const aside = page => page.locator('aside.sidebar');
const row = (page, id) => aside(page).locator(`.thread-row[data-thread-id="${id}"]`).first();
const section = (page, name) => aside(page).locator(`section[aria-label="${name}"]`);
const work = page => aside(page).getByRole('group', { name: 'Work', exact: true });
const idsIn = locator => locator.locator('.thread-row').evaluateAll(rows => rows.map(element => element.dataset.threadId));
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), KEY).catch(() => ({}));
async function eventually(check, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}
const centre = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
/** A pointer drag: down on `from`, in steps to `to` (at `where`: top or bottom half of a row, middle of a heading), optionally checking
 * the indicator before letting go. */
async function drag(page, from, to, where = 'top', during) {
  const start = await centre(from.locator('.thread-link').first());
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 4, start.y + 4, { steps: 3 });
  const end = await centre(to);
  const y = where === 'top' ? end.box.y + 3 : where === 'bottom' ? end.box.y + end.box.height - 3 : end.y;
  await page.mouse.move(end.x, y, { steps: 8 });
  if (during) await during();
  await page.mouse.up();
}

test('dragging reorders Recents with a visible drop line, saves a manual order, and keeps it after a reload', async () => {
  const f = await open(), { page } = f;
  try {
    await row(page, 'chat-f').waitFor();
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-d', 'chat-e', 'chat-f']);
    await drag(page, row(page, 'chat-f'), row(page, 'chat-d'), 'top', async () => {
      await eventually(async () => assert.equal(await row(page, 'chat-d').getAttribute('data-drop'), 'before'));
      const line = await row(page, 'chat-d').evaluate(element => getComputedStyle(element).boxShadow);
      assert.match(line, /inset/, `a line is drawn where it will land: ${line}`);
      assert.equal(await row(page, 'chat-e').getAttribute('data-drop'), null, 'only the target shows it');
    });
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-f', 'chat-d', 'chat-e']));
    assert.equal(await row(page, 'chat-d').getAttribute('data-drop'), null, 'the line is gone after the drop');
    const state = await stored(page);
    assert.equal(state.sortBy, 'manual'); assert.deepEqual(state.order.slice(0, 6).sort(), LISTED.map(chat => chat.id));
    // The lower half drops after the target.
    await drag(page, row(page, 'chat-f'), row(page, 'chat-e'), 'bottom', async () => {
      await eventually(async () => assert.equal(await row(page, 'chat-e').getAttribute('data-drop'), 'after'));
    });
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-d', 'chat-e', 'chat-f']));
    await drag(page, row(page, 'chat-e'), row(page, 'chat-d'), 'top');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-d', 'chat-f']));
    await page.reload(); await row(page, 'chat-d').waitFor();
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-d', 'chat-f'], 'the order survives a reload');
    assert.deepEqual(await idsIn(section(page, 'Pinned')), ['chat-a', 'chat-b']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Pinned reorders inside itself only; a pinned chat cannot be dropped among Recents, nor a recent among Pinned', async () => {
  const f = await open(), { page } = f;
  try {
    await row(page, 'chat-b').waitFor();
    await drag(page, row(page, 'chat-b'), row(page, 'chat-a'), 'top');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Pinned')), ['chat-b', 'chat-a']));
    // Refused: no line over the target, nothing moves, nothing is saved as a move.
    await drag(page, row(page, 'chat-a'), row(page, 'chat-e'), 'top', async () => assert.equal(await row(page, 'chat-e').getAttribute('data-drop'), null, 'no drop line where a drop is refused'));
    await drag(page, row(page, 'chat-e'), row(page, 'chat-b'), 'top', async () => assert.equal(await row(page, 'chat-b').getAttribute('data-drop'), null));
    await drag(page, row(page, 'chat-d'), aside(page).getByRole('group', { name: 'Work', exact: true }).locator('.sidebar-group-row'), 'middle'); // a legal move, so the checks below see a settled state
    await eventually(async () => assert.deepEqual(await idsIn(work(page)), ['chat-c', 'chat-d']));
    assert.deepEqual(await idsIn(section(page, 'Pinned')), ['chat-b', 'chat-a'], 'pinned chats are still pinned, in their order');
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-f']);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('elpis-pinned-chats-v1'))), ['chat-a', 'chat-b'], 'pins themselves are untouched');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a drop on a group heading, on a row in another group, or on the Recents heading moves the chat there, at the right place', async () => {
  const f = await open(), { page } = f;
  try {
    await row(page, 'chat-e').waitFor();
    const heading = work(page).locator('.sidebar-group-row');
    await drag(page, row(page, 'chat-e'), heading, 'middle', async () => {
      await eventually(async () => assert.equal(await heading.getAttribute('data-drop'), 'into'));
    });
    await eventually(async () => assert.deepEqual(await idsIn(work(page)), ['chat-c', 'chat-e']), 4000);
    await drag(page, row(page, 'chat-f'), row(page, 'chat-c'), 'top');
    await eventually(async () => assert.deepEqual(await idsIn(work(page)), ['chat-f', 'chat-c', 'chat-e']), 4000);
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-d']);
    const recentsHeading = section(page, 'Recents').locator('.section-label-row');
    await drag(page, row(page, 'chat-e'), recentsHeading, 'middle', async () => {
      await eventually(async () => assert.equal(await recentsHeading.getAttribute('data-drop'), 'into'));
    });
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-d']));
    assert.deepEqual(await idsIn(work(page)), ['chat-f', 'chat-c']);
    await page.reload(); await row(page, 'chat-d').waitFor();
    assert.deepEqual(await idsIn(work(page)), ['chat-f', 'chat-c'], 'group and order survive a reload');
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-d']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the first move from a sorted list switches Sort by to Manual from the order shown, and Manual is a choice in the menu', async () => {
  const f = await open({ sortBy: 'name', groupBy: 'none', members: {} }), { page } = f;
  try {
    await row(page, 'chat-f').waitFor();
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-c', 'chat-d', 'chat-e', 'chat-f'], 'sorted A to Z (Pinned shown apart)');
    await drag(page, row(page, 'chat-f'), row(page, 'chat-c'), 'top');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-f', 'chat-c', 'chat-d', 'chat-e'], 'only the dragged chat moved; the others kept the order they showed'));
    await aside(page).getByRole('button', { name: 'Group and sort' }).click();
    assert.equal(await page.getByRole('menuitemradio', { name: /^Manual/ }).getAttribute('aria-checked'), 'true');
    await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click();
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-c', 'chat-d', 'chat-e', 'chat-f'], 'choosing Name sorts again'));
    await page.getByRole('menuitemradio', { name: /^Manual/ }).click();
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-f', 'chat-c', 'chat-d', 'chat-e'], 'Manual brings the saved order back'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Alt+Up/Down reorders the focused chat inside its section and keeps focus; plain arrows, F2 and the context menu are unaffected', async () => {
  const f = await open(), { page } = f;
  try {
    const link = id => row(page, id).locator('.thread-link');
    await row(page, 'chat-e').waitFor();
    await link('chat-e').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-d', 'chat-f']));
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.thread-row')?.dataset.threadId), 'chat-e', 'focus stays on the moved chat');
    await page.keyboard.press('Alt+ArrowUp'); // already first in Recents: it does not jump into the group above
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-e', 'chat-d', 'chat-f']);
    assert.deepEqual(await idsIn(work(page)), ['chat-c']);
    await page.keyboard.press('Alt+ArrowDown'); await page.keyboard.press('Alt+ArrowDown'); await page.keyboard.press('Alt+ArrowDown');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-d', 'chat-f', 'chat-e']));
    await link('chat-b').focus(); await page.keyboard.press('Alt+ArrowUp');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Pinned')), ['chat-b', 'chat-a']));
    await page.keyboard.press('Alt+ArrowUp'); assert.deepEqual(await idsIn(section(page, 'Pinned')), ['chat-b', 'chat-a'], 'the first pinned chat stays first');
    const state = await stored(page); assert.equal(state.sortBy, 'manual');
    await page.reload(); await row(page, 'chat-d').waitFor();
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-d', 'chat-f', 'chat-e']);
    assert.deepEqual(await idsIn(section(page, 'Pinned')), ['chat-b', 'chat-a']);
    // A plain arrow still opens the neighbour; F2 still renames the focused row; right-click still opens the menu.
    await link('chat-d').focus(); await page.keyboard.press('ArrowDown');
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement?.closest('.thread-row')?.dataset.threadId), 'chat-f'));
    await page.keyboard.press('F2');
    const dialog = page.getByRole('alertdialog'); await dialog.getByLabel('Conversation name').waitFor();
    assert.equal(await dialog.getByLabel('Conversation name').inputValue(), 'Chat F');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await row(page, 'chat-d').click({ button: 'right' });
    await page.getByRole('menu').first().waitFor();
    assert.equal(await page.getByRole('menuitem', { name: 'Rename' }).count(), 1);
    await page.keyboard.press('Escape');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('typing is untouched: Alt+Up/Down and F2 in the search box reorder and rename nothing; a search list cannot be dragged', async () => {
  const f = await open(), { page } = f;
  try {
    await row(page, 'chat-d').waitFor();
    const before = await idsIn(section(page, 'Recents'));
    const search = page.getByRole('searchbox').first().or(page.getByPlaceholder(/search/i).first());
    await search.fill('Chat'); await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('F2');
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await row(page, 'chat-d').getAttribute('draggable'), null, 'search results are not draggable');
    await search.fill('');
    assert.deepEqual(await idsIn(section(page, 'Recents')), before);
    assert.equal(await row(page, 'chat-d').getAttribute('draggable'), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 24 Oct screenshot: an idle chat dragged above a working one snapped back, because Recents kept running chats first.
test('a chat dropped above a working one stays where it was dropped', async () => {
  const working = LISTED.map(chat => chat.id === 'chat-d' ? { ...chat, status: { type: 'active', activeFlags: [] } } : chat);
  const f = await fixture({ routes: { '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : working, nextCursor: null }) }, storage: storage(), height: 1100 }), { page } = f;
  try {
    await row(page, 'chat-f').waitFor();
    assert.equal((await idsIn(section(page, 'Recents')))[0], 'chat-d', 'a working chat comes first while the list is sorted');
    await drag(page, row(page, 'chat-f'), row(page, 'chat-d'), 'top');
    await eventually(async () => assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-f', 'chat-d', 'chat-e']));
    await page.reload(); await row(page, 'chat-d').waitFor();
    assert.deepEqual(await idsIn(section(page, 'Recents')), ['chat-f', 'chat-d', 'chat-e'], 'and after a reload');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
