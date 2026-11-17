// 5 Nov, Masih: "I don't see an observability in Elpis gui ... it already was there with a logo I had approved." The
// sidebar's Observability (pulse icon) shows the TUI's /dashboard page, DeepSeek's Trajectory, for the selected chat: its
// turns, tool calls, cache share and cache-break cause come from the chat's own rollout, read by the bridge.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cts');
const { fixture: parityFixture } = require('./parity-fixture.cts');

const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
const usage = (input: number, cached: number, output: number) => ({ usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output } });
/** The same rollout as codex-rs/elpis-trajectory/src/projection_tests.rs: a tool call, a cache hit, a Ledger change that
 * breaks the cache, and a second turn. */
const ROLLOUT = [
  line('2026-11-05T10:00:00.000Z', 'session_meta', { id: 'thread-1', cwd: '/w', model_provider: 'openai', base_instructions: { text: 'You are Elpis.' } }),
  line('2026-11-05T10:00:00.000Z', 'turn_context', { model: 'gpt-6.1-terra' }),
  line('2026-11-05T10:00:00.000Z', 'world_state', { full: true, state: { agents_md: {} } }),
  line('2026-11-05T10:00:00.000Z', 'event_msg', { type: 'task_started', started_at: 1793872800, model_context_window: 400000 }),
  line('2026-11-05T10:00:00.200Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] }),
  line('2026-11-05T10:00:01.000Z', 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'call-1' }),
  line('2026-11-05T10:00:02.000Z', 'token_usage_record', usage(10000, 0, 50)),
  line('2026-11-05T10:00:02.500Z', 'response_item', { type: 'function_call_output', call_id: 'call-1', output: 'Exit code: 2\nls: no such file' }),
  line('2026-11-05T10:00:04.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The folder is empty.' }] }),
  line('2026-11-05T10:00:04.000Z', 'token_usage_record', usage(10200, 9000, 20)),
  line('2026-11-05T10:00:05.000Z', 'event_msg', { type: 'task_complete', time_to_first_token_ms: 700 }),
  line('2026-11-05T10:01:00.000Z', 'world_state', { full: false, state: { agents_md: {} } }),
  line('2026-11-05T10:01:00.000Z', 'event_msg', { type: 'task_started', started_at: 1793872860 }),
  line('2026-11-05T10:01:00.100Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] }),
  line('2026-11-05T10:01:02.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
  line('2026-11-05T10:01:02.000Z', 'token_usage_record', usage(10400, 1000, 10)),
].join('\n');

test('Smart Prune history spans chats, pages attempts and opens the exact original/compact evidence in both themes', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const first = { attemptId: 'p1', threadId: 'chat-a', chatTitle: 'Parser audit', timestamp: 'Saved first', turnId: 't1', turnNumber: 1,
      model: 'Local pruner', reasoningEffort: 'low', estimatedSourceTokens: 1200, estimatedAdmittedTokens: 200, estimatedSavedTokens: 1000, note: null };
    const second = { ...first, attemptId: 'p2', threadId: 'chat-b', chatTitle: 'Docs audit', estimatedAdmittedTokens: 1200,
      estimatedSavedTokens: 0, note: 'Model failed; original kept.' };
    const original = 'Exact original output\nwith retained whitespace\n' + 'long_word_'.repeat(50);
    let detailReads = 0;
    const f = await parityFixture({ colorScheme, width: 1280, routes: {
      '/api/smart-prune': (_body: unknown, url: URL) => url.searchParams.has('cursor')
        ? { data: [second], nextCursor: null, unreadable: 1 } : { data: [first], nextCursor: 'next', unreadable: 1 },
      '/api/smart-prune/chat-a/p1': () => { detailReads++; return { record: { ...first, items: [{ callId: 'c1', description: 'Build output',
        estimatedSourceTokens: 1200, estimatedAdmittedTokens: 200, decision: 'Replaced', kept: 'Compiler errors', original,
        compact: 'Error: missing name', diff: '-Removed source line\n+Error: missing name' }] } }; },
      '/api/smart-prune/chat-b/p2': () => ({ record: { ...second, items: [{ callId: 'c2', description: 'Search output',
        estimatedSourceTokens: 1200, estimatedAdmittedTokens: 1200, decision: 'Original kept', kept: null, original: 'All search results', compact: null, diff: null }] } }),
    } });
    try {
      const { page } = f;
      await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
      await page.getByRole('radio', { name: 'Smart Prune', exact: true }).click();
      const history = page.getByRole('region', { name: 'Smart Prune history' });
      await history.getByRole('button', { name: /Parser audit/ }).waitFor();
      assert.equal(detailReads, 0, 'list does not fetch full evidence');
      await history.getByText('1 saved record could not be read. The list is incomplete.').waitFor();
      await history.getByRole('button', { name: 'Load earlier attempts' }).click();
      await history.getByRole('button', { name: /Docs audit/ }).waitFor();
      assert.equal(await history.getByRole('button', { name: /Parser audit/ }).count(), 1);
      await history.getByRole('button', { name: /Parser audit/ }).click();
      await history.getByText('Error: missing name', { exact: true }).waitFor();
      assert.equal(await history.locator('pre').first().textContent(), original);
      await history.getByText('Text changes', { exact: true }).click();
      await history.getByText('-Removed source line\n+Error: missing name', { exact: true }).waitFor();
      if (colorScheme === 'dark') await page.setViewportSize({ width: 390, height: 900 });
      assert.equal(await history.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth), true, 'comparison fits a narrow view');
      await history.getByRole('button', { name: 'Back to prune history' }).click();
      await history.getByRole('button', { name: /Docs audit/ }).click();
      await history.getByText('Original kept; no compact version was used.').waitFor();
      assert.equal(await history.getByText('Error: missing name', { exact: true }).count(), 0, 'other-chat evidence is gone');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('Smart Prune empty, failed and recovered reads stay distinct; late detail cannot overwrite another chat', async () => {
  let fail = false, empty = true;
  let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const a = { attemptId: 'a', threadId: 'chat-a', chatTitle: 'Slow evidence', timestamp: '', turnId: 't', turnNumber: null,
    model: 'Local', reasoningEffort: 'low', estimatedSourceTokens: null, estimatedAdmittedTokens: null, estimatedSavedTokens: null, note: null };
  const b = { ...a, attemptId: 'b', threadId: 'chat-b', chatTitle: 'Current evidence' };
  const f = await parityFixture({ routes: {
    '/api/smart-prune': () => fail ? { __http: 503, error: 'History temporarily unavailable' } : { data: empty ? [] : [a, b], nextCursor: null, unreadable: 0 },
    '/api/smart-prune/chat-a/a': async () => { await delayed; return { record: { ...a, note: 'STALE RECORD', items: [] } }; },
    '/api/smart-prune/chat-b/b': () => ({ record: { ...b, note: 'CURRENT RECORD', items: [{ callId: 'unknown', description: 'Missing admission',
      estimatedSourceTokens: 100, estimatedAdmittedTokens: 100, decision: 'Evidence missing', kept: null,
      original: 'Original still readable', compact: null, diff: null }] } }),
  } });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('radio', { name: 'Smart Prune', exact: true }).click();
    const history = page.getByRole('region', { name: 'Smart Prune history' });
    await history.getByText('No Smart Prune attempts are recorded yet.').waitFor();
    fail = true;
    await history.getByRole('button', { name: 'Refresh prune history' }).click();
    await history.getByRole('alert').waitFor();
    assert.equal(await history.getByText('No Smart Prune attempts are recorded yet.').count(), 0);
    fail = false; empty = false;
    await history.getByRole('button', { name: 'Retry', exact: true }).click();
    await history.getByRole('button', { name: /Slow evidence/ }).click();
    await history.getByRole('status').waitFor();
    await history.getByRole('button', { name: 'Back to prune history' }).click();
    await history.getByRole('button', { name: /Current evidence/ }).click();
    await history.getByText('CURRENT RECORD', { exact: true }).waitFor();
    await history.getByText('Committed replacement evidence is unavailable.').waitFor();
    assert.equal(await history.getByText('Original kept; no compact version was used.').count(), 0);
    assert.equal(await history.locator('meter').count(), 0, 'missing evidence does not claim a measured result');
    release?.();
    await page.waitForTimeout(100);
    assert.equal(await history.getByText('STALE RECORD', { exact: true }).count(), 0);
    assert.equal(await history.getByText('CURRENT RECORD', { exact: true }).count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});

test('Observability shows the selected chat as the Trajectory page, names it, and its Chat menu picks another; with no chat it asks for one', async () => {
  const id = '00000000-0000-4000-8000-0000000000a1', other = '00000000-0000-4000-8000-0000000000a2';
  const rollouts: Record<string, string> = {};
  let rollout = '';
  const f = await loveSpotFixture({ configureClient: (client: { readThreadMetadata: (threadId: string) => Promise<{ id: string; path: string }>; git: (threadId: string, view: string) => Promise<object> }) => {
    client.readThreadMetadata = async threadId => ({ id: threadId, path: rollouts[threadId] ?? rollout });
    // The project's loose ends (5 Nov): the first chat's folder is a repository, the other's is not.
    client.git = async (threadId, view) => { if (view !== 'health') return {}; if (threadId !== id) throw Object.assign(new Error('not a Git repository'), { status: 409 }); return { branch: 'main', uncommitted: 3, worktrees: 2, unmerged: { local: 1, remote: 4 }, stashes: 1 }; };
  } });
  try {
    rollout = path.join(f.root, 'rollout.jsonl'); await fs.writeFile(rollout, ROLLOUT);
    const { page } = f;
    const nav = page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true });
    // Negative: no chat selected, so the page asks for one instead of showing another chat's history.
    await nav.click();
    await page.getByText('Choose a chat to see its trajectory or its project.').waitFor();
    assert.equal(await page.locator('.observability iframe').count(), 0);

    // A second, newer chat with its own rollout, for the Chat menu.
    rollouts[other] = path.join(f.root, 'other.jsonl');
    await fs.writeFile(path.join(f.root, 'other.jsonl'), ROLLOUT.replace(/List the files/g, 'Plan the garden').replace('thread-1', 'thread-2'));
    f.chats.push({ id: other, name: 'Plan the garden', preview: 'Plan the garden', updatedAt: 2000000000, cwd: f.directory, modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
    f.chats.push({ id, updatedAt: 1000000000, name: 'List the files', preview: 'List the files', cwd: f.directory, modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator(`aside [data-thread-id="${id}"] .thread-link`).click();
    await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
    const frame = page.frameLocator('.observability iframe');
    await frame.getByText('List the files').first().waitFor({ timeout: 20000 });
    const text = await frame.locator('body').innerText();
    for (const shown of ['exec_command', 'Again', 'Done.']) assert.ok(text.includes(shown), `the page shows "${shown}":\n${text.slice(0, 2000)}`);
    assert.match(text, /2 turns/, 'the footer counts the two turns');
    assert.match(text, /Cache hit \d+%/, 'the footer shows the cache share');
    await page.locator('.observability-health').waitFor();
    assert.equal((await page.locator('.observability-health').innerText()).replace(/\s+/g, ' ').trim(), 'Branch main Uncommitted 3 files Worktrees 2 Unmerged branches 1 here · 4 on GitHub Stashes 1');

    // The Chat menu names the chat shown; picking another shows that chat's trajectory, newest first in the list.
    const menu = page.getByRole('combobox', { name: 'Chat' });
    assert.equal((await menu.innerText()).trim(), 'List the files');
    await menu.click();
    const options = page.getByRole('option');
    await options.nth(1).waitFor(); // a slower machine draws the list a moment after the click (CI run 42088645101)
    assert.deepEqual((await options.allInnerTexts()).map((s: string) => s.trim()), ['Plan the garden', 'List the files']);
    await options.filter({ hasText: 'Plan the garden' }).click();
    await page.frameLocator('.observability iframe').getByText('Plan the garden').first().waitFor({ timeout: 20000 });
    assert.equal((await menu.innerText()).trim(), 'Plan the garden');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.observability-health').count(), 0, 'a folder outside Git shows no project numbers');
    assert.equal(await page.frameLocator('.observability iframe').getByText('List the files').count(), 0, 'the other chat is gone from the page');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
