// Observability: what Elpis's context machinery did, read-only. Smart Prune's totals and its chats; a chat's context
// over the turns, its runs with what each output's pruner decided and what was admitted; "not recorded" where a record
// is missing. Local bridge fixture (tests/parity-fixture.cjs) with the bridge's replies faked by `routes`; no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

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
  run('r3', 'model_error', 'failed', { prunerTokens: null, error: 'stream disconnected before completion', items: [item('c4', 'web_search', 1300, null)] }),
  run('r2', 'unchanged', 'unchanged', { items: [item('c3', 'exec_command', 1100, 'compact')] }),
  run('r1', 'admitted', 'compacted', { candidates: 2, shortened: 1, saved: 1500, items: [item('c1', 'exec_command', 2000, 'compact', 500), item('c2', 'read_file', 1500, 'unchanged')],
    admission: { id: 'ad1', before: 2000, after: 500, saved: 1500, requestSequence: 7 } })];
const TURNS = { available: true, data: [
  { turnId: 't1', at: '2026-10-16T09:00:01Z', contextTokens: 10000, window: 100000, requests: 1, saved: 1500 },
  { turnId: 't2', at: '2026-10-16T09:09:00Z', contextTokens: 15000, window: 100000, requests: 2, saved: 0 },
  { turnId: 't3', at: '2026-10-16T09:20:00Z', contextTokens: null, window: null, requests: 0, saved: 0 }] };

/** The bridge's two routes over the records above, two runs and two chats a page; every URL asked is kept. */
function routes(asked) {
  return {
    '/api/observability': (_, url) => { asked.push(url.search); const start = Number(url.searchParams.get('cursor') ?? 0); return { ...OVERVIEW, chats: { data: CHATS.slice(start, start + 2), nextCursor: start + 2 < CHATS.length ? String(start + 2) : null } }; },
    '/api/observability/chats/chat-a': (_, url) => {
      asked.push(`chat-a${url.search}`);
      const status = url.searchParams.get('status'), cursor = url.searchParams.get('cursor');
      const matching = RUNS.filter(entry => (!status || entry.outcome === status) && (!cursor || entry.id < cursor)), page = matching.slice(0, 2);
      return { id: 'chat-a', found: true, chat: CHATS[0].chat, totals: CHATS[0].totals, turns: TURNS, attempts: { data: page, nextCursor: matching.length > 2 ? page.at(-1).id : null } };
    },
    [`/api/observability/chats/${GONE}`]: () => ({ id: GONE, found: false, chat: null, totals: CHATS[1].totals, turns: { available: false, reason: 'chat-missing' },
      attempts: { data: [run('r9', 'admitted', 'compacted', { shortened: 1, saved: 3000, items: [item('c5', 'exec_command', 4000, 'compact', 1000)], admission: { id: 'ad2', before: 4000, after: 1000, saved: 3000, requestSequence: null } })], nextCursor: null } }),
  };
}
const texts = locator => locator.allInnerTexts().then(values => values.map(value => value.replace(/\s+/g, ' ').trim()));

