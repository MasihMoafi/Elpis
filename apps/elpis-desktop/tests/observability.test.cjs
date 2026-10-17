// Observability, laid out as Langfuse lays out traces: a list of chats; a chat opens as a timeline of its turns; a turn opens
// to its steps (model calls, tool calls, Smart Prune) with time and tokens; the Ledger's categories for the selected turn;
// each Smart Prune with its outputs and a link to its readable Markdown record, opened in Files. Local bridge fixture
// (tests/parity-fixture.cjs) with the bridge's replies faked by `routes`; no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const fs = require('node:fs/promises');

const RECORD = '/tmp/elpis-obs-record/2026-10-16 Fix the parser.md';
const GONE = '01a14400-0000-7000-8000-00000000dead';
const totals = values => ({ attempts: 0, compacted: 0, unchanged: 0, failed: 0, examined: 0, shortened: 0, before: 0, after: 0, saved: 0, unlinked: 0, prunerTokens: 0, prunerRuns: 0, ...values });
const row = (id, chat, lastAt, values) => ({ id, found: !!chat, chat, lastAt, totals: totals(values) });
const OVERVIEW = { available: true, records: '~/.elpis-next/logs/smart-prune', skipped: { unreadable: 0, unlinkedAdmissions: 267 },
  totals: totals({ attempts: 1598, compacted: 1453, unchanged: 120, failed: 25, examined: 1600, shortened: 1454, before: 4069052, after: 1017282, saved: 3051770, prunerTokens: 7559673, prunerRuns: 1574 }) };
const CHATS = [
  row('chat-a', { id: 'chat-a', name: 'Fix the parser' }, '2026-10-16T09:44:26Z', { attempts: 3, compacted: 1, unchanged: 1, failed: 1, examined: 4, shortened: 1, saved: 1500, before: 2000, after: 500, prunerTokens: 3000, prunerRuns: 2 }),
  row(GONE, null, '2026-10-16T08:00:00Z', { attempts: 1, compacted: 1, saved: 3000, before: 4000, after: 1000 }),
  row('chat-b', { id: 'chat-b', name: 'Write the docs' }, '2026-10-15T08:00:00Z', { attempts: 1, unchanged: 1 })];
const item = (callId, tool, sourceTokens, decision, admittedTokens = null) => ({ callId, tool, sourceTokens, decision, admitted: admittedTokens !== null, admittedTokens, saved: admittedTokens === null ? null : sourceTokens - admittedTokens });
const run = (id, status, outcome, values) => ({ id, turnId: 't1', at: '2026-10-16T09:00:05Z', status, outcome, model: 'gpt-6-luna', effort: 'low', candidates: 1, shortened: 0, saved: 0, latencyMs: 1200, prunerTokens: 3000, error: null, admission: null, ...values });
const RUNS = [
  run('r3', 'model_error', 'failed', { turnId: 't2', at: '2026-10-16T09:11:00Z', prunerTokens: null, error: 'stream disconnected before completion', items: [item('c4', 'web_search', 1300, null)] }),
  run('r2', 'unchanged', 'unchanged', { turnId: 't2', at: '2026-10-16T09:10:00Z', items: [item('c3', 'exec_command', 1100, 'compact')] }),
  run('r1', 'admitted', 'compacted', { candidates: 2, shortened: 1, saved: 1500, items: [item('c1', 'exec_command', 2000, 'compact', 500), item('c2', 'read_file', 1500, 'unchanged')],
    admission: { id: 'ad1', before: 2000, after: 500, saved: 1500, requestSequence: 7 } })];
