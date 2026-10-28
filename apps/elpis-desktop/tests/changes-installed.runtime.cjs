// Real packaged app + installed provider bridge. No mock routes or inference.
// ELPIS_TEST_APP=/tmp/a25-app ELPIS_TEST_ENGINE=/absolute/codex
// ELPIS_TEST_SESSION=/tmp/COPY-of-rollout.jsonl ELPIS_PLAYWRIGHT_PACKAGE=/absolute/playwright
// node --test tests/changes-installed.runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chooseTheme } = require('./controls.cjs');
const exec = promisify(execFile);

test('A25 packaged app: real recorded changes, file selection, manual edit, reload and both themes', {
  skip: !process.env.ELPIS_TEST_APP || !process.env.ELPIS_TEST_SESSION || !process.env.ELPIS_TEST_ENGINE,
  timeout: 120000,
}, async t => {
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a25-installed-'));
  const seed = path.join(root, 'seed'), folder = path.join(root, 'notes'), sessions = path.join(seed, 'sessions/2026/10/17');
  await fs.mkdir(sessions, { recursive: true }); await fs.mkdir(folder);
  const raw = await fs.readFile(process.env.ELPIS_TEST_SESSION, 'utf8'), rows = raw.trim().split('\n').map(line => JSON.parse(line));
  const meta = rows.find(row => row.type === 'session_meta').payload;
  const changes = rows.filter(row => row.payload?.item?.type === 'FileChange' && row.payload.item.status === 'completed');
  assert.ok(changes.length > 1, 'provide a copied real session with recorded edits');
  const names = [...new Set(changes.flatMap(row => Object.keys(row.payload.item.changes)))].map(name => path.relative(meta.cwd, name)).sort();
  await fs.writeFile(path.join(sessions, `rollout-2026-10-17T23-33-38-${meta.id}.jsonl`), raw.split(meta.cwd).join(folder));
  const helper = process.env.ELPIS_E2E_APP_HELPER || path.join(os.homedir(), '.cache/elpis-tests/e2e/app.sh');
  const port = process.env.ELPIS_TEST_PORT || '9445', shots = process.env.ELPIS_CHANGES_SHOTS || '/tmp/a25-shots';
  await fs.mkdir(shots, { recursive: true });
  const env = { PATH: process.env.PATH, ELPIS_NODE_BIN: process.execPath, ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE };
  let appHome, browser;
  try {
    const { stdout } = await exec(helper, ['start', path.resolve(process.env.ELPIS_TEST_APP), port, seed], { env, timeout: 75000 });
    appHome = stdout.trim();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the packaged app must open its renderer'); page.setDefaultTimeout(15000);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator(`.thread-row[data-thread-id="${meta.id}"] .thread-link`).click();
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    const side = page.getByRole('region', { name: 'Side panel' });
    await side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Changes', exact: true }).click();
    await side.getByRole('list', { name: 'Changed files' }).waitFor();
    assert.deepEqual(await side.locator('.change-path').allInnerTexts(), names);
    const open = async name => {
      await side.getByRole('button', { name: `View diff of ${name}`, exact: true }).click();
      const diff = side.getByRole('region', { name: `Diff of ${name}`, exact: true });
      await diff.locator('.diff-text').first().waitFor(); return diff;
    };
    for (const theme of ['light', 'dark']) {
      await chooseTheme(page, theme);
      for (const name of [names[0], names[Math.floor(names.length / 2)], names.at(-1)]) {
        const diff = await open(name);
        await page.screenshot({ path: path.join(shots, `installed-${theme}-${names.indexOf(name)}.png`) });
        assert.equal(await diff.locator('.diff-no, .diff-hunk').count(), 0, 'plain +/- lines, without Git gutters or headers');
        assert.equal(await side.getByRole('button', { name: 'Discard', exact: true }).count(), 0);
      }
    }
    const selected = names.at(-1), diff = await open(selected), before = await diff.locator('.diff-body').innerText();
    await fs.mkdir(path.dirname(path.join(folder, selected)), { recursive: true });
    await fs.writeFile(path.join(folder, selected), 'Later manual edit.\n');
    await side.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator(`.thread-row[data-thread-id="${meta.id}"] .thread-link`).click();
    const show = page.getByRole('button', { name: 'Show side panel', exact: true });
    if (await show.isVisible()) await show.click();
    const tab = side.getByRole('tab', { name: 'Changes', exact: true });
    if (await tab.count()) await tab.click();
    else {
      await side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Changes', exact: true }).click();
    }
    const reloaded = await open(selected);
    assert.equal(await reloaded.locator('.diff-body').innerText(), before, 'reloading preserves recorded edits after a manual edit');
    const refused = await page.evaluate(async id => (await fetch(`/api/threads/${id}/git?view=file&path=..%2Fsecret`)).status, meta.id);
    assert.equal(refused, 400, 'the real bridge validates the request');
    t.diagnostic(`Real app: ${appHome}; seed: ${seed}; screenshots: ${shots}`);
  } catch (error) {
    appHome ||= /\/tmp\/e2e-[\w-]+/.exec(error.stderr || '')?.[0];
    throw error;
  } finally {
    await browser?.close(); if (appHome) await exec(helper, ['stop', appHome], { timeout: 10000 });
  }
});
