const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, oranges } = require('./controls.cjs');

const evidence = path.join(os.homedir(), '.cache/elpis-tests/desktop-small-fixes');
const chat = (id, name, extra = {}) => ({ id, name, cwd: CWD, source: 'cli', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const personal = chat('chat-a', 'Fix the parser');
const runs = [chat('run-a', 'Inspect the parser', { source: 'exec' }), chat('run-b', 'Review the parser', { source: { subAgent: {} }, status: { type: 'active' } })];
const settings = () => ({ main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], write: { available: false } });
const user = page => page.locator('.message.user').filter({ hasText: 'Show this immediately.' });
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

for (const colorScheme of ['light', 'dark']) test(`Enter paints before thread creation and keeps the same message node on engine echo (${colorScheme})`, async t => {
  let releaseCreate, releaseTurn;
  const created = new Promise(resolve => { releaseCreate = resolve; }), turned = new Promise(resolve => { releaseTurn = resolve; });
  const f = await fixture({ colorScheme, routes: {
    '/api/threads': async body => body ? (await created, { thread: chat('fresh', 'New task') }) : { data: [personal], nextCursor: null },
    '/api/threads/fresh/turns': async () => { await turned; return { turn: { id: 'fresh-turn' } }; },
  } });
  t.after(async () => { releaseCreate(); releaseTurn(); await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.composer.fill('Show this immediately.'); await f.composer.press('Enter');
  await user(f.page).waitFor({ timeout: 800 });
  await fs.mkdir(evidence, { recursive: true });
  await f.page.screenshot({ path: path.join(evidence, `submitted-before-engine-${colorScheme}.png`) });
  const position = await user(f.page).boundingBox();
  await f.page.evaluate(() => { window.__sentNode = [...document.querySelectorAll('.message.user')].find(node => node.textContent.includes('Show this immediately.')); });
  releaseCreate();
  await f.page.waitForFunction(() => document.querySelector('.thread-row[data-thread-id="fresh"]'));
  f.emit('message', { method: 'item/started', params: { threadId: 'fresh', turnId: 'fresh-turn', item: { id: 'engine-user', type: 'userMessage', content: [{ type: 'text', text: 'Show this immediately.' }] } } });
  await tick(f.page);
  assert.equal(await user(f.page).count(), 1, 'the engine echo does not duplicate the submitted message');
  releaseTurn(); await f.page.waitForFunction(() => document.querySelector('textarea').value === ''); await tick(f.page);
  assert.equal(await f.page.evaluate(() => window.__sentNode.isConnected), true, 'the optimistic DOM node stays mounted');
  const after = await user(f.page).boundingBox();
  assert.ok(Math.abs(after.x - position.x) < 1 && Math.abs(after.y - position.y) < 1, 'acknowledgement and echo keep the message in place');
  f.emit('message', { method: 'item/completed', params: { threadId: 'fresh', turnId: 'fresh-turn', item: { id: 'engine-user', type: 'userMessage', content: [{ type: 'text', text: 'Show this immediately.' }] } } });
  await tick(f.page); assert.equal(await user(f.page).count(), 1);
});

test('a refused send removes the optimistic message, preserves the draft and never leaks into another chat', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture({ routes: { '/api/threads/chat-a/turns': async () => { await held; return { __http: 503, error: 'Submission refused for test.' }; } } });
  t.after(async () => { release(); await f.close(); assert.deepEqual(f.errors, []); });
  await f.open('chat-a'); await f.composer.fill('Show this immediately.'); await f.composer.press('Enter');
  await user(f.page).waitFor({ timeout: 800 });
  await f.page.locator('.thread-row[data-thread-id="chat-b"] .thread-link').click();
  assert.equal(await user(f.page).count(), 0);
  release(); await f.page.waitForTimeout(100);
  await f.open('chat-a'); await f.page.getByText('Submission refused for test.', { exact: true }).waitFor();
  assert.equal(await user(f.page).count(), 0);
  assert.equal(await f.composer.inputValue(), 'Show this immediately.');
});

test('an existing chat keeps repeated prompts and reconciles an echo after acknowledgement and a later history read', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture({ chat: [['old', 'Show this immediately.', 'Prior answer']], routes: {
    '/api/threads/chat-a/turns': async () => { await held; return { turn: { id: 'new-turn' } }; },
  } });
  t.after(async () => { release(); await f.close(); assert.deepEqual(f.errors, []); });
  await f.open('chat-a'); await f.composer.fill('Show this immediately.'); await f.composer.press('Enter');
  await f.page.waitForFunction(() => document.querySelectorAll('.message.user').length === 2, { timeout: 800 });
  await user(f.page).last().evaluate(node => { window.__sentNode = node; });
  release(); await f.page.waitForFunction(() => document.querySelector('textarea').value === '');
  f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 'new-turn', item: { id: 'u-new-turn', type: 'userMessage', content: [{ type: 'text', text: 'Show this immediately.' }] } } });
  await tick(f.page);
  assert.equal(await user(f.page).count(), 2, 'old identical prompts stay distinct');
  assert.equal(await f.page.evaluate(() => window.__sentNode.isConnected), true);
  f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 'new-turn', status: 'completed' } } });
  await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached' });
  f.turns.push(['new-turn', 'Show this immediately.', 'New answer']);
  await f.open('chat-b'); await f.open('chat-a');
  assert.equal(await user(f.page).count(), 2, 'a later authoritative history read still shows one copy per send');
  await user(f.page).last().click({ button: 'right' });
  await f.page.getByRole('menuitem', { name: 'Rewind to here', exact: true }).click();
  const dialog = f.page.getByRole('alertdialog');
  await dialog.getByText('No file checkpoint for this message.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Rewind', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await user(f.page).count(), 1, 'rewind does not revive the removed submission');
});

