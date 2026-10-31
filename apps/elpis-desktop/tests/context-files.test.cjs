const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { files, contextRoutes } = require('./context-files-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const popupOf = page => page.getByRole('dialog', { name: 'Context window usage', exact: true });
async function open(f) { await f.open('chat-a'); await f.page.locator('.composer .context-ring').click(); await popupOf(f.page).getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor(); }
const animationFrames = (page, count = 12) => page.evaluate(count => new Promise(resolve => {
  const tick = () => --count > 0 ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick);
}), count);
async function traceOpening(page) {
  await page.evaluate(() => {
    window.__contextOpeningFrames = []; window.__traceContextOpening = true;
    const box = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return s.visibility === 'visible' && s.display !== 'none' && r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null; };
    const tick = () => { window.__contextOpeningFrames.push({ popup: box('.context-ledger'), app: box('.app-shell'), composer: box('.composer') }); if (window.__traceContextOpening) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  });
}
async function assertStableOpening(page, label) {
  const frames = await page.evaluate(() => { window.__traceContextOpening = false; return window.__contextOpeningFrames; });
  const ranges = {};
  for (const selector of ['popup', 'app', 'composer']) {
    const boxes = frames.map(frame => frame[selector]).filter(Boolean); assert.ok(boxes.length >= 5, `${label}: ${selector} painted frames`);
    ranges[selector] = ['x', 'y', 'width', 'height'].map((_, axis) => [Math.min(...boxes.map(box => box[axis])), Math.max(...boxes.map(box => box[axis]))]);
    for (let axis = 0; axis < 4; axis++) assert.ok(Math.max(...boxes.map(box => box[axis])) - Math.min(...boxes.map(box => box[axis])) <= 1, `${label}: ${selector} visible bounds jumped: ${JSON.stringify([...new Set(boxes.map(box => JSON.stringify(box)))])}`);
  }
  if (process.env.ELPIS_A20_SHOTS) { const { width, height } = page.viewportSize(); await fs.mkdir(process.env.ELPIS_A20_SHOTS, { recursive: true }); await fs.writeFile(`${process.env.ELPIS_A20_SHOTS}/geometry-${width}x${height}-${label.replaceAll(' ', '-')}.json`, JSON.stringify({ label, ranges, frames }, null, 2)); }
}
for (const [colorScheme, width, height] of [['light', 1280, 800], ['dark', 900, 520]]) test(
  `Ledger stable opening: ${colorScheme} ${width}×${height}, delayed pointer and immediate keyboard`, async () => {
    let release, requested, reads = 0; const held = new Promise(resolve => requested = resolve);
    const f = await fixture({ staticDir: process.env.A20_STATIC_DIR || undefined, width, height, colorScheme, routes: { ...contextRoutes(), '/api/threads/chat-a/context-files': async () => { if (++reads === 1) { requested(); await new Promise(resolve => release = resolve); } return { files: files() }; } } });
    try {
      await f.open('chat-a'); const ring = f.page.getByRole('button', { name: 'Context window: 25% used', exact: true, includeHidden: true }); await ring.waitFor({ state: 'attached' });
      assert.equal(await ring.isVisible(), width === 1280, 'narrow composers use the Ledger button instead of the hidden ring');
      const trigger = width === 1280 ? ring : f.page.locator('.composer .context-ring');
      await traceOpening(f.page); await trigger.click(); await held; await animationFrames(f.page);
      if (process.env.ELPIS_A20_SHOTS) { await fs.mkdir(process.env.ELPIS_A20_SHOTS, { recursive: true }); await f.page.screenshot({ path: `${process.env.ELPIS_A20_SHOTS}/${colorScheme}-${width}x${height}-pending.png` }); }
      release(); await popupOf(f.page).getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor(); await animationFrames(f.page);
      await assertStableOpening(f.page, 'delayed response');
      if (process.env.ELPIS_A20_SHOTS) { await fs.mkdir(process.env.ELPIS_A20_SHOTS, { recursive: true }); await f.page.screenshot({ path: `${process.env.ELPIS_A20_SHOTS}/${colorScheme}-${width}x${height}.png` }); }
      await f.page.keyboard.press('Escape'); await popupOf(f.page).waitFor({ state: 'hidden' });
      await trigger.focus(); await traceOpening(f.page); await f.page.keyboard.press('Enter');
      await popupOf(f.page).getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor(); await animationFrames(f.page);
      await assertStableOpening(f.page, 'immediate response'); assert.equal(reads, 2, 'every opening reads fresh sources'); assert.deepEqual(f.errors, []);
    } finally { release?.(); await f.close(); }
  });