const LEDGER1 = { used: 10000, window: 100000, basis: 'transcript', categories: [{ id: 'userMessages', label: 'User messages', tokens: 1000 }, { id: 'toolResults', label: 'Tool results', tokens: 2000 }, { id: 'toolDefinitions', label: 'Tool definitions + schema', tokens: 7000 }] };
const LEDGER2 = { used: 15000, window: 100000, basis: 'transcript', categories: [{ id: 'userMessages', label: 'User messages', tokens: 3000 }, { id: 'toolCalls', label: 'Tool calls', tokens: 500 }, { id: 'toolResults', label: 'Tool results', tokens: 6500 }, { id: 'toolDefinitions', label: 'Tool definitions + schema', tokens: 5000 }] };
const TURNS = { available: true, data: [
  { turnId: 't1', at: '2026-10-16T09:00:01Z', contextTokens: 10000, window: 100000, requests: 1, saved: 1500, ledger: LEDGER1, stepsMore: 0, steps: [
    { at: '2026-10-16T09:00:04Z', kind: 'tool', name: 'exec_command', detail: 'cargo test -p core' },
    { at: '2026-10-16T09:00:09Z', kind: 'model', input: 9900, cached: 0, output: 100, context: 10000 }] },
  { turnId: 't2', at: '2026-10-16T09:09:00Z', contextTokens: 15000, window: 100000, requests: 2, saved: 0, ledger: LEDGER2, stepsMore: 0, steps: [
    { at: '2026-10-16T09:09:30Z', kind: 'model', input: 11900, cached: 0, output: 100, context: 12000 },
    { at: '2026-10-16T09:11:30Z', kind: 'model', input: 14900, cached: 0, output: 100, context: 15000 }] },
  { turnId: 't3', at: '2026-10-16T09:20:00Z', contextTokens: null, window: null, requests: 0, saved: 0, ledger: null, steps: [], stepsMore: 0 }] };

