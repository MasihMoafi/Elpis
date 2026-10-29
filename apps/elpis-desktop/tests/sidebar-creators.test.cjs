const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { fixture, CWD } = require('./parity-fixture.cjs');

const maker = '00000000-0000-0000-0000-0000000000a1';
const children = ['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3'];
const at = 1792827361;
const chat = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', source: 'vscode',
  createdAt: at, status: { type: 'idle' }, ...extra });

for (const colorScheme of ['light', 'dark']) test(`creator history uses the shared folded branch in every sidebar section (${colorScheme})`, async t => {
  const { DesktopClient } = await import('../bridge/client.mjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-click-'));
  const transcript = path.join(home, 'creator.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ timestamp: new Date((at + 18) * 1000).toISOString(), type: 'response_item',
    payload: { type: 'custom_tool_call_output', output: JSON.stringify({ children }) } }) + '\n');
  const listed = [chat('chat-a', 'Unrelated chat'), chat(maker, 'car-scraper-pro', { threadSource: 'user', createdAt: at - 100, path: transcript }),
    ...children.map((id, i) => chat(id, `BoomDeal · ${i ? 'Hamrah' : 'Bama'}`, { threadSource: null })),
    chat('native', 'Project parent'), chat('native-child', 'Native child', { parentThreadId: 'native' }),
    chat('manual', 'Pinned parent'), chat('manual-child', 'Display child'),
    chat('workflow', 'Running workflow'), chat('workflow-child', 'Workflow child')];
  const socket = new EventEmitter(); socket.close = () => {};
  socket.send = raw => {
    const request = JSON.parse(raw); if (request.id === undefined) return;
    const thread = listed.find(thread => thread.id === request.params?.threadId);
    const result = request.method === 'thread/list' ? { data: structuredClone(listed), nextCursor: null } : { thread };
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket, { spawnLinksFile: path.join(home, 'links.json'), archiveDirectory: path.join(home, 'archives'),
    rewindHome: path.join(home, 'rewind'), workflowOptions: { stateDir: path.join(home, 'workflows') }, githubConnector: { instructions: async () => null } });
  t.after(() => client.close());
  const runs = [{ id: 'run-one', rootThreadId: 'workflow', name: 'Running workflow', status: 'running', tasks: [{ id: 'task', title: 'Workflow child', assignedThreadId: 'workflow-child', status: 'running' }] }];
  const routes = {
    '/api/threads': (_body, url) => url.searchParams.get('archived') === 'true' || url.searchParams.has('ancestorThreadId') ? { data: [], nextCursor: null } : client.listThreads(),
    '/api/workflows/history': () => ({ data: runs }),
  };
  for (const thread of listed) {
    const read = async () => (await client.listThreads()).data.find(row => row.id === thread.id);
    routes[`/api/threads/${thread.id}`] = async () => ({ thread: await read(), data: [], nextCursor: null });
    routes[`/api/threads/${thread.id}/resume`] = async () => ({ thread: await read(), activeTurnId: null });
  }
  // S18, Masih 29 Oct: Background runs and the sidebar's Workflows section are off by default; this test turns them on.
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, routes, threads: listed, storage: {
    'elpis-preferences-v1': JSON.stringify({ showAgentRuns: true, sidebarWorkflows: true }),
    'elpis-last-chat': maker,
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p', name: 'Project', cwd: CWD }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ native: 'p' }),
    'elpis-pinned-chats-v1': JSON.stringify(['manual']),
    'elpis-chat-groups-v1': JSON.stringify({ groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [], parents: { 'manual-child': 'manual' } }),
  } });
  try {
    const { page } = f, side = page.locator('aside.sidebar');
    const row = id => side.locator(`.thread-row[data-thread-id="${id}"]`);
    await row(maker).and(page.locator('.active')).waitFor();
    // Workflows starts folded (sidebar-folds.ts); open it as the person does to reach the workflow family.
    const workflows = side.locator('section[aria-label="Workflows"] .section-toggle');
    await workflows.waitFor(); assert.equal(await workflows.getAttribute('aria-expanded'), 'false', 'the Workflows section starts folded');
    await workflows.click();
    const families = [[maker, children], ['native', ['native-child']], ['manual', ['manual-child']], ['workflow', ['workflow-child']]];
    const shot = async state => { const directory = path.join(os.homedir(), '.cache/elpis-shots'); await fs.mkdir(directory, { recursive: true }); await page.screenshot({ path: path.join(directory, `creators-${colorScheme}-${state}.png`) }); };
    for (const [parent, kids] of families) {
      const toggle = row(parent).getByRole('button', { name: /(?:agents|chats) in/ });
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${parent} starts folded, including the restored parent and running workflows`);
      for (const id of kids) assert.equal(await row(id).count(), 0, `${id} is not a loose top-level chat`);
    }
    assert.equal(await row('chat-a').count(), 1, 'an unmentioned chat remains top-level');
    await shot('folded');
    for (const [parent, kids] of families) {
      await row(parent).getByRole('button', { name: /(?:agents|chats) in/ }).click();
      for (const id of kids) {
        await row(id).waitFor();
        assert.equal(await row(id).evaluate(element => element.classList.contains('child')), true, 'the existing child row owns indentation');
        const positions = await Promise.all([row(parent), row(id)].map(node => node.locator('.thread-title').evaluate(element => element.getBoundingClientRect().x)));
        assert.equal(positions[1] - positions[0], 14, 'one shared indent step');
      }
    }
    await row(children[0]).locator('.thread-link').click();
    await row(children[0]).and(page.locator('.active')).waitFor();
    assert.equal(await row('chat-a').count(), 1);
    await shot('expanded');
    // Restore a parent, so the permitted reveal of an explicitly opened child cannot mask a startup expansion.
    await row(maker).locator('.thread-link').click();
    await row(maker).and(page.locator('.active')).waitFor();
    await page.reload();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await row(maker).and(page.locator('.active')).waitFor();
    for (const [parent, kids] of families) {
      assert.equal(await row(parent).getByRole('button', { name: /(?:agents|chats) in/ }).getAttribute('aria-expanded'), 'false', `${parent} folds again after reopening`);
      for (const id of kids) assert.equal(await row(id).count(), 0);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