test('Observability: Smart Prune totals and chats; a chat opens; its turns, runs, decisions and admissions; filters and pages', async () => {
  const asked = [], f = await fixture({ width: 1280, height: 900, routes: routes(asked) });
  try {
    const { page } = f;
    await page.locator(".startup-splash").waitFor({ state: "detached" });
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    assert.deepEqual(await page.locator('.nav-list button[aria-current="page"]').allInnerTexts(), ['Observability']);
    const prune = page.getByRole('region', { name: 'Smart Prune', exact: true });
    await prune.locator('.stat-card').first().waitFor();
    assert.deepEqual(await texts(prune.locator('.stat-card')), [
      "Smart Prune runs 1,598 1,453 compacted · 120 unchanged · 25 failed",
      "Tokens saved ≈3.1m ≈4.1m → ≈1m in 1,454 of 1,600 outputs",
      "Pruner's own tokens 7.6m Input + output over 1,574 runs · not recorded for 24"]);
    assert.match(await prune.innerText(), /~\/\.elpis-next\/logs\/smart-prune/);

    const chats = page.getByRole('region', { name: 'Chats', exact: true });
    assert.deepEqual(await texts(chats.locator('.customize-name')), ['Fix the parser', `Deleted chat · ${GONE.slice(-8)}`]);
    assert.equal(await chats.getByRole('button', { name: 'Open chat', exact: true }).count(), 1, 'a deleted chat has no chat to open');
    assert.match(await chats.innerText(), /267 admission folders have no matching run, so they are not counted/);
    await chats.getByRole('button', { name: 'Show more chats', exact: true }).click();
    await chats.getByText('Write the docs', { exact: true }).waitFor();
    assert.equal(await chats.getByRole('button', { name: 'Show more chats', exact: true }).count(), 0);
    assert.deepEqual(asked.slice(0, 2), ['?limit=20', '?limit=20&cursor=2']);

    // Open chat goes to the chat itself.
    await chats.locator('.customize-item').first().getByRole('button', { name: 'Open chat', exact: true }).click();
    await page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    assert.deepEqual(await page.locator('.nav-list button[aria-current="page"]').allInnerTexts(), []);

    // A chat's page, chosen with the keyboard.
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'Fix the parser', exact: true }).focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: 'Fix the parser', exact: true });
    await detail.getByRole('heading', { name: 'Fix the parser', exact: true }).waitFor();
    await detail.locator('.stat-card .stat-value').first().waitFor();
    assert.deepEqual(await texts(detail.locator('.stat-card .stat-value')), ['3', '≈1.5k', '3k']);

    const turns = page.getByRole('list', { name: 'Context per turn', exact: true });
    assert.deepEqual(await turns.locator('li').evaluateAll(bars => bars.map(bar => bar.getAttribute('aria-label'))), [
      'Turn 1: 10k of 100k tokens in context, 1 request; Smart Prune saved ≈1.5k',
      'Turn 2: 15k of 100k tokens in context, 2 requests',
      'Turn 3: not measured']);
    assert.deepEqual(await turns.locator('li > i').evaluateAll(bars => bars.map(bar => bar.style.height)), ['10%', '15%']);
    assert.equal(await turns.locator('li[tabindex="0"]').count(), 3, 'every turn can be reached with the keyboard');
    await turns.locator('li').nth(1).hover();
    const tip = turns.locator('li').nth(1).getByRole('tooltip');
    await tip.waitFor({ state: 'visible' });
    assert.match(await tip.innerText(), /15k of 100k[\s\S]*Turn 2/);
    assert.match(await page.locator('.context-turns figcaption').innerText(), /Latest 15k of 100k \(15%\)/);

    const runs = page.getByRole('region', { name: 'Smart Prune runs', exact: true });
    assert.equal(await runs.locator('.observability-run').count(), 2);
    await runs.getByRole('button', { name: 'Show more runs', exact: true }).click();
    await runs.locator('.observability-run').nth(2).waitFor();
    assert.deepEqual(asked.filter(url => url.startsWith('chat-a')), ['chat-a?limit=25', 'chat-a?limit=25&cursor=r2']);
    const [failed, unchanged, compacted] = await runs.locator('.observability-run').all();
    assert.match(await failed.locator('summary').innerText(), /Model error[\s\S]*stream disconnected before completion/);
    await compacted.locator('summary').click();
    assert.match(await compacted.innerText(), /Shortened 1 of 2 outputs · ≈2k → ≈500 · ≈1.5k saved/);
    assert.deepEqual(await texts(compacted.locator('.observability-output')), [
      'exec_command · ≈2k tokens Shortened to ≈500 tokens, ≈1.5k saved',
      'read_file · ≈1.5k tokens Kept: the pruner left it as it was']);
    assert.match(await compacted.innerText(), /The main model got the shortened text in request 7/);
    await unchanged.locator('summary').click();
    assert.match(await unchanged.locator('.observability-output').innerText(), /Kept: the shorter text saved under 256 tokens or under 20%/);

    // The filter, with the keyboard.
    await runs.getByRole('radio', { name: 'Failed', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Smart Prune runs"] .observability-run').length === 1);
    assert.equal(asked.at(-1), 'chat-a?limit=25&status=failed');
    if (process.env.ELPIS_SHOTS) { await runs.getByRole('radio', { name: 'All', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('[aria-label="Smart Prune runs"] .observability-run').length === 2); await turns.locator('li').nth(1).hover(); await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/observability-chat-light.png` }); }

    // Back keeps the chats already listed.
    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    await chats.getByText('Write the docs', { exact: true }).waitFor();
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/observability-light.png` });

    // A deleted chat: its records, and "not recorded" for what only the chat had.
    await page.getByRole('button', { name: `Deleted chat · ${GONE.slice(-8)}`, exact: true }).click();
    const gone = page.getByRole('region', { name: `Deleted chat · ${GONE.slice(-8)}`, exact: true });
    await gone.getByText('Elpis no longer has this chat; its Smart Prune records remain.', { exact: true }).waitFor();
    await gone.getByText("Not recorded: Elpis no longer has this chat, so its turns can't be read.", { exact: true }).waitFor();
    assert.equal(await gone.getByRole('button', { name: 'Open chat', exact: true }).count(), 0);
    await gone.locator('.observability-run summary').click();
    assert.match(await gone.innerText(), /Not recorded whether the main model got the shortened text/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Observability in dark mode, and with no records yet', async () => {
  let records = true;
  const asked = [], all = routes(asked), f = await fixture({ width: 1280, height: 900, colorScheme: 'dark', routes: { ...all,
    '/api/observability': (body, url) => records ? all['/api/observability'](body, url) : { available: false, records: '~/.elpis-next/logs/smart-prune', totals: totals({}), skipped: { unreadable: 0, unlinkedAdmissions: 0 }, chats: { data: [], nextCursor: null } } } });
  try {
    const { page } = f;
    await page.locator(".startup-splash").waitFor({ state: "detached" });
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('region', { name: 'Chats', exact: true }).getByText('Fix the parser', { exact: true }).waitFor();
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/observability-dark.png` });
    await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'Fix the parser', exact: true }).click();
    const bar = page.getByRole('list', { name: 'Context per turn', exact: true }).locator('li > i').first();
    await bar.waitFor();
    // The bars wear the context ring's colour (--context), in this mode's step.
    assert.equal(await bar.evaluate(element => getComputedStyle(element).backgroundColor), await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--context)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }));
    if (process.env.ELPIS_SHOTS) { await page.getByRole('list', { name: 'Context per turn', exact: true }).locator('li').nth(1).hover(); await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/observability-chat-dark.png` }); }
    records = false;
    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    await page.getByRole('region', { name: 'Smart Prune', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('No Smart Prune records yet', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Chats', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Observability: a failed read can be retried without showing invented totals', async () => {
  let broken = true;
  const all = routes([]), f = await fixture({ routes: {
    ...all,
    '/api/observability': (body, url) => broken ? { __http: 503, error: 'Records temporarily unavailable' } : all['/api/observability'](body, url),
  } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('alert').getByText('Records temporarily unavailable', { exact: false }).waitFor();
    assert.equal(await page.locator('.observability .stat-card').count(), 0);
    broken = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).focus();
    await page.keyboard.press('Enter');
    const chats = page.getByRole('region', { name: 'Chats', exact: true });
    await chats.getByRole('button', { name: 'Fix the parser', exact: true }).click();
    const turns = page.getByRole('list', { name: 'Context per turn', exact: true });
    await turns.locator('li').first().focus();
    await turns.locator('li').first().getByRole('tooltip').waitFor({ state: 'visible' });
    await page.getByText('Turn measurements', { exact: true }).click();
    assert.match(await page.locator('.observability-table table').innerText(), /Not measured/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