/** The bridge's two routes over the records above; every URL asked is kept. */
function routes(asked) {
  return {
    '/api/observability': (_, url) => { asked.push(url.search); const start = Number(url.searchParams.get('cursor') ?? 0); return { ...OVERVIEW, chats: { data: CHATS.slice(start, start + 2), nextCursor: start + 2 < CHATS.length ? String(start + 2) : null } }; },
    '/api/observability/chats/chat-a': (_, url) => { asked.push(`chat-a${url.search}`); return { id: 'chat-a', found: true, chat: CHATS[0].chat, record: RECORD, totals: CHATS[0].totals, turns: TURNS, attempts: { data: RUNS, nextCursor: null } }; },
    [`/api/observability/chats/${GONE}`]: () => ({ id: GONE, found: false, chat: null, record: null, totals: CHATS[1].totals, turns: { available: false, reason: 'chat-missing' },
      attempts: { data: [run('r9', 'admitted', 'compacted', { turnId: 'tx', shortened: 1, saved: 3000, items: [item('c5', 'exec_command', 4000, 'compact', 1000)], admission: { id: 'ad2', before: 4000, after: 1000, saved: 3000, requestSequence: null } })], nextCursor: null } }),
    '/api/file': () => ({ content: '# Fix the parser\n', size: 17, mtimeMs: 1 }),
    '/api/files/dir': () => ({ data: [] }),
  };
}
const texts = locator => locator.allInnerTexts().then(values => values.map(value => value.replace(/\s+/g, ' ').trim()));
const SHOTS = process.env.ELPIS_SHOTS;
const shot = async (page, name) => { if (SHOTS) { await fs.mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const contents = page => page.getByRole('textbox', { name: `Contents of ${RECORD}`, exact: true });

test('Observability: chats listed with English counts; a chat opens as a timeline of turns; a turn opens to its steps, its Ledger categories and its Smart Prunes with a link to the record', async () => {
  const asked = [], f = await fixture({ width: 1280, height: 900, routes: routes(asked) });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.open('chat-a');
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    assert.deepEqual(await page.locator('.nav-list button[aria-current="page"]').allInnerTexts(), ['Observability']);

    // The list of chats: one row each, runs counted as English.
    const chats = page.getByRole('region', { name: 'Chats', exact: true });
    await chats.getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    assert.deepEqual(await texts(chats.locator('.trace-row')), ['Fix the parser 3 runs · ≈1.5k saved Open chat', `Deleted chat · ${GONE.slice(-8)} 1 run · ≈3k saved`]);
    assert.doesNotMatch(await chats.innerText(), /\b1 runs\b/);
    await chats.getByRole('button', { name: 'Show more chats', exact: true }).click();
    await chats.getByRole('button', { name: 'Write the docs', exact: true }).waitFor();
    assert.match(await texts(chats.locator('.trace-row').last()).then(rows => rows[0]), /^Write the docs 1 run /);
    assert.deepEqual(asked.slice(0, 2), ['?limit=20', '?limit=20&cursor=2']);

    // A chat opens with the keyboard: its timeline of turns, its runs read in full.
    await chats.getByRole('button', { name: 'Fix the parser', exact: true }).focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: 'Fix the parser', exact: true });
    const turns = detail.getByRole('list', { name: 'Turns', exact: true });
    await turns.locator('li').first().waitFor();
    assert.equal(await turns.locator(':scope > li').count(), 3);
    assert.deepEqual(asked.filter(url => url.startsWith('chat-a')), ['chat-a?limit=100']);
    const untimed = rows => rows.map(text => text.replace(/\d\d:\d\d:\d\d /, ''));
    assert.deepEqual(untimed(await texts(turns.locator(':scope > li > button'))), [
      'Turn 1 10k of 100k tokens · 1 request · 1 Smart Prune',
      'Turn 2 15k of 100k tokens · 2 requests · 2 Smart Prunes',
      'Turn 3 Not measured'], 'each turn: its context and what happened in it');

    // The latest measured turn is selected: its Ledger categories, in the Ledger's colours and words.
    const context = detail.getByRole('region', { name: 'Context in turn 2', exact: true });
    assert.deepEqual(await texts(context.locator('.context-ledger-row')), ['User messages ≈3k 3.0%', 'Tool calls ≈500 0.5%', 'Tool results ≈6.5k 6.5%', 'Tool definitions + schema ≈5k 5.0%', 'Free capacity 85k 85.0%']);
    assert.deepEqual(await context.locator('.context-bar-segment').evaluateAll(parts => parts.map(part => part.dataset.category)), ['userMessages', 'toolCalls', 'toolResults', 'toolDefinitions']);
    const swatch = await context.locator('.context-ledger-row[data-category="toolResults"]').evaluate(row => getComputedStyle(row, '::before').backgroundColor);
    assert.equal(swatch, 'rgb(116, 132, 27)', 'the Ledger\'s tool-results colour');
    assert.match(await context.innerText(), /estimated from the saved chat/);

    // Turn 1, by keyboard: its steps in time order, the Smart Prune in its place between the tool call and the model call.
    await turns.locator(':scope > li > button').first().focus();
    await page.keyboard.press('Enter');
    await detail.getByRole('region', { name: 'Context in turn 1', exact: true }).waitFor();
    const steps = turns.locator(':scope > li').first().locator('.trace-step');
    assert.deepEqual(untimed(await texts(steps)), [
      'Tool call exec_command · cargo test -p core',
      'Smart Prune Compacted · 1 of 2 outputs shortened · ≈2k → ≈500 · ≈1.5k saved',
      'Model call 9.9k in · 100 out · 10k in context']);
    assert.match((await texts(steps))[0], /^\d\d:\d\d:\d\d /, 'each step has its time');
    assert.match(await detail.innerText(), /Cost is not recorded/);

    // The Smart Prune opens to its outputs, what each lost, and its record, which opens in Files.
    const prune = steps.nth(1);
    await prune.getByRole('button', { name: /Smart Prune/ }).click();
    assert.deepEqual(await texts(prune.locator('.trace-output')), ['exec_command ≈2k → ≈500 Removed ≈1.5k (75%)', 'read_file ≈1.5k Kept: the pruner left it as it was']);
    assert.match(await prune.innerText(), /The main model got the shortened text in request 7/);

    // Turn 2's Smart Prunes: kept under the floor, and failed with the reason.
    await turns.locator(':scope > li > button').nth(1).click();
    const second = turns.locator(':scope > li').nth(1).locator('.trace-step');
    assert.deepEqual(untimed(await texts(second)), [
      'Model call 11.9k in · 100 out · 12k in context',
      'Smart Prune Unchanged · 0 of 1 output shortened',
      'Smart Prune Model error · stream disconnected before completion',
      'Model call 14.9k in · 100 out · 15k in context'], 'steps in time order');
    await second.nth(1).getByRole('button', { name: /Smart Prune/ }).click();
    assert.match(await second.nth(1).locator('.trace-output').innerText(), /Kept: the shorter text saved under 256 tokens or under 20%/);
    await turns.locator(':scope > li > button').nth(2).click();
    await detail.getByText('No steps recorded for this turn.', { exact: true }).waitFor();
    await detail.getByText('Not measured: no request finished in this turn.', { exact: true }).waitFor();

    // The record opens in Files, from the Smart Prune that names it.
    await turns.locator(':scope > li > button').first().click();
    await turns.locator(':scope > li').first().locator('.trace-step').nth(1).getByRole('button', { name: 'Open record', exact: true }).click();
    await contents(page).waitFor();
    // With Files open the page is narrow; the timeline stacks above the context and its text keeps a readable width.
    const text = await turns.locator(':scope > li').first().locator('.trace-step .trace-text').first().boundingBox();
    assert.ok(text.width >= 150, `step text is ${text.width}px wide beside the open Files pane`);
    await assertUiFit(page.locator('.observability'), 'chat beside the Files pane');
    await shot(page, 'observability-record-opened');

    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    await chats.getByRole('button', { name: 'Write the docs', exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Observability: a deleted chat has no turns, so its Smart Prunes stand alone; no record yet is said so', async () => {
  const f = await fixture({ width: 1280, height: 900, routes: routes([]) });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('button', { name: `Deleted chat · ${GONE.slice(-8)}`, exact: true }).click();
    const gone = page.getByRole('region', { name: `Deleted chat · ${GONE.slice(-8)}`, exact: true });
    await gone.getByText('Elpis no longer has this chat; its Smart Prune records remain.', { exact: true }).waitFor();
    await gone.getByText("Turns not recorded: Elpis no longer has this chat, so its turns can't be read.", { exact: true }).waitFor();
    assert.equal(await gone.getByRole('button', { name: 'Open chat', exact: true }).count(), 0);
    const turns = gone.getByRole('list', { name: 'Turns', exact: true });
    assert.equal(await turns.locator(':scope > li').count(), 1);
    await turns.locator(':scope > li > button').click();
    const prune = turns.locator('.trace-step');
    await prune.getByRole('button', { name: /Smart Prune/ }).click();
    const flat = (await prune.innerText()).replace(/\s+/g, ' ');
    assert.match(flat, /exec_command ≈4k → ≈1k Removed ≈3k \(75%\)/);
    assert.match(flat, /Not recorded whether the main model got the shortened text/);
    assert.equal(await prune.getByRole('button', { name: 'Open record', exact: true }).count(), 0);
    assert.match(flat, /No readable record has been written for this chat yet/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Observability fits: list and chat, light and dark, 1280x800 and 900x700', async () => {
  for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [900, 700]]) {
    const f = await fixture({ width, height, colorScheme, routes: routes([]) });
    try {
      const { page } = f, label = `${colorScheme} ${width}x${height}`;
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Observability', exact: true }).click();
      const chats = page.getByRole('region', { name: 'Chats', exact: true });
      await chats.getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
      await assertUiFit(page.locator('.observability'), `list ${label}`);
      await shot(page, `observability-list-${colorScheme}-${width}`);
      await chats.getByRole('button', { name: 'Fix the parser', exact: true }).click();
      const turns = page.getByRole('list', { name: 'Turns', exact: true });
      await turns.locator(':scope > li > button').first().click();
      await turns.locator('.trace-step').first().waitFor();
      await turns.locator('.trace-step').nth(1).getByRole('button', { name: /Smart Prune/ }).click();
      await assertUiFit(page.locator('.observability'), `chat ${label}`);
      await shot(page, `observability-chat-${colorScheme}-${width}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('Observability: no records yet, and a failed read can be retried without invented totals', async () => {
  let broken = true, none = false;
  const all = routes([]), f = await fixture({ routes: { ...all,
    '/api/observability': (body, url) => broken ? { __http: 503, error: 'Records temporarily unavailable' }
      : none ? { available: false, records: '~/.elpis-next/logs/smart-prune', totals: totals({}), skipped: { unreadable: 0, unlinkedAdmissions: 0 }, chats: { data: [], nextCursor: null } } : all['/api/observability'](body, url) } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('alert').getByText('Records temporarily unavailable', { exact: false }).waitFor();
    assert.equal(await page.locator('.observability .trace-row').count(), 0);
    broken = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'Fix the parser', exact: true }).waitFor();
    none = true;
    await page.getByRole('region', { name: 'Smart Prune', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('No Smart Prune records yet', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Chats', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
