// A100/A102: the exported renderer, using the real bridge's status shapes and saved attention keys.
// This is a mock-bridge regression check; sidebar-order-real.cjs exercises the packaged app separately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`);
const ids = locator => locator.locator('.thread-row').evaluateAll(rows => rows.map(row => row.dataset.threadId));
const section = (page, name) => page.locator(`aside.sidebar section[aria-label="${name}"]`);
async function eventually(check) {
  const end = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 30)); } }
}
const chat = (id, updatedAt, status = { type: 'idle' }) => ({ id, name: id, cwd: CWD, updatedAt, status });
function open(chats, storage = {}, extra = {}) {
  return fixture({ storage, routes: {
    '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : chats, nextCursor: null }),
    ...Object.fromEntries(chats.map(thread => [`/api/threads/${thread.id}`, () => ({ thread, data: [], nextCursor: null })])),
    ...extra,
  } });
}
const attention = unread => ({ 'elpis-chat-attention-v1': JSON.stringify({ unread, plans: {} }) });

test('A100: one highlighted manager above Pinned and Recents, outside the scroller, even in search', async () => {
  const f = await open([chat('chat-a', 50), chat('manager', 1)], { 'elpis-session-manager-v1': 'manager', 'elpis-pinned-chats-v1': '["manager","chat-a"]' });
  const { page } = f;
  try {
    const button = page.getByRole('button', { name: 'Open Session Manager', exact: true });
    await button.click();
    await eventually(async () => assert.equal(await button.getAttribute('aria-current'), 'page'));
    assert.equal(await row(page, 'manager').count(), 1);
    assert.equal(await row(page, 'manager').evaluate(row => row.classList.contains('active')), true);
    assert.equal(await row(page, 'manager').evaluate(row => !!row.closest('.thread-list')), false);
    assert.equal(await row(page, 'manager').evaluate(row => {
      const box = row.getBoundingClientRect(), label = row.querySelector('.thread-title').getBoundingClientRect(), icon = row.querySelector('svg').getBoundingClientRect();
      return label.top >= box.top && label.bottom <= box.bottom && label.right <= box.right && Math.abs((label.top + label.bottom - icon.top - icon.bottom) / 2) < 2;
    }), true, 'manager label fits inside its row, level with its icon');
    assert.equal(await button.evaluate(button => !!(button.compareDocumentPosition(document.querySelector('section[aria-label="Pinned"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    if (process.env.ELPIS_PARITY_SHOTS) {
      await fs.mkdir(process.env.ELPIS_PARITY_SHOTS, { recursive: true });
      for (const theme of ['light', 'dark']) {
        if (theme === 'dark') await chooseTheme(page, theme);
        await page.locator('.startup-splash').waitFor({ state: 'detached' });
        await page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `regression-manager-${theme}.png`) });
      }
    }
    await page.getByRole('textbox', { name: 'Search conversations' }).fill('manager');
    await eventually(async () => assert.equal(await row(page, 'manager').count(), 1));
    assert.equal(await button.isVisible(), true);
    await page.getByRole('textbox', { name: 'Search conversations' }).fill('');
    await row(page, 'chat-a').locator('.thread-link').click();
    assert.equal(await button.getAttribute('aria-current'), null, 'another chat removes the highlight');
    await page.reload();
    await button.waitFor();
    await button.click();
    await eventually(async () => assert.equal(await button.getAttribute('aria-current'), 'page'));
    assert.equal(f.posts.filter(post => post.path === '/api/threads').length, 0, 'reuses the saved manager');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const count of [0, 1, 20, 200]) for (const mode of ['idle', 'only-unseen', 'mixed']) test(`A102: ${count} chats, ${mode}, saved unseen replies precede seen recency`, async () => {
  const chats = Array.from({ length: count }, (_, i) => chat(i ? `chat-${i}` : 'chat-a', count - i));
  // The shared fixture waits for chat-a. For zero ordinary chats, it is the dedicated manager.
  const list = count ? chats : [chat('chat-a', 0)];
  const unread = chats.filter((_, i) => mode === 'only-unseen' || mode === 'mixed' && i % 3 === 2).map(chat => chat.id);
  const f = await open(list, { ...attention(unread), ...(!count ? { 'elpis-session-manager-v1': 'chat-a' } : {}) });
  try {
    await eventually(async () => assert.deepEqual(await ids(section(f.page, 'Recents')), [...chats.filter(chat => unread.includes(chat.id)), ...chats.filter(chat => !unread.includes(chat.id))].map(chat => chat.id)));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A102: bridge recency changes reorder idle chats outside interaction; equal timestamps keep their place', async () => {
  const chats = [chat('chat-a', 10), chat('chat-b', 30), chat('chat-c', 30)];
  const f = await open(chats);
  try {
    await eventually(async () => assert.deepEqual(await ids(section(f.page, 'Recents')), ['chat-b', 'chat-c', 'chat-a']));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A100: a rejected manager creation leaves one available row and does not invent a chat', async () => {
  const f = await open([chat('chat-a', 1)], {}, { '/api/threads': (body, url) => body ? { __http: 503, error: 'Manager unavailable' } : { data: url.searchParams.get('archived') === 'true' ? [] : [chat('chat-a', 1)], nextCursor: null } });
  try {
    const button = f.page.getByRole('button', { name: 'Open Session Manager', exact: true });
    await button.click();
    await f.page.getByRole('alert').filter({ hasText: 'Could not open Session Manager: Manager unavailable' }).waitFor();
    assert.equal(await button.count(), 1);
    assert.equal(await button.isEnabled(), true);
    assert.equal(await button.getAttribute('aria-current'), null);
    assert.deepEqual(await ids(section(f.page, 'Recents')), ['chat-a']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A100: a manager registered by another window takes its one fixed place; a matching name alone is ordinary', async () => {
  const f = await open([chat('chat-a', 20), { ...chat('chat-b', 10), name: 'Session Manager' }]);
  try {
    assert.deepEqual(await ids(section(f.page, 'Recents')), ['chat-a', 'chat-b'], 'names do not identify the dedicated manager');
    await f.page.evaluate(() => {
      localStorage.setItem('elpis-session-manager-v1', 'chat-b');
      dispatchEvent(new StorageEvent('storage', { key: 'elpis-session-manager-v1', newValue: 'chat-b' }));
    });
    await eventually(async () => assert.deepEqual(await ids(section(f.page, 'Recents')), ['chat-a']));
    assert.equal(await row(f.page, 'chat-b').count(), 1);
    await f.page.getByRole('button', { name: 'Open Session Manager', exact: true }).click();
    await eventually(async () => assert.equal(await f.page.getByRole('button', { name: 'Open Session Manager', exact: true }).getAttribute('aria-current'), 'page'));
    assert.equal(f.posts.filter(post => post.path === '/api/threads').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A102: waiting at the first, middle and last position; resolving it restores recency, with long titles contained', async () => {
  const chats = Array.from({ length: 20 }, (_, i) => ({ ...chat(i ? `chat-${i}` : 'chat-a', 20 - i), ...(i === 10 ? { name: 'Long project conversation '.repeat(30) } : {}) }));
  const f = await open(chats), expected = chats.map(chat => chat.id);
  try {
    for (const index of [0, 10, 19]) {
      const threadId = chats[index].id;
      f.emit('message', { method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } });
      await eventually(async () => assert.deepEqual(await ids(section(f.page, 'Recents')), [threadId, ...expected.filter(id => id !== threadId)]));
      assert.equal(await row(f.page, threadId).locator('.thread-title').evaluate(title => title.getBoundingClientRect().right <= title.closest('.thread-row').getBoundingClientRect().right), true);
      f.emit('message', { method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
      await eventually(async () => assert.deepEqual(await ids(section(f.page, 'Recents')), expected));
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A102: archived unseen/waiting chats never enter the live list; a not-loaded unseen chat does', async () => {
  const live = [chat('chat-a', 20), chat('unseen', 10, { type: 'notLoaded' })];
  const archived = chat('archived', 100, { type: 'active', activeFlags: ['waitingOnApproval'] });
  const f = await open(live, attention(['archived', 'unseen']), { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? [archived] : live, nextCursor: null }) });
  try {
    await eventually(async () => assert.deepEqual(await ids(section(f.page, 'Recents')), ['unseen', 'chat-a']));
    assert.equal(await row(f.page, 'archived').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A102: waiting flags and approvals beat unseen; working, errors and seen replies do not', async () => {
  const chats = [chat('chat-a', 100), chat('working', 90, { type: 'active' }), chat('error', 80, { type: 'systemError' }), chat('done', 20), chat('question', 10, { type: 'active', activeFlags: ['waitingOnUserInput'] }), chat('approval', 5, { type: 'active', activeFlags: ['waitingOnApproval'] })];
  const f = await open(chats, attention(['done', 'working', 'error']));
  try {
    const recents = section(f.page, 'Recents');
    await eventually(async () => assert.deepEqual(await ids(recents), ['question', 'approval', 'done', 'chat-a', 'working', 'error']));
    f.emit('approval', { id: 'ap', ownerThreadId: 'chat-a', method: 'item/tool/requestUserInput', params: { questions: [] } });
    await eventually(async () => assert.deepEqual(await ids(recents), ['chat-a', 'question', 'approval', 'done', 'working', 'error']));
    f.emit('approvalResolved', { id: 'ap' });
    await eventually(async () => assert.equal((await ids(recents))[0], 'question'));
    await row(f.page, 'done').locator('.thread-link').click();
    await f.page.mouse.move(700, 300);
    await eventually(async () => assert.equal(await row(f.page, 'done').locator('.thread-dot').getAttribute('data-state'), 'idle'));
    assert.deepEqual(await ids(recents), ['question', 'approval', 'chat-a', 'working', 'error', 'done']);
    await f.page.reload();
    await row(f.page, 'chat-a').waitFor();
    assert.equal(await row(f.page, 'done').locator('.thread-dot').getAttribute('data-state'), 'idle');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A102: Pinned stays separate; project and custom groups use the same priority', async () => {
  const chats = [chat('chat-a', 100), chat('recent', 90), chat('done', 20), chat('wait', 10, { type: 'active', activeFlags: ['waitingOnApproval'] }), chat('pin', 1)];
  for (const project of [false, true]) {
    const storage = { ...attention(['done']), 'elpis-pinned-chats-v1': '["pin"]',
      ...(project ? { 'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'g', name: 'Work', cwd: CWD }], selectedId: null }), 'elpis-project-chats-v1': JSON.stringify({ recent: 'g', done: 'g', wait: 'g' }) }
        : { 'elpis-chat-groups-v1': JSON.stringify({ groups: [{ id: 'g', name: 'Work' }], members: { recent: 'g', done: 'g', wait: 'g' }, groupBy: 'custom', sortBy: 'recency', collapsed: [], order: [] }) }) };
    const f = await open(chats, storage);
    try {
      await eventually(async () => assert.deepEqual(await ids(f.page.getByRole('group', { name: 'Work', exact: true })), ['wait', 'done', 'recent']));
      assert.deepEqual(await ids(section(f.page, 'Pinned')), ['pin']);
      assert.deepEqual(await ids(section(f.page, 'Recents')), ['chat-a']);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('A102: status updates and reading cannot move rows under the pointer, including a held click outside', async () => {
  const f = await open([chat('chat-a', 30), chat('chat-b', 20), chat('chat-c', 10)]);
  const { page } = f;
  try {
    const recents = section(page, 'Recents');
    await row(page, 'chat-a').locator('.thread-link').hover();
    const before = await ids(recents);
    await page.mouse.down();
    f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-c', turn: { id: 'done', status: 'completed', items: [] } } });
    await eventually(async () => assert.equal(await row(page, 'chat-c').locator('.thread-dot').getAttribute('data-state'), 'unread'));
    assert.deepEqual(await ids(recents), before);
    await page.mouse.up();
    assert.equal(await row(page, 'chat-a').evaluate(row => row.classList.contains('active')), true, 'the intended chat receives the click');
    assert.deepEqual(await ids(recents), before);
    await page.mouse.down(); await page.mouse.move(700, 300);
    assert.deepEqual(await ids(recents), before, 'leaving with a button held keeps the positions');
    await page.mouse.move(100, 480);
    assert.deepEqual(await ids(recents), before, 'reentering with the button held keeps the same positions');
    await page.mouse.move(700, 300);
    await page.mouse.up();
    await eventually(async () => assert.deepEqual(await ids(recents), ['chat-c', 'chat-a', 'chat-b']));
    await row(page, 'chat-c').locator('.thread-link').click();
    assert.deepEqual(await ids(recents), ['chat-c', 'chat-a', 'chat-b'], 'reading does not move the clicked row until the pointer leaves');
    await page.mouse.move(700, 300);
    await eventually(async () => assert.deepEqual(await ids(recents), ['chat-a', 'chat-b', 'chat-c']));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A102: newly loaded chats append during interaction and keep their positions until release', async () => {
  const chats = [chat('chat-a', 30), chat('chat-b', 20), chat('chat-c', 10)];
  const f = await open(chats), { page } = f;
  try {
    const recents = section(page, 'Recents');
    await row(page, 'chat-a').locator('.thread-link').hover();
    chats.push(chat('new-1', 40));
    f.emit('message', { method: 'thread/status/changed', params: { threadId: 'new-1', status: { type: 'idle' } } });
    await eventually(async () => assert.deepEqual(await ids(recents), ['chat-a', 'chat-b', 'chat-c', 'new-1']));
    chats.push(chat('new-2', 50, { type: 'active', activeFlags: ['waitingOnApproval'] }));
    f.emit('message', { method: 'thread/status/changed', params: { threadId: 'new-2', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
    await eventually(async () => assert.deepEqual(await ids(recents), ['chat-a', 'chat-b', 'chat-c', 'new-1', 'new-2']));
    await page.mouse.move(700, 300);
    await eventually(async () => assert.deepEqual(await ids(recents), ['new-2', 'new-1', 'chat-a', 'chat-b', 'chat-c']));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
