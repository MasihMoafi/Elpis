const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { edges, sameEdges, ledgerGeometry, sameLedger, sharedColumns } = require('./page-column.cjs');

const shots = process.env.A126_SHOTS_DIR || path.resolve(__dirname, '../test-results/page-column');
const skills = Array.from({ length: 40 }, (_, index) => ({
  id: `skill-${index}`, name: `Skill ${index + 1}`, path: `/tmp/column-fixture/skill-${index}/SKILL.md`,
  scope: 'user', enabled: false, plugin: null, deletable: false,
  description: 'A long description checks that text stays inside the shared column. '.repeat(4),
}));
const customize = () => ({ skills: { data: skills, errors: [] }, plugins: { data: [] }, connectors: { data: [] } });

for (const colorScheme of ['light', 'dark']) for (const width of [900, 1280, 2000]) {
  test(`page column: Ledger long and empty tabs (${colorScheme}, ${width}px)`, async t => {
    let release, failed = false, first = true;
    const pending = new Promise(resolve => { release = resolve; });
    const f = await fixture({ width, height: 800, colorScheme, showScrollbars: true, routes: {
      '/api/customize': () => {
        if (first) { first = false; return pending; }
        return failed ? { __http: 503, error: 'Skills temporarily unavailable' } : customize();
      },
    } });
    const { page } = f;
    try {
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
      await page.getByText('Reading what Elpis has…', { exact: true }).waitFor();
      const loadingColumn = await edges(page.locator('.customize'));
      const loadingTabs = await edges(page.getByRole('radiogroup', { name: 'Ledger', exact: true }));
      release(customize());
      await page.locator('.customize-item').last().waitFor();
      const tabs = page.getByRole('radiogroup', { name: 'Ledger', exact: true });
      const long = await ledgerGeometry(page);
      assert.equal(long.scrolling, true, 'Skills must exercise a real page scrollbar');
      assert.ok(long.gutter > 0, 'native scrollbars must consume horizontal space; hidden/overlay scrollbars cannot reproduce A126');
      await fs.mkdir(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `skills-${colorScheme}-${width}.png`) });
      // Check the first, middle and last rows through real scrolling, then return to the tab bar.
      for (const index of [0, 19, 39]) await page.locator('.customize-item').nth(index).scrollIntoViewIfNeeded();
      await tabs.scrollIntoViewIfNeeded();
      sameLedger(await ledgerGeometry(page), long, 'scrolling Skills');
      const snapshots = { Skills: long };
      for (const name of ['Plugins', 'Connectors', 'Skills']) {
        await tabs.getByRole('radio', { name, exact: true }).click();
        await page.getByRole('heading', { name: `Your ${name.toLowerCase()}`, exact: true }).waitFor();
        snapshots[name] = await ledgerGeometry(page);
        await page.screenshot({ path: path.join(shots, `${name.toLowerCase()}-${colorScheme}-${width}.png`) });
      }
      t.diagnostic(JSON.stringify(snapshots));
      await fs.writeFile(path.join(shots, `edges-${colorScheme}-${width}.json`), JSON.stringify(snapshots, null, 2) + '\n');
      for (const name of ['Plugins', 'Connectors']) {
        assert.equal(snapshots[name].scrolling, false, `${name} must exercise an empty, non-scrolling page`);
        sameLedger(snapshots[name], long, name);
      }
      sameEdges(long.column, loadingColumn, 'loading column');
      sameEdges(long.tabs, loadingTabs, 'loading tab bar');
      sameLedger(snapshots.Skills, long, 'return to Skills');
      await tabs.getByRole('radio', { name: 'Connectors', exact: true }).click();
      failed = true;
      await page.getByRole('button', { name: 'Refresh connectors', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Skills temporarily unavailable' }).waitFor();
      sameLedger(await ledgerGeometry(page), snapshots.Connectors, 'rejected refresh');
      failed = false;
      await page.reload();
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
      await page.locator('.customize-item').last().waitFor();
      sameLedger(await ledgerGeometry(page), long, 'after reload');
      await page.getByRole('radiogroup', { name: 'Ledger', exact: true }).getByRole('radio', { name: 'Plugins', exact: true }).click();
      sameLedger(await ledgerGeometry(page), long, 'empty tab after reload');
      assert.deepEqual(f.errors, []);
    } finally { release(customize()); await f.close(); }
  });
}

// Changing only the window height makes the real page gain/lose its scrollbar without altering its width or CSS.
// Covers every other centred shell, including Settings' inner scroll owner and Lab's direct workspace surface.
for (const colorScheme of ['light', 'dark']) for (const width of [900, 1280, 2000]) test(`page column: shared shells (${colorScheme}, ${width}px)`, async t => {
  const f = await fixture({ width, height: 800, colorScheme, showScrollbars: true, routes: {
    '/api/settings': () => ({ version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
      smartPrune: { enabled: false, explicitOverride: { available: false } }, memory: { enabled: false, generate: false, use: false, extractionModel: null, consolidationModel: null },
      options: {}, write: { available: true, reason: '' } }),
    '/api/experiment-lab': () => ({ record: null, entries: [] }),
    '/api/observability': () => ({ available: true, totals: { attempts: 0, saved: 0 }, skipped: {}, chats: { data: Array.from({ length: 30 }, (_, index) => ({
      id: `observed-${index}`, chat: { id: `observed-${index}`, name: `Observed chat ${index + 1}` }, totals: { attempts: 0, saved: 0 },
    })), nextCursor: null } }),
  } });
  const { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('button', { name: 'Observed chat 30', exact: true }).waitFor();
    await sharedColumns(page, width, value => t.diagnostic(JSON.stringify(value)), { requireObservabilityOverflow: true });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
