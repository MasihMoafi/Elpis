const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const parent = { id: 'chat-a', name: 'Agents icon acceptance', cwd: CWD, status: { type: 'idle' } };
const children = Array.from({ length: 16 }, (_, i) => ({ id: `agent-${i}`, name: i === 0 ? 'Agent 1 · inspect' : i === 8 ? 'An agent with a very long descriptive name '.repeat(8) : `Agent ${i + 1}`, ...(i === 0 ? { agentNickname: 'Agent 1' } : {}), cwd: CWD, model: 'gpt-6-luna', modelProvider: 'openai', reasoningEffort: 'max', parentThreadId: parent.id, source: { subAgent: { thread_spawn: { agent_path: `/root/agent-${i}` } } }, status: { type: i === 1 ? 'active' : ['idle', 'notLoaded', 'systemError'][i % 3] } }));

test('working-only Agents filter follows live status without closing the selected chat', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1440, height: 1000, routes: {
    '/api/threads': (_: unknown, url: URL) => ({ data: url.searchParams.has('ancestorThreadId') ? children : [parent, ...children], nextCursor: null }),
    ...Object.fromEntries(children.flatMap(thread => [
      [`/api/threads/${thread.id}`, () => ({ thread, data: [], nextCursor: null })],
      [`/api/threads/${thread.id}/resume`, () => ({ thread, activeTurnId: null })],
    ])),
  } });
  try {
    const { page } = f;
    // The fixture is the desktop app, whose header shows chat tabs, not a title: the selected chat is the selected tab.
    const openTab = (name: string) => page.getByRole('tablist', { name: 'Chat tabs' }).getByRole('tab', { name, exact: true, selected: true });
    await f.open('chat-a');
    const filter = page.getByRole('button', { name: 'Working agents only', exact: true });
    assert.equal(await filter.getAttribute('aria-pressed'), 'true');
    await page.locator('.team-row[data-thread-id="agent-1"]').click();
    await openTab('Agent 2').waitFor();
    const colour = await page.locator('.team-row[data-thread-id="agent-1"] .agent-mark').evaluate((mark: Element) => getComputedStyle(mark).backgroundColor);
    f.emit('message', { method: 'thread/status/changed', params: { threadId: 'agent-1', status: { type: 'idle' } } });
    await page.locator('.team-row[data-thread-id="agent-1"]').waitFor({ state: 'hidden' });
    await page.getByText('No working agents', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-row.root').count(), 1, 'the main chat stays in the panel');
    await openTab('Agent 2').waitFor();
    f.emit('message', { method: 'thread/status/changed', params: { threadId: 'agent-2', status: { type: 'active', activeFlags: [] } } });
    await page.locator('.team-row[data-thread-id="agent-2"]').waitFor();
    await filter.click();
    assert.equal(await page.locator('.team-row').count(), 17, 'show all restores every agent');
    assert.equal(await page.locator('.team-row[data-thread-id="agent-1"] .agent-mark').evaluate((mark: Element) => getComputedStyle(mark).backgroundColor), colour, 'status and filter changes do not recolor an agent');
    await openTab('Agent 2').waitFor();
    await filter.click();
    assert.equal(await page.locator('.team-row').count(), 2, 'working-only can be restored');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