test('failed thread creation removes the unsent transcript entry and preserves its draft', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture({ routes: { '/api/threads': async body => body ? (await held, { __http: 503, error: 'Could not create this chat.' }) : { data: [personal], nextCursor: null } } });
  t.after(async () => { release(); await f.close(); assert.deepEqual(f.errors, []); });
  await f.composer.fill('Show this immediately.'); await f.composer.press('Enter');
  await user(f.page).waitFor({ timeout: 800 }); release();
  await f.page.getByText('Could not create this chat.', { exact: true }).waitFor();
  assert.equal(await user(f.page).count(), 0);
  assert.equal(await f.composer.inputValue(), 'Show this immediately.');
});

for (const colorScheme of ['light', 'dark']) test(`sidebar arrows cover navigation, Search, projects and Recents with Enter activation (${colorScheme})`, async t => {
  const f = await fixture({ colorScheme, storage: { 'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'parser', name: 'Parser project', cwd: CWD }], selectedId: null }) } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f, nav = page.locator('aside.sidebar');
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  const start = nav.getByRole('button', { name: 'New chat', exact: true }); await start.focus();
  for (const name of ['Lab', 'Workflows', 'Love Spot', 'Ledger']) {
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), name);
  }
  await page.keyboard.press('ArrowDown');
  assert.equal(await nav.getByLabel('Search conversations').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await nav.getByRole('switch', { name: 'Session Manager', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.match(await page.evaluate(() => document.activeElement.textContent), /Parser project/);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.thread-row')?.dataset.threadId), 'chat-a');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.thread-row')?.dataset.threadId), 'chat-c');
  await page.keyboard.press('Enter'); await page.locator('.thread-row.active[data-thread-id="chat-c"]').first().waitFor();
  await page.keyboard.press('Home'); assert.equal(await start.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.getByRole('toolbar', { name: 'Add to Workflows', exact: true }).waitFor();
  await start.click();
  await nav.getByLabel('Search conversations').fill('parser'); await page.keyboard.press('Home');
  assert.equal(await nav.getByLabel('Search conversations').evaluate(node => node === document.activeElement), true, 'Home edits a nonempty search');
});

for (const colorScheme of ['light', 'dark']) test(`Agent runs hide persistently from menu and Settings, and history deletion confirms and undoes (${colorScheme})`, async t => {
  let listed = [personal, ...runs], deleted = [];
  const f = await fixture({ colorScheme, height: 900, storage: { 'elpis-preferences-v1': JSON.stringify({ confirmDeleteChats: false }) }, routes: {
    '/api/settings': settings,
    '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [] : listed, nextCursor: null }),
    '/api/trash': body => { deleted = listed.filter(thread => body.threadIds.includes(thread.id)); listed = listed.filter(thread => !body.threadIds.includes(thread.id)); return { trashed: deleted.map(thread => thread.id) }; },
    '/api/trash/undo': () => { listed.push(...deleted); return { threads: deleted }; },
  } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f, menu = () => page.getByRole('button', { name: 'Agent runs actions', exact: true });
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await menu().click();
  await fs.mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `agent-runs-menu-${colorScheme}.png`) });
  await page.getByRole('menuitem', { name: 'Hide Agent runs', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /Agent runs \(/ }).count(), 0);
  await page.reload(); await openSettings(page);
  const setting = page.getByRole('switch', { name: 'Show Agent runs in sidebar', exact: true });
  assert.equal(await setting.getAttribute('aria-checked'), 'false'); await setting.click();
  await setting.click(); assert.equal(await setting.getAttribute('aria-checked'), 'false');
  await setting.click(); await leaveSettings(page);
  await menu().click(); await page.getByRole('menuitem', { name: 'Delete Agent run history…', exact: true }).click();
  const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
  assert.equal(f.posts.filter(post => post.path === '/api/trash').length, 0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(f.posts.filter(post => post.path === '/api/trash').length, 0);
  await menu().click(); await page.getByRole('menuitem', { name: 'Delete Agent run history…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  assert.deepEqual(f.posts.find(post => post.path === '/api/trash').body.threadIds, ['run-a', 'run-b']);
  assert.equal(await page.locator('.thread-row[data-thread-id="chat-a"]').count(), 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Agent runs (2)', exact: true }).waitFor();
});

test('light-theme colour guard permits A87 accent paint and still rejects orange text and unrelated fills', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.evaluate(() => {
    const other = document.createElement('span'); other.id = 'unexpected-fill'; other.textContent = 'Other fill'; other.style.backgroundColor = '#ff8a00';
    const primary = document.createElement('button'); primary.id = 'primary-probe'; primary.className = 'primary-cut'; primary.dataset.slot = 'button'; primary.textContent = 'Unreadable text'; primary.style.color = '#f2a93b';
    const accent = document.createElement('span'); accent.id = 'accent-text-probe'; accent.textContent = 'Amber text'; accent.style.color = '#f2a93b';
    document.body.append(other, primary, accent);
  });
  const hits = await oranges(f.page);
  assert.ok(hits.some(hit => hit.includes('span#unexpected-fill') && hit.includes('background-color')));
  assert.ok(hits.some(hit => hit.includes('button#primary-probe') && hit.includes(': color')));
  assert.ok(hits.some(hit => hit.includes('span#accent-text-probe') && hit.includes(': color')), 'approved accent paint does not permit unreadable text');
  assert.equal(hits.some(hit => hit.includes('button#primary-probe') && hit.includes('background-color')), false, 'only the approved primary fill is exempt');
  await f.page.evaluate(() => { document.querySelector('#unexpected-fill').remove(); document.querySelector('#primary-probe').remove(); document.querySelector('#accent-text-probe').remove(); });
  assert.deepEqual(await oranges(f.page), []);
});

test('large Agent runs groups delete a labeled batch within the existing trash limit', async t => {
  const many = Array.from({ length: 105 }, (_, i) => chat(`run-${i}`, `Task ${i}`, { source: 'exec' }));
  const f = await fixture({ routes: {
    '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [] : [personal, ...many], nextCursor: null }),
    '/api/trash': body => ({ trashed: body.threadIds }),
  } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.getByRole('button', { name: 'Agent runs actions', exact: true }).click();
  await f.page.getByRole('menuitem', { name: 'Delete 100 Agent runs…', exact: true }).click();
  const dialog = f.page.getByRole('alertdialog');
  await dialog.getByText('Delete 100 chats?', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await f.page.getByRole('button', { name: 'Agent runs (5)', exact: true }).waitFor();
  const ids = f.posts.find(post => post.path === '/api/trash').body.threadIds;
  assert.equal(ids.length, 100); assert.equal(ids.includes('chat-a'), false);
});

for (const colorScheme of ['light', 'dark']) test(`send keeps amber and shared parallel cuts when enabled, disabled and narrow (${colorScheme})`, async t => {
  const f = await fixture({ colorScheme, width: 1280, height: 860 });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f, send = page.getByRole('button', { name: 'Send message', exact: true });
  const appearance = () => send.evaluate(node => { const s = getComputedStyle(node), c = getComputedStyle(document.querySelector('.composer')); return { corners: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius], shape: s.cornerTopLeftShape, composerShape: c.cornerTopLeftShape, background: s.backgroundColor, foreground: s.color, opacity: s.opacity }; });
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  const disabled = await appearance();
  assert.deepEqual(disabled.corners, ['7px', '0px', '7px', '0px']);
  assert.equal(disabled.shape, disabled.composerShape);
  await f.composer.fill('Ready to send'); await page.waitForTimeout(200); const enabled = await appearance();
  assert.equal(disabled.background, enabled.background, 'disabled keeps the amber fill');
  assert.notEqual(disabled.opacity, enabled.opacity, 'disabled stays distinguishable');
  assert.notEqual(enabled.background, enabled.foreground);
  await fs.mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `send-enabled-${colorScheme}.png`) });
  await f.composer.fill(''); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(evidence, `send-disabled-${colorScheme}.png`) });
  await page.setViewportSize({ width: 720, height: 860 }); await f.composer.fill('Narrow composer'); await page.waitForTimeout(200);
  assert.deepEqual((await appearance()).corners, enabled.corners);
  assert.equal(await send.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), true);
  await page.screenshot({ path: path.join(evidence, `send-narrow-${colorScheme}.png`) });
});

