// Masih, 30 Oct, on seeing a subagent's work: "I can! But in another chat only!" (27 Oct: agents shown in the chat that
// spawned them, as the ChatGPT app does). The agent's row in the parent chat opens its conversation in place; the parent
// chat stays open. "Open chat" still moves to the agent's own chat.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cjs');

const child = { ...THREADS[0], id: 'agent-1', name: 'Parser reviewer', parentThreadId: 'chat-a' };
const spawn = { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawn_agent', status: 'completed', prompt: 'Review the parser.', receiverThreadIds: ['agent-1'] };
const activity = { id: 'activity', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'agent-1', agentPath: '/root/parser_reviewer' };
const childEntries = [
  { turnId: 'c1', item: { id: 'c1-user', type: 'userMessage', content: [{ type: 'text', text: 'Review the parser.' }] } },
  { turnId: 'c1', item: { id: 'c1-answer', type: 'agentMessage', text: 'The reviewer found two unchecked token kinds.' } },
];

for (const colorScheme of ['light']) test(`a subagent's conversation opens inside the chat that started it (${colorScheme})`, async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, colorScheme, width: 1300, height: 900,
    chat: [['t1', 'Check the parser with an agent.', 'The agent finished its review.', [spawn, activity]]],
    threads: [...THREADS, child],
    routes: { '/api/threads/agent-1': () => ({ thread: child, data: childEntries, nextCursor: null }) } }), { page } = f;
  try {
    await f.open('chat-a');
    // Folded work opens first, as a person would to see the agent's row.
    for (let round = 0; round < 3; round++) for (const summary of await page.locator('main details:not([open]) > summary').all()) await summary.click().catch(() => {});
    const shows = page.getByRole('button', { name: /^Show here: / });
    await shows.first().waitFor();
    assert.equal(await page.getByText('The reviewer found two unchecked token kinds.').count(), 0, 'closed until asked');
    await shows.first().click();
    const region = page.getByRole('region', { name: 'Agent conversation' });
    await region.getByText('The reviewer found two unchecked token kinds.').waitFor();
    assert.equal(await page.locator('.thread-row.active').getAttribute('data-thread-id'), 'chat-a', 'the parent chat stays open');
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/agent-inline-${colorScheme}.png` });
    await page.getByRole('button', { name: /^Hide here: / }).first().click();
    assert.equal(await region.count(), 0, 'Hide here closes it');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
