// A223 (Masih, 24 Oct): "Error: Invalid thread ID (ELPIS_REQUEST_REJECTED; …)". Expanding a workflow in the sidebar
// stored `workflow:<run id>` in the map of expanded chats, and the agent follower polled every key of that map as a
// chat id, so the bridge refused it every five seconds. The mock refuses an ancestor id exactly as the bridge does
// (bridge/validate.mjs threadId), so a non-chat id cannot slip through as it did when the mock answered [] for any id.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const ROOT = '01a16e00-0000-7000-8000-000000000001', RUN = '7e713fd9-05cc-41f8-903f-9407045995a4';
const STEPS = ['01a16e00-0000-7000-8000-000000000002', '01a16e00-0000-7000-8000-000000000003'];
const thread = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const run = { id: RUN, rootThreadId: ROOT, name: 'Sea poem', status: 'succeeded', startedAt: 100,
  tasks: STEPS.map((id, i) => ({ id: `step-${i}`, title: ['Write', 'Critique'][i], assignedThreadId: id, status: 'succeeded' })) };

/** Workflows starts folded (sidebar-folds.ts); open it as the person does, once its runs are listed. */
async function openWorkflows(page) {
  const toggle = page.locator('aside.sidebar section[aria-label="Workflows"] .section-toggle');
  await toggle.waitFor({ timeout: 5000 });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'the Workflows section starts folded');
  await toggle.click();
}

test('expanding a finished workflow follows its chat without a rejected request or an error banner', async () => {
  const { threadId } = await import(path.join(__dirname, '../bridge/validate.mjs'));
  const asked = [], rejected = [];
  const listed = [thread('chat-a', 'Fix the parser'), thread(ROOT, 'Sea poem'), ...STEPS.map((id, i) => thread(id, `Workflows · ${['Write', 'Critique'][i]}`))];
  // S18, Masih 29 Oct: Background runs and the sidebar's Workflows section are off by default; this test turns them on.
  const f = await fixture({ desktop: true, width: 1440, height: 900, threads: listed, storage: { 'elpis-preferences-v1': JSON.stringify({ showAgentRuns: true, sidebarWorkflows: true }) }, routes: {
    '/api/threads': (_body, url) => {
      const ancestor = url.searchParams.get('ancestorThreadId');
      if (ancestor !== null) {
        asked.push(ancestor);
        try { threadId(ancestor); } catch (error) { rejected.push(ancestor); return { __http: 400, error: error.message }; }
        return { data: [], nextCursor: null };
      }
      return { data: url.searchParams.get('archived') === 'true' ? [] : listed, nextCursor: null };
    },
    '/api/workflows/history': () => ({ data: [run] }),
  } });
  const { page } = f;
  try {
    const sidebar = page.locator('aside.sidebar'), root = sidebar.locator(`.thread-row[data-thread-id="${ROOT}"]`);
    await openWorkflows(page); await root.waitFor();
    assert.equal(await sidebar.locator(`.thread-row[data-thread-id="${STEPS[0]}"]`).count(), 0, 'a finished workflow starts folded');
    await root.getByRole('button', { name: /^Expand / }).click();
    await sidebar.locator(`.thread-row[data-thread-id="${STEPS[0]}"]`).waitFor();
    // The follower reads every 5 s: wait until it has read the workflow's chat again after the Expand click's read.
    const followed = () => asked.filter(id => id === ROOT).length;
    for (const until = Date.now() + 12000; followed() < 3 && rejected.length === 0 && Date.now() < until;) await page.waitForTimeout(250);
    assert.deepEqual(rejected, [], 'every ancestor the sidebar asks for is a chat id');
    assert.ok(followed() >= 3, `the expanded workflow's chat is followed live (asked: ${JSON.stringify(asked)})`);
    assert.equal(await page.getByText(/Invalid thread ID/).count(), 0, 'no error banner');
    assert.equal(await sidebar.locator('.thread-row.child').count(), STEPS.length, 'its steps stay listed under it');
  } finally { await f.close(); }
});