test('Ledger waits for initial usage, reveals at stable bounds, and stops file polling when closed', async () => {
  let release, asked, reads = 0; const requested = new Promise(resolve => asked = resolve), routes = contextRoutes();
  const f = await fixture({ routes: { ...routes,
    '/api/threads/chat-a/context': async () => { asked(); await new Promise(resolve => release = resolve); return routes['/api/threads/chat-a/context'](); },
    '/api/threads/chat-a/context-files': () => { reads++; return { files: files() }; },
  } });
  try {
    await f.open('chat-a'); await requested;
    await traceOpening(f.page); await f.page.locator('.composer .context-ring').click();
    await f.page.getByRole('button', { name: 'Loading context window…', exact: true }).waitFor(); await animationFrames(f.page);
    assert.equal(await popupOf(f.page).isVisible(), false, 'files do not reveal a card that still awaits usage');
    release(); await popupOf(f.page).getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor(); await animationFrames(f.page); await assertStableOpening(f.page, 'cold usage');
    await f.page.keyboard.press('Escape'); await popupOf(f.page).waitFor({ state: 'hidden' });
    await f.page.waitForTimeout(3200); assert.equal(reads, 1, 'closing stops file polling'); assert.equal(await popupOf(f.page).isVisible(), false); assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});
test('Ledger cancels pending files across chats and ignores their late reply', async () => {
  let release, asked, reads = 0; const requested = new Promise(resolve => asked = resolve);
  const f = await fixture({ routes: { ...contextRoutes(),
    '/api/threads/chat-a/context-files': async () => { reads++; asked(); await new Promise(resolve => release = resolve); return { files: files() }; },
    '/api/threads/chat-b/context': () => ({ threadId: 'chat-b' }),
    '/api/threads/chat-b/context-files': () => ({ files: [{ ...files()[1], name: 'Chat B memory.md', path: '/tmp/chat-b-memory.md' }] }),
  } });
  try {
    await f.open('chat-a'); await f.page.getByRole('button', { name: 'Context window: 25% used', exact: true }).click(); await requested;
    await f.page.getByRole('button', { name: 'Loading context window…', exact: true }).waitFor();
    const cancelled = f.page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/threads/chat-a/context-files') });
    await f.page.keyboard.press('Escape'); assert.match((await cancelled).failure().errorText, /aborted/i);
    await f.page.getByRole('button', { name: 'Loading context window…', exact: true }).waitFor({ state: 'hidden' }); assert.equal(await popupOf(f.page).isVisible(), false);
    await f.open('chat-b');
    await f.page.locator('.composer .context-ring').click();
    await popupOf(f.page).getByRole('button', { name: 'Open Chat B memory.md', exact: true }).waitFor();
    release(); await animationFrames(f.page);
    assert.equal(await popupOf(f.page).getByRole('button', { name: 'Open ES.md', exact: true }).count(), 0); assert.equal(reads, 1); assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});
test('Ledger times out a stalled initial read, exposes Retry and ignores the late timed-out reply', async () => {
  let release, asked, reads = 0; const requested = new Promise(resolve => asked = resolve), rows = files();
  const f = await fixture({ routes: { ...contextRoutes(),
    '/api/threads/chat-a/context': () => ({ threadId: 'wrong-chat' }),
    '/api/threads/chat-a/context-files': async () => { if (++reads === 1) { const old = structuredClone(rows); asked(); await new Promise(resolve => release = resolve); return { files: old }; } return { files: rows }; },
  } });
  try {
    await f.open('chat-a'); const timedOut = f.page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/threads/chat-a/context-files'), timeout: 14000 });
    await f.page.locator('.composer .context-ring').click(); await requested;
    const busy = f.page.getByRole('button', { name: 'Loading context window…', exact: true }); assert.equal(await busy.getAttribute('aria-busy'), 'true'); assert.equal(await busy.innerText(), '…');
    await popupOf(f.page).getByRole('alert').waitFor({ timeout: 14000 }); assert.match((await timedOut).failure().errorText, /aborted/i); assert.match(await popupOf(f.page).innerText(), /Reading context took too long/); assert.match(await popupOf(f.page).innerText(), /Context usage unavailable/);
    if (process.env.ELPIS_A20_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_A20_SHOTS}/timeout-error.png` });
    rows[0].included = false; await popupOf(f.page).getByRole('button', { name: 'Retry context files', exact: true }).click();
    const toggle = popupOf(f.page).getByRole('switch', { name: 'Include ES.md', exact: true }); await toggle.waitFor();
    assert.equal(reads, 2, 'Retry reaches the server before the timed-out response is released');
    if (process.env.ELPIS_A20_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_A20_SHOTS}/timeout-retry.png` });
    release(); await animationFrames(f.page); assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'timed-out result cannot replace retry'); assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});
