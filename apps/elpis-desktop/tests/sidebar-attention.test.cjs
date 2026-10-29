// The sidebar says which chats need you, as Claude's desktop app does: an unread reply, "Needs your approval · …",
// "Waiting for your answer" and "Plan ready for review" under the chat's name, and Mark as read / unread / completed.
// The exported UI against tests/parity-fixture.cjs; bridge events are sent with its `emit`. Screenshots go to
// $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const shots = process.env.ELPIS_PARITY_SHOTS;

const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();
const dot = (page, id) => row(page, id).locator('.conversation-status');
const finish = (f, threadId, turnId) => f.emit('message', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
async function screenshot(page, name) {
  if (!shots) return;
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.locator('aside.sidebar').screenshot({ path: path.join(shots, name) });
}
async function eventually(check, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

test('a reply that finishes in a chat you are not looking at is unread until you open it, even after a restart', async () => {
  const f = await fixture(), { page } = f;
  try {
    await f.open('chat-a');
    finish(f, 'chat-a', 'ta'); finish(f, 'chat-b', 'tb');
    await eventually(async () => assert.equal(await dot(page, 'chat-b').getAttribute('aria-label'), 'Unread response. Mark as read'));
    assert.equal(await dot(page, 'chat-a').count(), 0, 'the chat you are reading is read');
    const weight = id => row(page, id).locator('.thread-title').evaluate(element => Number(getComputedStyle(element).fontWeight));
    assert.ok(await weight('chat-b') > await weight('chat-c'), 'an unread chat’s name stands out');
    await page.reload();
    await row(page, 'chat-b').waitFor();
    assert.equal(await dot(page, 'chat-b').getAttribute('data-state'), 'unread');
    await f.open('chat-b');
    await eventually(async () => assert.equal(await dot(page, 'chat-b').count(), 0));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the dot, the menu, U and Mark all as read mark chats read and unread', async () => {
  const f = await fixture(), { page } = f;
  try {
    finish(f, 'chat-b', 'tb'); finish(f, 'chat-c', 'tc');
    const recents = page.locator('aside.sidebar section[aria-label="Recents"]');
    await recents.getByRole('button', { name: 'Mark all as read' }).click();
    for (const id of ['chat-b', 'chat-c']) assert.equal(await dot(page, id).count(), 0);
    assert.equal(await recents.getByRole('button', { name: 'Mark all as read' }).count(), 0, 'nothing unread, no button');
    // The unread dot is a button: it marks the chat read without opening it.
    finish(f, 'chat-b', 'tb2');
    await row(page, 'chat-b').getByRole('button', { name: 'Unread response. Mark as read' }).click();
    assert.equal(await dot(page, 'chat-b').count(), 0);
    assert.equal(await f.shown(), null, 'marking read does not open the chat');
    finish(f, 'chat-b', 'tb2');
    await page.waitForTimeout(100);
    assert.equal(await dot(page, 'chat-b').count(), 0, 'a repeated completion does not restore an unread dot');
    f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-b', turn: { id: 'failed', status: 'failed', error: { message: 'Stopped' }, items: [] } } });
    await page.waitForTimeout(100);
    assert.equal(await dot(page, 'chat-b').count(), 0, 'a failed turn is not an unread response');
    // The row's menu, and U on a focused row, as in Claude's sidebar.
    await row(page, 'chat-c').click({ button: 'right' });
    const item = page.getByRole('menuitem', { name: /^Mark as unread/ });
    assert.equal(await item.locator('.kbd-hint, kbd').first().textContent().catch(() => ''), 'U');
    await item.click();
    assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), 'unread');
    await row(page, 'chat-c').locator('.thread-link').focus();
    await page.keyboard.press('u');
    assert.equal(await dot(page, 'chat-c').count(), 0);
    await page.keyboard.press('u');
    assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), 'unread');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a selected chat is unread on another page; a new turn clears a plan waiting for review', async () => {
  const f = await fixture(), { page } = f;
  try {
    await f.open('chat-a');
    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    finish(f, 'chat-a', 'background');
    await eventually(async () => assert.equal(await dot(page, 'chat-a').getAttribute('data-state'), 'unread'));
    await f.open('chat-a');
    assert.equal(await dot(page, 'chat-a').count(), 0);
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-b', turnId: 'plan-turn', item: { id: 'p', type: 'plan', text: 'Review this' } } });
    finish(f, 'chat-b', 'plan-turn');
    await row(page, 'chat-b').getByText('Plan ready for review').waitFor();
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-b', turn: { id: 'next', status: 'inProgress', items: [] } } });
    await row(page, 'chat-b').locator('.thread-subtitle').waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a Love Spot reply that arrives while the Love Spot board is open is read; another chat\'s reply is not', async () => {
  const matilda = { ...THREADS[0], id: 'matilda-chat', name: 'Love Spot', preview: 'Love Spot' };
  const f = await fixture({ threads: [...THREADS, matilda] }), { page } = f;
  try {
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Love Spot', exact: true }).click();
    await page.locator('section.love-spot').waitFor();
    finish(f, 'matilda-chat', 'matilda-reply'); finish(f, 'chat-b', 'tb');
    await eventually(async () => assert.equal(await dot(page, 'chat-b').getAttribute('data-state'), 'unread'));
    assert.equal(await dot(page, 'matilda-chat').count(), 0, 'Matilda\'s reply on the open board is read');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`a waiting chat says why under its name; Mark as completed clears a ready plan (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, width: 1130, height: 820 }), { page } = f;
  try {
    const line = id => row(page, id).locator('.thread-subtitle');
    await eventually(async () => assert.equal(f.listening(), 1));
    f.emit('approval', { id: 'ap-1', ownerThreadId: 'chat-b', method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-b', command: 'npm run test -- --runInBand --coverage --reporters=default --watchAll=false', reason: 'Run the tests' } });
    f.emit('approval', { id: 'ap-2', ownerThreadId: 'chat-c', method: 'item/tool/requestUserInput', params: { threadId: 'chat-c', questions: [{ id: 'q', header: 'Pick', question: 'Which file?' }] } });
    await eventually(async () => assert.equal(await line('chat-b').textContent(), 'Needs your approval · npm run test -- --runInBand --coverage --reporters=default…'));
    assert.equal(await line('chat-c').textContent(), 'Waiting for your answer');
    assert.equal(await dot(page, 'chat-b').getAttribute('data-state'), 'waiting');
    // The line stays inside the row and is cut, not wrapped.
    const fits = await line('chat-b').evaluate(element => { const box = element.getBoundingClientRect(), rowBox = element.closest('.thread-row').getBoundingClientRect(); return box.right <= rowBox.right + 0.5 && element.scrollWidth > element.clientWidth && getComputedStyle(element).whiteSpace === 'nowrap'; });
    assert.ok(fits);
    await screenshot(page, `attention-waiting-${colorScheme}.png`);
    f.emit('approvalResolved', { id: 'ap-1' });
    await line('chat-b').waitFor({ state: 'detached' });
    // A plan that finished in Plan mode waits for review until it is answered or marked completed.
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-b', turn: { id: 'tp', status: 'inProgress', items: [] } } });
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-b', turnId: 'tp', item: { id: 'plan-1', type: 'plan', text: '1. Rename the lexer\n2. Add tests' } } });
    finish(f, 'chat-b', 'tp');
    await eventually(async () => assert.equal(await line('chat-b').textContent(), 'Plan ready for review'));
    await screenshot(page, `attention-plan-${colorScheme}.png`);
    await page.reload();
    await eventually(async () => assert.equal(await line('chat-b').textContent(), 'Plan ready for review'));
    await row(page, 'chat-b').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: /^Mark as unread|^Mark as read/ }).count(), 0, 'a ready plan is completed, not read');
    await page.getByRole('menuitem', { name: /^Mark as completed/ }).click();
    await line('chat-b').waitFor({ state: 'detached' });
    assert.equal(await dot(page, 'chat-b').count(), 0);
    finish(f, 'chat-c', 'new-reply');
    await eventually(async () => assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), 'unread'));
    await screenshot(page, `attention-unread-${colorScheme}.png`);
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-c', turn: { id: 'next-turn', status: 'inProgress', items: [] } } });
    await eventually(async () => assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), 'working'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const newerTurn of [true, false]) test(`an in-flight idle list preserves only a newer runtime status (${newerTurn})`, async () => {
  let hold = false, release, requested;
  const pending = new Promise(resolve => { requested = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const chats = ['a', 'b', 'c'].map(id => ({ id: `chat-${id}`, name: `Chat ${id}`, cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } }));
  const f = await fixture({ routes: { '/api/threads': async () => {
    if (hold) { hold = false; requested(); await waiting; return { data: chats.map(chat => chat.id === 'chat-c' ? { ...chat, name: 'Refreshed chat' } : chat), nextCursor: null }; }
    return { data: chats, nextCursor: null };
  } } }), { page } = f;
  try {
    await eventually(() => assert.equal(f.listening(), 1));
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-c', turn: { id: 'first-turn', status: 'inProgress', items: [] } } });
    await eventually(async () => assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), 'working'));
    hold = true; finish(f, 'chat-c', 'first-turn'); await pending;
    if (newerTurn) {
      f.emit('message', { method: 'turn/started', params: { threadId: 'chat-c', turn: { id: 'newer-turn', status: 'inProgress', items: [] } } });
      await eventually(async () => assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), 'working'));
    }
    release();
    await row(page, 'chat-c').getByText('Refreshed chat', { exact: true }).waitFor();
    assert.equal(await dot(page, 'chat-c').getAttribute('data-state'), newerTurn ? 'working' : 'unread');
    await screenshot(page, newerTurn ? 'attention-working-newer.png' : 'attention-idle-list.png');
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});

// 29 Oct, Masih: "This mark all as read also doesn't make sense when I've already read all of them!" His one unread chat sat
// in a collapsed section; only rows on screen count.
test('an unread chat folded away in a collapsed section does not offer Mark all as read; one on screen does', async () => {
  const f = await fixture({ storage: { 'elpis-pinned-chats-v1': JSON.stringify(['chat-b']), 'elpis-sidebar-folds-v1': JSON.stringify({ sections: { pinned: true }, projects: {} }) } }), { page } = f;
  try {
    await f.open('chat-a');
    const recents = page.locator('aside.sidebar section[aria-label="Recents"]');
    finish(f, 'chat-b', 'tb');
    await page.waitForTimeout(300);
    assert.equal(await recents.getByRole('button', { name: 'Mark all as read' }).count(), 0, 'the unread chat is in the collapsed Pinned section');
    finish(f, 'chat-c', 'tc');
    await recents.getByRole('button', { name: 'Mark all as read' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
