// The desktop's context window (the ring above the message box) shares the engine's category shares with the terminal's
// Context Ledger. A225/A260 (24 Oct): Reasoning + compaction must be the share of reasoning the model was sent. The packaged
// app, its own bridge and the real engine in a throwaway home (app.sh), against a local Responses stand-in.
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_PORT=9482] [ELPIS_TEST_SHOTS=/abs/dir] node --test tests/context-ledger.runtime.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { model } from './responses-standin.mjs';

const require = createRequire(import.meta.url);
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const port = process.env.ELPIS_TEST_PORT || '9482';
const tokens = text => { const match = /([\d.]+)\s*(k|M)?/.exec(text.replace(/,/g, '')); return Number(match[1]) * (match[2] === 'k' ? 1e3 : match[2] === 'M' ? 1e6 : 1); };

test('A225/A260: the desktop\'s Reasoning + compaction is the share of reasoning the model was sent', { skip: !ready, timeout: 300000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-ledger-')), seed = path.join(root, 'seed');
  const shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots'); await fs.mkdir(shots, { recursive: true });
  const mock = await model();
  await fs.mkdir(seed, { recursive: true });
  await fs.writeFile(path.join(seed, 'config.toml'), ['model = "gpt-5.5"', 'model_provider = "mock"', 'approvals_reviewer = "user"', 'default_permissions = ":danger-full-access"', '',
    '[model_providers.mock]', 'name = "Mock"', `base_url = "http://127.0.0.1:${mock.port}/v1"`, 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', ''].join('\n'));
  const app = await startApp({ app: path.resolve(process.env.ELPIS_TEST_APP), port, seed, engine: process.env.ELPIS_TEST_ENGINE });
  t.after(async () => {
    await app.page.screenshot({ path: path.join(shots, 'context-ledger-last.png') }).catch(() => {});
    await stopApp(app); mock.close();
    t.diagnostic(`evidence: ${root} (app home ${app.home}); model requests: ${mock.state.requests.length}`);
  });
  const { page } = app; page.setDefaultTimeout(30000);
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 }); await skipFirstRun(page);
  // A new chat takes the configured provider (the stand-in); a saved chat keeps the provider it was made with.
  await page.locator('aside.sidebar').getByText('New chat', { exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await box.fill('work 6 on this'); await box.press('Enter');
  await page.locator('.chat-content').getByText(/^reply \d+$/).first().waitFor({ timeout: 120000 });
  const truth = mock.state.last, used = truth.input + truth.output, share = truth.reasoning / used;
  await page.locator('.context-ring').click();
  const rows = page.locator('.context-ledger .context-ledger-row:not([data-category="free"])');
  await page.locator('.context-ledger .context-ledger-row[data-category="reasoning"]').waitFor();
  const values = Object.fromEntries(await rows.evaluateAll(items => items.map(item => [item.dataset.category, item.querySelector('.context-ledger-row-value').textContent])));
  const shown = tokens(values.reasoning) / Object.values(values).reduce((sum, value) => sum + tokens(value), 0);
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme }); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `context-ledger-${theme}.png`) });
  }
  t.diagnostic(`model sent ${truth.reasoning} reasoning tokens of ${used} (${(share * 100).toFixed(1)}%); the desktop shows ${values.reasoning} (${(shown * 100).toFixed(1)}%)`);
  assert.ok(Math.abs(shown - share) < 0.04, `desktop ${(shown * 100).toFixed(1)}% vs sent ${(share * 100).toFixed(1)}%`);
});