for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [900, 700]]) test(
  `Ledger files: ${colorScheme} ${width}×${height}, mouse and keyboard, Files pane and fit`, async () => {
    const f = await fixture({ width, height, colorScheme, routes: { ...contextRoutes(), '/api/file': () => ({ content: '# Checkpoint\nLedger source contents.', size: 36, mtimeMs: 1 }), '/api/files/dir': () => ({ data: [] }) } });
    try {
      await open(f); const popup = popupOf(f.page);
      assert.deepEqual(await popup.locator('.context-files-heading').allTextContents(), ['SESSION CONTINUITY', 'DURABLE MEMORY', 'INSTRUCTIONS']);
      assert.equal(await popup.locator('.context-files-heading').first().evaluate(el => getComputedStyle(el).color), colorScheme === 'dark' ? 'rgb(91, 200, 192)' : 'rgb(0, 124, 120)');
      assert.match(await popup.innerText(), /≈1.3k est. tokens/);
      const toggle = popup.getByRole('switch', { name: 'Include ES.md', exact: true });
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await toggle.click(); await f.page.waitForFunction(() => document.querySelector('[aria-label="Include ES.md"]').getAttribute('aria-checked') === 'false');
      assert.match(await popup.locator('[data-context-path="/tmp/parity-fixture/ES.md"]').innerText(), /EXCLUDED/);
      await toggle.focus(); await f.page.keyboard.press('Space'); await f.page.waitForFunction(() => document.querySelector('[aria-label="Include ES.md"]').getAttribute('aria-checked') === 'true');
      assert.deepEqual(f.posts.filter(p => p.path.endsWith('/context-files')).map(p => p.body), [{ path: files()[0].path, included: false }, { path: files()[0].path, included: true }]);
      assert.equal(await popup.getByRole('switch').last().isDisabled(), true);
      await assertUiFit(popup, 'Ledger file rows fit');
      await fs.mkdir('/tmp/ctxdesk-shots', { recursive: true }); await f.page.screenshot({ path: `/tmp/ctxdesk-shots/${colorScheme}-${width}.png` });
      await popup.getByRole('button', { name: 'Open ES.md', exact: true }).click();
      await f.page.getByRole('button', { name: 'Source', exact: true }).click();
      await f.page.getByRole('textbox', { name: /Contents of/ }).waitFor();
      assert.equal(await popup.isVisible(), false);
      assert.match(await f.page.getByRole('textbox', { name: /Contents of/ }).inputValue(), /Ledger source contents/);
    } finally { await f.close(); }
  });
