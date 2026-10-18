const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { files, contextRoutes } = require('./context-files-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const popupOf = page => page.getByRole('dialog', { name: 'Context window usage', exact: true });
async function open(f) { await f.open('chat-a'); await f.page.getByRole('button', { name: /^Ledger/ }).click(); await popupOf(f.page).getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor(); }
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
    await f.open('chat-a'); await f.page.getByRole('button', { name: /^Ledger/ }).click(); const popup = popupOf(f.page);
    await popup.getByRole('alert').waitFor(); failed = false; await popup.getByRole('button', { name: 'Retry context files' }).click(); await popup.getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor();
    await f.page.keyboard.press('Escape'); await f.open('chat-b'); await f.page.getByRole('button', { name: /^Ledger/ }).click(); await popup.getByText('No portable context is available.', { exact: true }).waitFor(); assert.equal(await popup.getByRole('switch').count(), 0);
  } finally { await f.close(); }
});

test('Ledger rejects a malformed source response and recovers without losing the usage display', async () => {
  let malformed = true;
  const f = await fixture({ routes: { ...contextRoutes(), '/api/threads/chat-a/context-files': () => malformed ? { files: [{ name: 'ES.md' }] } : { files: files() } } });
  try {
    await f.open('chat-a'); await f.page.getByRole('button', { name: /^Ledger/ }).click(); const popup = popupOf(f.page);
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
