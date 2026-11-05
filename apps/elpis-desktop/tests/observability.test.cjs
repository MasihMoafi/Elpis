// 5 Nov, Masih: "I don't see an observability in Elpis gui ... it already was there with a logo I had approved." The
// sidebar's Observability (pulse icon) shows the TUI's /dashboard page, DeepSeek's Trajectory, for the selected chat: its
// turns, tool calls, cache share and cache-break cause come from the chat's own rollout, read by the bridge.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const line = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
const usage = (input, cached, output) => ({ usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output } });
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

test('Observability shows the selected chat as the Trajectory page, names it, and its Chat menu picks another; with no chat it asks for one', async () => {
  const id = '00000000-0000-4000-8000-0000000000a1', other = '00000000-0000-4000-8000-0000000000a2';
  const rollouts = {};
  let rollout;
  const f = await loveSpotFixture({ configureClient: client => {
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
    await page.getByText('Choose a chat to see its trajectory.').waitFor();
    assert.equal(await page.locator('.observability iframe').count(), 0);

    // A second, newer chat with its own rollout, for the Chat menu.
    rollouts[other] = path.join(f.root, 'other.jsonl');
    await fs.writeFile(rollouts[other], ROLLOUT.replace(/List the files/g, 'Plan the garden').replace('thread-1', 'thread-2'));
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
    assert.deepEqual((await options.allInnerTexts()).map(s => s.trim()), ['Plan the garden', 'List the files']);
    await options.filter({ hasText: 'Plan the garden' }).click();
    await page.frameLocator('.observability iframe').getByText('Plan the garden').first().waitFor({ timeout: 20000 });
    assert.equal((await menu.innerText()).trim(), 'Plan the garden');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.observability-health').count(), 0, 'a folder outside Git shows no project numbers');
    assert.equal(await page.frameLocator('.observability iframe').getByText('List the files').count(), 0, 'the other chat is gone from the page');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
