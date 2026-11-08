import type { Locator } from './playwright-types.mts';
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { chooseTheme } = require('./controls.cts');
const { base, open, row, eventually, shot }: import("./workflow-identity.fixtures.cts").Fixtures = require("./workflow-identity.fixtures.cts");

test('failed workflow follows a resumed agent and paginated descendants without duplicate recovery', async () => {
  const saved = { id: 'observed-run', rootThreadId: 'chat-a', name: 'Observed team', status: 'failed', tasks: [
    { id: 'inspect', title: 'Inspect evidence', kind: 'research', assignedThreadId: 'observed-child', status: 'failed', failureReason: 'Previous attempt reached the weekly limit.', writeScopes: [], acceptanceCriteria: [], dependsOn: [] },
  ] };
  let working = true, rootHistoryReads = 0;
  const mother = () => base('chat-a', saved.name, working);
  const child = () => ({ ...base('observed-child', 'Evidence agent', working), parentThreadId: 'chat-a' });
  const helper = () => ({ ...base('observed-helper', 'Source checker', working), parentThreadId: 'observed-child' });
  const other = { ...base('other-run-child', 'Unrelated workflow worker', true), parentThreadId: 'other-root' };
  const f = await open('light', [saved], {}, {}, {
    '/api/workflows': () => ({ data: [saved] }),
    '/api/threads': (_body: unknown, url: URL) => ({ data: url.searchParams.has('ancestorThreadId') ? url.searchParams.has('cursor') ? [helper(), other] : [child()] : [mother(), child()], nextCursor: url.searchParams.has('ancestorThreadId') && !url.searchParams.has('cursor') ? 'second-page' : null }),
    '/api/threads/chat-a': (_body, url) => { if (url.searchParams.get('limit') === '100') rootHistoryReads++; return { thread: mother(), data: [{ turnId: 'mother-turn', item: { id: 'mother-update', type: 'agentMessage', text: 'The evidence agent is checking the source material.' }, completedAtMs: 200 }], nextCursor: null }; },
    '/api/threads/observed-child': () => ({ thread: child(), data: [], nextCursor: null }),
    '/api/threads/observed-helper': () => ({ thread: helper(), data: [], nextCursor: null }),
  });
  try {
    const { page } = f;
    await row(page, 'chat-a').locator('.thread-link').click();
    const summary = page.getByRole('region', { name: 'Workflow run', exact: true });
    const progress = page.getByRole('region', { name: 'Live workflow progress', exact: true });
    await progress.getByText(/Live: 2 working/).waitFor();
    await progress.getByText('Mother agent', { exact: true }).waitFor();
    await progress.getByText('Source checker', { exact: true }).waitFor();
    await progress.getByText(/Mother agent: The evidence agent is checking/).waitFor();
    for (const colorScheme of ['light']) {
      void colorScheme;
      for (const width of [1440, 820]) {
        await page.setViewportSize({ width, height: 900 });
        const columns = await progress.locator('.workflow-progress-row').evaluateAll(rows => rows.map(row => {
          const statusNode = row.querySelector('.workflow-progress-status'), openNode = row.querySelector('button'), identityNode = row.querySelector('.agent-identity'); if (!statusNode || !openNode || !identityNode) throw Error('Progress row is incomplete');
          const status = statusNode.getBoundingClientRect(), open = openNode.getBoundingClientRect(), identity = identityNode.getBoundingClientRect();
          return { statusX: status.x, actionX: open.x, actionRight: open.right, identityRight: identity.right };
        }));
        assert.equal(columns.length, 3, 'Mother agent, child and nested child share the row layout');
        const colours = await progress.locator('.workflow-progress-row .agent-mark').evaluateAll(marks => marks.map(mark => getComputedStyle(mark).backgroundColor));
        assert.equal(new Set(colours).size, 3, `${colorScheme}/${width}: workflow agent identities use distinct colors`);
        const firstColumn = columns[0]; assert.ok(firstColumn);
        for (const column of columns) {
          assert.ok(Math.abs(column.statusX - firstColumn.statusX) <= 1, `${colorScheme}/${width}: statuses share a column`);
          assert.ok(Math.abs(column.actionX - firstColumn.actionX) <= 1 && Math.abs(column.actionRight - firstColumn.actionRight) <= 1, `${colorScheme}/${width}: Open buttons share a column`);
          assert.ok(column.identityRight <= column.statusX, `${colorScheme}/${width}: identity fits before status`);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await shot(page, `resumed-team-chat-${colorScheme}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await eventually(async () => assert.ok(f.posts.some(post => post.path === '/api/threads/chat-a/resume')));
    const beforeOpen = { history: rootHistoryReads, resumes: f.posts.filter(post => post.path === '/api/threads/chat-a/resume').length };
    await f.composer.fill('Keep this unsent draft');
    for (const target of [progress.getByRole('button', { name: 'Open Mother agent chat', exact: true }), row(page, 'chat-a').locator('.thread-link')]) {
      await target.click(); await target.click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(rootHistoryReads, beforeOpen.history, 'opening the visible chat does not reload its history');
      assert.equal(f.posts.filter(post => post.path === '/api/threads/chat-a/resume').length, beforeOpen.resumes, 'opening the visible chat does not resume it again');
      assert.equal(await f.composer.inputValue(), 'Keep this unsent draft');
      assert.equal(await f.shown(), 'chat-a');
    }
    assert.equal(await progress.getByText('Unrelated workflow worker', { exact: true }).count(), 0, 'another run cannot enter this team');
    assert.equal(await summary.getByRole('button', { name: 'Resume workflow', exact: true }).isDisabled(), true, 'a resumed child prevents duplicate recovery');
    await summary.getByRole('button', { name: 'Open workflow canvas', exact: true }).click();
    const board = page.getByRole('region', { name: 'Workflows', exact: true });
    await board.locator('.react-flow__node[data-id="live:observed-helper"]').waitFor();
    assert.equal(await board.locator('.mother-node[data-status="running"]').count(), 1, 'Mother agent shows the observed active root');
    assert.equal(await board.locator('.react-flow__node[data-id="inspect"] .agent-node').getAttribute('data-status'), 'running');
    const visibleHeight = (locator: Locator) => locator.evaluate(element => { const box = element.getBoundingClientRect(); return Math.min(innerHeight, box.bottom) - Math.max(0, box.top); });
    assert.ok(await visibleHeight(board.locator('.canvas-board > .react-flow')) >= 300, 'the actual flat canvas has at least 300 visible pixels');
    assert.equal(await board.locator('details.canvas-log-panel').getAttribute('open'), null, 'historical failure starts collapsed');
    await shot(page, 'resumed-team-flat-light');
    await chooseTheme(page, 'dark');
    await shot(page, 'resumed-team-flat-dark');
    await chooseTheme(page, 'light');
    await page.getByRole('radio', { name: 'Isometric', exact: true }).click();
    const iso = page.getByRole('region', { name: 'Isometric board', exact: true });
    await iso.getByRole('button', { name: /^Source checker:/ }).waitFor();
    assert.ok(await visibleHeight(iso) >= 300, 'the actual isometric canvas has at least 300 visible pixels');
    await eventually(async () => {
      const framing = await iso.evaluate(element => {
        const pane = element.getBoundingClientRect();
        return [...element.querySelectorAll('.iso-node')].map(node => {
          const box = node.getBoundingClientRect();
          return { id: node.getAttribute('data-id'), fits: box.width > 0 && box.left >= pane.left && box.top >= pane.top && box.right <= pane.right && box.bottom <= pane.bottom };
        });
      });
      assert.equal(framing.length, 3, 'Mother agent, child and nested helper are actually drawn');
      assert.deepEqual(framing.filter(node => !node.fits), [], 'the settled view frames every agent, including Mother agent');
    });
    await shot(page, 'resumed-team-isometric-light');
    await chooseTheme(page, 'dark');
    await shot(page, 'resumed-team-isometric-dark');
    working = false;
    await board.getByRole('button', { name: 'Refresh live progress', exact: true }).click();
    await board.getByRole('region', { name: 'Live workflow progress', exact: true }).getByText(/Live: 0 working/).waitFor();
    assert.match(await board.locator('details.canvas-log-panel > summary').innerText(), /Previous attempt.*failed/, 'a live idle transition does not invent workflow success');
    assert.equal(f.posts.some(post => /^\/api\/workflows\/(?:run|[^/]+\/resume)$/.test(post.path)), false, 'viewing and refreshing never starts a model request');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light']) test(`exact quota fallback shows the preserved run and actual subscription (${colorScheme})`, async () => {
  const quota = 'Claude (ACP) error: You have hit your weekly limit.';
  const saved = { id: 'fallback-run', rootThreadId: 'chat-a', name: 'Quota recovery', status: 'succeeded', startedAt: 100, endedAt: 200, tasks: [{
    id: 'continue', title: 'Continue retained work', status: 'succeeded', assignedThreadId: 'fallback-child', dependsOn: [], writeScopes: [], acceptanceCriteria: ['Keep partial work'],
    result: { summary: 'Read planted result: work from the exhausted subscription' },
    routing: { requested: { model: 'claude/opus', provider: 'claude' }, actual: { model: 'gpt-6-luna', provider: 'openai' }, attempts: [
      { model: 'claude/opus', provider: 'claude', status: 'failed', reason: quota },
      { model: 'gpt-6-luna', provider: 'openai', status: 'succeeded' },
    ] },
  }] };
  const f = await open(colorScheme, [saved], {}, {}, {
    '/api/workflows': () => ({ data: [saved] }),
    '/api/threads/chat-a': () => ({ thread: base('chat-a', saved.name), data: [], nextCursor: null }),
  });
  try {
    const { page } = f;
    await row(page, 'chat-a').locator('.thread-link').click();
    const summary = page.getByRole('region', { name: 'Workflow run', exact: true });
    const task = summary.locator('li').filter({ hasText: 'Continue retained work' });
    await task.getByText('Result', { exact: true }).click();
    await task.getByText('Read planted result: work from the exhausted subscription', { exact: true }).waitFor();
    await summary.getByText('OpenAI · gpt-6-luna', { exact: true }).waitFor();
    await task.getByText('Model attempts', { exact: true }).click();
    await summary.getByText(quota, { exact: false }).waitFor();
    await shot(page, `quota-fallback-${colorScheme}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('cancelled workflow offers explicit same-run recovery without replaying completed tasks', async () => {
  const saved = { id: 'cancelled-run', rootThreadId: 'chat-a', name: 'Interrupted evidence review', status: 'cancelled', tasks: [
    { id: 'done', title: 'Retained evidence', kind: 'research', status: 'succeeded', result: { summary: 'Observed completed evidence' }, dependsOn: [], writeScopes: [], acceptanceCriteria: [] },
    { id: 'interrupted', title: 'Interrupted summary', kind: 'research', status: 'cancelled', dependsOn: ['done'], writeScopes: [], acceptanceCriteria: [] },
  ] };
  const f = await open('light', [saved], {}, {}, {
    '/api/workflows': () => ({ data: [saved] }),
    '/api/threads/chat-a': () => ({ thread: base('chat-a', saved.name), data: [], nextCursor: null }),
    '/api/workflows/cancelled-run/resume': () => ({ graphId: saved.id, threadId: saved.rootThreadId }),
  });
  try {
    const { page } = f;
    await row(page, 'chat-a').locator('.thread-link').click();
    const summary = page.getByRole('region', { name: 'Workflow run', exact: true });
    await summary.getByRole('list', { name: 'Saved workflow tasks', exact: true }).locator('li').filter({ hasText: 'Retained evidence' }).locator('details > summary').click();
    await summary.getByText('Observed completed evidence', { exact: true }).waitFor();
    const resume = summary.getByRole('button', { name: 'Resume workflow', exact: true });
    await eventually(async () => assert.equal(await resume.isEnabled(), true));
    assert.equal(f.posts.some(post => /^\/api\/workflows\/[^/]+\/resume$/.test(post.path)), false, 'opening a stopped run cannot resume it');
    assert.equal(f.posts.some(post => /^\/api\/threads\/[^/]+\/(?:turns|steer)$/.test(post.path)), false, 'reading the retained history cannot start or steer a model turn');
    await resume.click();
    await eventually(async () => assert.equal(f.posts.filter(post => post.path === '/api/workflows/cancelled-run/resume').length, 1));
    assert.equal(f.posts.some(post => post.path === '/api/workflows/run'), false, 'recovery sends the retained identity rather than starting another workflow');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