test('sidebar pages reorder by drag and drop and by Alt+Arrow, and keep their order after a reload', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f, nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  const order = () => nav.getByRole('button').allInnerTexts().then(names => names.map(name => name.trim()));
  assert.deepEqual(await order(), ['New chat', 'Lab', 'Workflows', 'Love Spot', 'Ledger']);
  await nav.getByRole('button', { name: 'Love Spot', exact: true }).dragTo(nav.getByRole('button', { name: 'Lab', exact: true }), { targetPosition: { x: 20, y: 4 } });
  assert.deepEqual(await order(), ['New chat', 'Love Spot', 'Lab', 'Workflows', 'Ledger'], 'dropped on the top half of Lab, it goes above Lab');
  await nav.getByRole('button', { name: 'Ledger', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('Alt+ArrowUp');
  assert.deepEqual(await order(), ['New chat', 'Love Spot', 'Ledger', 'Lab', 'Workflows'], 'Alt+Up moves the focused page up');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Ledger', 'focus stays on the moved page');
  await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
  assert.deepEqual(await order(), ['New chat', 'Love Spot', 'Ledger', 'Lab', 'Workflows'], 'the order is saved');
});

// P6: during a turn the bridge sends account events (usage updates); each reloads the model list. A "Loading models…"
// line inserted above the chat for that moment pushed the whole conversation down and back: the shake in Masih's recording.
test('a background model refresh leaves the chat still: no Loading models line once models are known', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f;
  await f.open('chat-a');
  await page.getByRole('status').filter({ hasText: 'Loading models' }).waitFor({ state: 'detached' });
  for (const end = Date.now() + 5000; !f.listening() && Date.now() < end;) await page.waitForTimeout(20);
  await page.evaluate(() => {
    window.__loadingLines = 0;
    new MutationObserver(() => { if ([...document.querySelectorAll('[role=status]')].some(node => node.textContent.includes('Loading models'))) window.__loadingLines++; })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const message = page.locator('.message').first(), before = await message.boundingBox();
  for (let n = 0; n < 3; n++) {
    const reloaded = page.waitForResponse(response => response.url().endsWith('/api/models'));
    f.emit('account', {}); await reloaded; await page.waitForTimeout(100);
  }
  assert.equal(await page.evaluate(() => window.__loadingLines), 0, 'a refresh with models already shown inserts no line above the chat');
  assert.deepEqual(await message.boundingBox(), before, 'the conversation does not move');
});
