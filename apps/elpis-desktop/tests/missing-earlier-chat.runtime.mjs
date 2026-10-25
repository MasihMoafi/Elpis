// A chat whose earlier part is gone still opens in the desktop (24 Oct 2026: his rust-obsidian chat failed every read
// with -32600 "invalid paginated history lineage …: missing source rollout"). The packaged app, its own bridge and the
// real engine in a throwaway home (app.sh), seeded with that chat's shape: a later rollout whose history_base is deleted.
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_PORT=9483] [ELPIS_TEST_SHOTS=/abs/dir] node --test tests/missing-earlier-chat.runtime.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const { uuid7 } = require('./seed-chats.cjs');
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const port = process.env.ELPIS_TEST_PORT || '9483';
const refused = /missing source rollout|invalid paginated history|-32600|ELPIS_RUNTIME_ERROR|temporarily unavailable/;

test('a chat whose earlier part was deleted opens in the desktop, with a note', { skip: !ready, timeout: 300000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-earlier-')), seed = path.join(root, 'seed');
  const shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots'); await fs.mkdir(shots, { recursive: true });
  const now = Date.now(), at = new Date(now - 60000).toISOString(), thread = uuid7(now - 3 * 86400000), missing = uuid7(now - 86400000), segment = uuid7(now - 60000);
  const dir = path.join(seed, 'sessions', at.slice(0, 4), at.slice(5, 7), at.slice(8, 10)), work = path.join(seed, 'work');
  await fs.mkdir(dir, { recursive: true }); await fs.mkdir(work, { recursive: true });
  const base = 45271, line = (offset, type, payload) => JSON.stringify({ timestamp: at, ordinal: base + offset, type, payload });
  const rows = [
    line(0, 'session_meta', { id: thread, session_id: thread, timestamp: at, cwd: work, originator: 'elpis-desktop', cli_version: '0.162.0', source: 'vscode', thread_source: 'user', model_provider: 'openai', history_mode: 'paginated', history_base: { thread_id: missing, end_ordinal_exclusive: base, end_byte_offset: 41901968 } }),
    line(1, 'event_msg', { type: 'task_started', turn_id: 'turn-remaining', started_at: Math.floor(now / 1000) - 60 }),
    line(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'REMAINING QUESTION about the vault' }] }),
    line(3, 'event_msg', { type: 'user_message', message: 'REMAINING QUESTION about the vault', images: [], local_images: [], text_elements: [] }),
    line(4, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'REMAINING ANSWER kept after the gap' }] }),
    line(5, 'event_msg', { type: 'agent_message', message: 'REMAINING ANSWER kept after the gap' }),
    line(6, 'event_msg', { type: 'task_complete', turn_id: 'turn-remaining', last_agent_message: 'REMAINING ANSWER kept after the gap' }),
  ];
  await fs.writeFile(path.join(dir, `rollout-${at.slice(0, 19).replace(/:/g, '-')}-${thread}_${segment}.jsonl`), rows.join('\n') + '\n');
  const app = await startApp({ app: path.resolve(process.env.ELPIS_TEST_APP), port, seed, engine: process.env.ELPIS_TEST_ENGINE });
  t.after(async () => {
    await app.page.screenshot({ path: path.join(shots, 'missing-earlier-last.png') }).catch(() => {});
    await stopApp(app);
    t.diagnostic(`evidence: ${root} (app home ${app.home})`);
  });
  const { page } = app; page.setDefaultTimeout(30000);
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 }); await skipFirstRun(page);
  await page.locator('aside.sidebar').getByText(/^REMAINING QUESTION/).click();
  const chat = page.locator('.chat-content');
  await chat.getByText('REMAINING ANSWER kept after the gap').or(page.getByText(refused)).first().waitFor();
  assert.equal(await page.getByText(refused).count(), 0, 'the chat must not be refused');
  await chat.getByText('REMAINING QUESTION about the vault').waitFor();
  await page.getByText('The earliest part of this chat is missing', { exact: false }).first().waitFor({ timeout: 15000 });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme }); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `missing-earlier-${theme}.png`) });
  }
});
