// Readable agent turns, using the exported app, fixture API, real mouse and keys. No engine or user profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { chooseTheme } = require('./controls.cjs');
const RECORD = '/tmp/elpis-obs-record/2026-10-16 Fix the parser.md';
const TOTALS = { attempts: 2, compacted: 1, unchanged: 1, failed: 0, saved: 1500, unlinked: 0 };
const CHAT = { id: 'chat-a', found: true, chat: { id: 'chat-a', name: 'Fix the parser' }, totals: TOTALS };
const ANSWER = '## Parser fixed\n\n- Added validation\n- Kept Unicode\n\n```rust\nfn main() {}\n```\n\n| Check | Result |\n| --- | --- |\n| Tests | Passed |\n\nSee [the guide](https://example.invalid/guide).';
const LEDGER = { used: 10000, window: 100000, basis: 'transcript', categories: [{ id: 'userMessages', label: 'User messages', tokens: 1000 }, { id: 'toolResults', label: 'Tool results', tokens: 2000 }, { id: 'toolDefinitions', label: 'Tool definitions + schema', tokens: 7000 }] };
const AGENTS = [{ id: 'chat-a', name: 'Mother', model: 'gpt-6.1-sol', role: null, record: RECORD }, { id: 'worker-a', name: 'Iris', model: 'gpt-6-luna', role: 'verify', record: null }];
const turn = i => ({ turnId: `t${i}`, status: i === 1 ? 'failed' : 'completed', error: i === 1 ? { message: 'Provider disconnected before completion' } : null, contextTokens: 10000, window: 100000, outputTokens: 100, requests: 1, saved: 1500, ledger: LEDGER, prunes: [], items: [
  { id: `u${i}`, type: 'userMessage', content: [{ type: 'text', text: `Fix the parser ${i}.` }] },
  { id: `c${i}`, type: 'commandExecution', command: 'cargo test -p core', status: 'completed', exitCode: 0, aggregatedOutput: '42 tests passed', durationMs: 1200 },
  { id: `r${i}`, type: 'commandExecution', command: 'cat src/app.rs', commandActions: [{ type: 'read', path: 'src/app.rs', name: 'app.rs' }], exitCode: 0, status: 'completed', aggregatedOutput: 'fn main() {}' },
  { id: `e${i}`, type: 'fileChange', status: 'completed', changes: [{ path: 'src/app.rs', kind: { type: 'update' }, diff: '-a\n+b' }, { path: 'src/lib.rs', kind: { type: 'update' }, diff: '-a\n+b' }] },
  { id: `s${i}`, type: 'collabAgentToolCall', tool: 'spawn_agent', status: 'completed', prompt: 'Verify Unicode cases', receiverThreadIds: ['worker-a'] },
  { id: `a${i}`, type: 'agentMessage', text: ANSWER },
] });
function routes(asked, count = 3) {
  return {
    '/api/observability': () => ({ available: true, totals: TOTALS, skipped: { unreadable: 0, unlinkedAdmissions: 0 }, chats: { data: [CHAT], nextCursor: null } }),
    '/api/observability/chats/chat-a': (_, url) => {
      asked.push(url.search); const agentId = url.searchParams.get('agent') || 'chat-a', start = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit') || 20), size = agentId === 'worker-a' ? 1 : count;
      return { ...CHAT, record: RECORD, agents: AGENTS, agentId, turns: { available: true, data: Array.from({ length: Math.min(limit, size - start) }, (_, n) => agentId === 'worker-a' ? { ...turn(n), items: [{ id: 'wu', type: 'userMessage', content: [{ type: 'text', text: 'Verify Unicode cases' }] }, { id: 'wa', type: 'agentMessage', text: 'Unicode cases passed.' }] } : turn(start + n)), nextCursor: start + limit < size ? String(start + limit) : null } };
    },
    '/api/file': () => ({ content: '# Fix the parser\n', size: 17, mtimeMs: 1 }),
    '/api/files/dir': () => ({ data: [] }),
  };
}
async function enter(page) { await page.locator('.startup-splash').waitFor({ state: 'detached' }); await page.getByRole('button', { name: 'Observability', exact: true }).click(); }
async function open(page) { const chat = page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'Fix the parser', exact: true }); await chat.focus(); await page.keyboard.press('Enter'); }
const mother = page => page.getByRole('region', { name: 'Mother', exact: true });
const shot = async (page, name) => { if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/${name}.png`, animations: "disabled" }); } };

test('active list has no deleted chats; each agent reads as prompt, plain work, rendered answer, with folded details and Ledger', async () => {
  const asked = [], f = await fixture({ width: 1280, height: 900, routes: routes(asked) });
  try {
    const { page } = f; await f.open('chat-a'); await enter(page);
    const list = page.getByRole('region', { name: 'Chats', exact: true });
    await list.getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.observability').innerText(), /Deleted chat|archived chat/i);
    await open(page);
    const group = mother(page); await group.getByRole('heading', { name: 'Mother', exact: true }).waitFor();
    const first = group.locator('.observed-turn').first();
    assert.match(await first.innerText(), /Fix the parser 0\.[\s\S]*Ran cargo test -p core[\s\S]*Read app.rs[\s\S]*Edited 2 files[\s\S]*Asked a subagent: Verify Unicode cases[\s\S]*Parser fixed/);
    const command = first.locator('details.step').filter({ hasText: 'Ran cargo test -p core' });
    assert.equal(await command.getAttribute('open'), null);
    await command.locator('summary').click();
    assert.equal(await command.locator('.step-output').innerText(), '42 tests passed');
    assert.equal(await command.locator('.step-script').innerText(), 'cargo test -p core');
    await command.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await command.getAttribute('open'), null);
    const markdown = first.locator('.message.agent .markdown');
    assert.equal(await markdown.getByRole('heading', { name: 'Parser fixed' }).count(), 1);
    assert.equal(await markdown.locator('li').count(), 2); assert.equal(await markdown.locator('pre code.language-rust').count(), 1);
    assert.equal(await markdown.getByRole('table').count(), 1); assert.equal(await markdown.getByRole('link', { name: 'the guide' }).getAttribute('href'), 'https://example.invalid/guide');
    assert.equal(await page.locator('.trace-timeline, .trace-steps, .trace-layout').count(), 0);
    const metrics = first.locator('.observed-metrics');
    assert.match(await metrics.locator('summary').innerText(), /Context 10k.*100k.*100.*Smart Prune.*1.5k/);
    await metrics.locator('summary').click();
    assert.equal(await metrics.locator('.context-ledger-row[data-category="toolResults"]').count(), 1);
    assert.equal(await metrics.locator('.context-ledger-row[data-category="toolResults"]').evaluate(row => getComputedStyle(row, '::before').backgroundColor), 'rgb(116, 132, 27)');
    await group.getByText('Turn failed: Provider disconnected before completion', { exact: true }).waitFor();
    const iris = page.getByRole('region', { name: 'Iris', exact: true });
    await iris.getByText('Unicode cases passed.', { exact: true }).waitFor();
    assert.match(await iris.innerText(), /gpt-6-luna.*verify/);
    assert.deepEqual(await page.locator('.observed-agent > .customize-title h3').allInnerTexts(), ['Mother', 'Iris']);
    await group.getByRole('button', { name: 'Open record', exact: true }).click();
    await page.getByRole('article', { name: `Preview of ${RECORD}`, exact: true }).getByRole('heading', { name: 'Fix the parser', exact: true }).waitFor();
    await page.getByRole('group', { name: 'Document view', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: `Contents of ${RECORD}`, exact: true }).inputValue(), '# Fix the parser\n');
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    // Opening a file leaves this page; select the chat again from its refreshed list.
    await open(page);
    await group.getByRole('heading', { name: 'Mother', exact: true }).waitFor();
    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    await list.getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('300 turns paint within 1 s; later pages load only on click and a failed page retries without duplicates', async t => {
  const asked = [], all = routes(asked, 300); let failMore = true;
  const f = await fixture({ width: 1440, height: 900, routes: { ...all, '/api/observability/chats/chat-a': (body, url) => url.searchParams.get('cursor') && failMore ? { __http: 503, error: 'Page unavailable' } : all['/api/observability/chats/chat-a'](body, url) } });
  try {
    const { page } = f; await enter(page);
    await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    const began = performance.now(); await open(page); await mother(page).getByText('Fix the parser 0.', { exact: true }).waitFor();
    const ms = performance.now() - began; t.diagnostic(`300-turn fixture: first paint ${ms.toFixed(0)}ms`); assert.ok(ms < 1000, `first paint ${ms.toFixed(0)}ms`);
    assert.equal(await mother(page).locator('.observed-turn').count(), 20);
    assert.equal(asked.filter(url => !url.includes('agent=worker-a')).length, 1);
    const more = mother(page).getByRole('button', { name: 'Show more turns', exact: true }); await more.click();
    await mother(page).getByText('Page unavailable', { exact: false }).waitFor();
    assert.equal(await mother(page).locator('.observed-turn').count(), 20);
    failMore = false; await mother(page).getByRole('button', { name: 'Retry', exact: true }).click();
    await mother(page).getByText('Fix the parser 39.', { exact: true }).waitFor();
    assert.equal(await mother(page).locator('.observed-turn').count(), 40);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('readable turns and expanded details fit light/dark at 1280 and 1440, using real theme controls', async () => {
  for (const width of [1280, 1440]) {
    const f = await fixture({ width, height: 1000, routes: routes([]) });
    try {
      const { page } = f; await enter(page);
      for (const theme of ['light', 'dark']) {
        if (theme === "dark") await chooseTheme(page, theme);
        await assertUiFit(page.locator('.observability'), `list ${theme} ${width}`); await shot(page, `observability-list-${theme}-${width}`);
        await open(page); await mother(page).getByText('Fix the parser 0.', { exact: true }).waitFor();
        await assertUiFit(page.locator('.observability'), `turns ${theme} ${width}`); await shot(page, `observability-turns-${theme}-${width}`);
        const first = mother(page).locator('.observed-turn').first();
        await first.locator('details.step summary').first().click();
        await first.locator('.observed-metrics summary').click();
        await first.locator('.observed-metrics').scrollIntoViewIfNeeded();
        await assertUiFit(page.locator('.observability'), `details ${theme} ${width}`); await shot(page, `observability-details-${theme}-${width}`);
        await page.getByRole('button', { name: 'All chats', exact: true }).click();
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('empty list, request failure, keyboard retry and refresh show accurate states', async () => {
  let broken = true, none = false; const all = routes([]);
  const f = await fixture({ routes: { ...all, '/api/observability': () => broken ? { __http: 503, error: 'Records temporarily unavailable' } : none ? { available: true, totals: { ...TOTALS, attempts: 0, saved: 0 }, skipped: {}, chats: { data: [], nextCursor: null } } : all['/api/observability']() } });
  try {
    const { page } = f; await enter(page); await page.locator('.observability').getByRole('alert').waitFor();
    broken = false; await page.getByRole('button', { name: 'Retry', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    none = true; await page.locator('.observability').getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('No active chats', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a chat deleted while Observability is open disappears with its counts and totals', async () => {
  let deleted = false; const all = routes([]);
  const f = await fixture({ routes: { ...all, '/api/observability': () => deleted ? { totals: { attempts: 0, saved: 0 }, chats: { data: [], nextCursor: null } } : all['/api/observability']() } });
  try {
    const { page } = f; await enter(page);
    await page.locator('.observability').getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    deleted = true; f.emit('message', { method: 'thread/deleted', params: { threadId: 'chat-a' } });
    await page.locator('.observability').getByText('No active chats', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.observability').innerText(), /Fix the parser|1.5k|2 Smart Prune runs/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('returning to the chat list after a subagent deletion reloads its totals', async () => {
  let deleted = false; const all = routes([]);
  const f = await fixture({ routes: { ...all,
    '/api/observability': () => deleted ? { totals: { attempts: 0, saved: 0 }, chats: { data: [{ ...CHAT, totals: { attempts: 0, saved: 0 } }], nextCursor: null } } : all['/api/observability'](),
    '/api/observability/chats/chat-a': (body, url) => { const result = all['/api/observability/chats/chat-a'](body, url); return deleted ? { ...result, agents: [AGENTS[0]] } : result; },
  } });
  try {
    const { page } = f; await enter(page); await open(page);
    await page.getByRole('region', { name: 'Iris', exact: true }).getByText('Unicode cases passed.', { exact: true }).waitFor();
    deleted = true; f.emit('message', { method: 'thread/deleted', params: { threadId: 'worker-a' } });
    await page.getByRole('region', { name: 'Iris', exact: true }).waitFor({ state: 'detached' });
    await mother(page).getByText('Fix the parser 0.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    const list = page.getByRole('region', { name: 'Chats', exact: true });
    await list.getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    assert.doesNotMatch(await list.innerText(), /1.5k|2 Smart Prune runs/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('MCP output and the full subagent prompt open with one click', async () => {
  const all = routes([], 1), f = await fixture({ routes: { ...all, '/api/observability/chats/chat-a': (body, url) => {
    const page = all['/api/observability/chats/chat-a'](body, url);
    if (page.agentId === 'chat-a') page.turns.data[0].items.splice(-1, 0, { id: 'mcp-read', type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed', arguments: { query: 'parser' }, result: { content: [{ type: 'text', text: 'README loaded.' }] } });
    return page;
  } } });
  try {
    const { page } = f; await enter(page); await open(page);
    const first = mother(page).locator('.observed-turn').first();
    const mcp = first.locator('details.step').filter({ hasText: 'Used rag search' });
    await mcp.locator(':scope > summary').click();
    await mcp.getByText('README loaded.', { exact: true }).waitFor();
    const delegation = first.locator('details.step').filter({ hasText: 'Asked a subagent: Verify Unicode cases' });
    await delegation.locator(':scope > summary').click();
    await delegation.getByText('Verify Unicode cases', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