test('Ledger shows a refused save, keeps admission, and refreshes an external change while open', async () => {
  const rows = files(); let reads = 0;
  const f = await fixture({ routes: { ...contextRoutes(), '/api/threads/chat-a/context-files': body => { if (body) return { __http: 409, error: 'Source changed; reopen Ledger.' }; reads++; return { files: rows }; } } });
  try {
    await open(f); const popup = popupOf(f.page), toggle = popup.getByRole('switch', { name: 'Include ES.md', exact: true });
    await toggle.click(); await popup.getByRole('alert').waitFor(); assert.match(await popup.getByRole('alert').innerText(), /Source changed/); assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    rows[0].included = false;
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Include ES.md"]').getAttribute('aria-checked') === 'false', null, { timeout: 9000 }); assert.ok(reads >= 2);
    await f.page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
  } finally { await f.close(); }
});
test('Ledger reports unavailable context files with retry, and a new chat never shows the previous files', async () => {
  let failed = true;
  const f = await fixture({ routes: { ...contextRoutes(), '/api/threads/chat-a/context-files': () => failed ? { __http: 502, error: 'Context files unavailable' } : { files: files() }, '/api/threads/chat-b/context-files': () => ({ files: [] }) } });
  try {
    await f.open('chat-a'); await f.page.locator('.composer .context-ring').click(); const popup = popupOf(f.page);
    await popup.getByRole('alert').waitFor(); failed = false; await popup.getByRole('button', { name: 'Retry context files' }).click(); await popup.getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor();
    await f.page.keyboard.press('Escape'); await f.open('chat-b'); await f.page.locator('.composer .context-ring').click(); await popup.getByText('No portable context is available.', { exact: true }).waitFor(); assert.equal(await popup.getByRole('switch').count(), 0);
  } finally { await f.close(); }
});

test('Ledger rejects a malformed source response and recovers without losing the usage display', async () => {
  let malformed = true;
  const f = await fixture({ routes: { ...contextRoutes(), '/api/threads/chat-a/context-files': () => malformed ? { files: [{ name: 'ES.md' }] } : { files: files() } } });
  try {
    await f.open('chat-a'); await f.page.locator('.composer .context-ring').click(); const popup = popupOf(f.page);
    await popup.getByRole('alert').waitFor(); assert.match(await popup.getByRole('alert').innerText(), /Context files unavailable/);
    assert.match(await popup.innerText(), /50k \/ 200k/); assert.equal(f.errors.length, 0);
    malformed = false; await popup.getByRole('button', { name: 'Retry context files' }).click(); await popup.getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor();
  } finally { await f.close(); }
});

test('Ledger applies every row returned by a switch and ignores a stale read racing its save', async () => {
  const rows = files(); let reads = 0, release, loading;
  const requested = new Promise(resolve => loading = resolve);
  const f = await fixture({ routes: { ...contextRoutes(), '/api/threads/chat-a/context-files': async body => {
    if (body) { rows[0].included = body.included; rows[2].included = body.included; return { files: rows }; }
    if (++reads === 2) { const old = structuredClone(rows); loading(); return new Promise(resolve => release = () => resolve({ files: old })); }
    return { files: rows };
  } } });
  try {
    await open(f); await requested; const popup = popupOf(f.page);
    await popup.getByRole('switch', { name: 'Include ES.md', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Include AGENTS.md"]').getAttribute('aria-checked') === 'false');
    release(); await f.page.waitForTimeout(250);
    assert.equal(await popup.getByRole('switch', { name: 'Include ES.md', exact: true }).getAttribute('aria-checked'), 'false');
    assert.equal(await popup.getByRole('switch', { name: 'Include AGENTS.md', exact: true }).getAttribute('aria-checked'), 'false');
  } finally { release?.(); await f.close(); }
});
