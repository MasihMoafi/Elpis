// Archive and delete in the sidebar, end to end: the packaged app, its own bridge and the real engine, in a throwaway home.
// Chats are fixtures written as rollout files, so every case is known. No inference.
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_PORT=9425] [ELPIS_TEST_SHOTS=/abs/dir] node --test tests/sidebar-archive-delete.runtime.mjs
// The copy starts through ~/.cache/elpis-tests/e2e/app.sh (xvfb, own home, no session bus); ELPIS_E2E_APP_HELPER overrides it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const helper = process.env.ELPIS_E2E_APP_HELPER || path.join(os.homedir(), '.cache/elpis-tests/e2e/app.sh');
const port = process.env.ELPIS_TEST_PORT || '9425';

/** Writes one rollout per chat; agents carry the engine's thread_spawn parent. Newest first in the list. */
async function seed(dir) {
  const sessions = path.join(dir, 'sessions/2026/10/24'), cwd = path.join(dir, 'work'), ids = {};
  await fs.mkdir(sessions, { recursive: true }); await fs.mkdir(cwd, { recursive: true });
  const chats = [['Open one'], ['Pick A'], ['Pick B'], ['Range A'], ['Range B'], ['Menu A'], ['Menu B'], ['Del A'], ['Del B'],
    ['Host'], ['Nested'], ['Mother'], ['Worker one', 'Mother', 1], ['Worker one child', 'Worker one', 2], ['Worker two', 'Mother', 1],
    ['Father'], ['Son', 'Father', 1], ['Last']];
  for (const [index, [name, parent, depth]] of chats.entries()) {
    const id = randomUUID(), stamp = new Date(Date.UTC(2026, 9, 24, 10, 59 - index)), ts = stamp.toISOString();
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: ids[parent], depth, agent_nickname: name, agent_role: 'worker' } } } : 'vscode';
    const meta = { session_id: id, id, timestamp: ts, cwd, originator: 'codex', cli_version: '0.0.0', source, thread_source: parent ? 'subagent' : 'user', model_provider: 'openai' };
    const lines = [{ timestamp: ts, type: 'session_meta', payload: meta },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: name }] } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: name, kind: 'plain' } }];
    const file = path.join(sessions, `rollout-${ts.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
    await fs.writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n'); await fs.utimes(file, stamp, stamp);
    ids[name] = id;
  }
  return ids;
}

test('sidebar archive and delete: one chat, a selection, by key and menu, with agents and nested chats, after reload and restart', { skip: !ready, timeout: 300000 }, async t => {
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-delete-')), shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots');
  await fs.mkdir(shots, { recursive: true });
  const ids = await seed(path.join(root, 'seed')), names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
  const env = { ...process.env, ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE };
  let home, browser, page;
  const start = async (seedDir, configSeed) => {
    const { stdout } = await run(helper, ['start', path.resolve(process.env.ELPIS_TEST_APP), port, seedDir], { env: { ...env, ...(configSeed ? { ELPIS_E2E_CONFIG_SEED: configSeed } : {}) }, timeout: 90000 });
    home = stdout.trim(); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the packaged app opens its renderer'); page.setDefaultTimeout(15000);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    // The first-run name question can come a moment after the startup screen; waiting for it (as tests/real-app.cjs does)
    // keeps it from staying open over every later click when the machine is busy.
    const notNow = page.getByRole('button', { name: 'Not now', exact: true });
    await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => {});
    await page.locator(`.thread-row[data-thread-id="${ids.Mother}"]`).waitFor();
  };
  const stop = async () => { await browser?.close().catch(() => {}); if (home) await run(helper, ['stop', home]).catch(() => {}); };
  t.after(stop);
  await start(path.join(root, 'seed'));

  const row = name => page.locator(`.thread-row[data-thread-id="${ids[name]}"]`), link = name => row(name).locator('.thread-link');
  const shown = async () => (await page.locator('.thread-row').evaluateAll(rows => rows.map(item => item.dataset.threadId))).map(id => names[id] ?? id);
  const marked = async () => (await page.locator('.thread-row.selected').evaluateAll(rows => rows.map(item => item.dataset.threadId))).map(id => names[id] ?? id);
  const listed = async (query = '') => (await page.evaluate(async q => { const all = []; let cursor; do { const page = await (await fetch(`/api/threads?limit=100${q}${cursor ? `&cursor=${cursor}` : ''}`)).json(); all.push(...page.data.map(item => item.id)); cursor = page.nextCursor; } while (cursor); return all; }, query)).map(id => names[id] ?? id);
  const live = () => listed(), archived = () => listed('&archived=true'), agentsOf = name => listed(`&ancestorThreadId=${ids[name]}`);
  /** Waits until the sidebar settles on a list without `gone`. */
  const without = async (...gone) => { await page.waitForFunction(list => !list.some(id => document.querySelector(`.thread-row[data-thread-id="${id}"]`)), gone.map(name => ids[name])); await page.waitForTimeout(400); };
  const noError = async label => { const banners = (await page.locator('.error-banner[role=alert]').allInnerTexts()).filter(text => !text.startsWith('Models unavailable')); assert.deepEqual(banners, [], `${label}: no error`); };
  const confirmDelete = async () => {
    const dialog = page.getByRole('alertdialog'); await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 8000 }).catch(async () => assert.fail(`the delete dialog stayed open: ${await dialog.innerText()}`));
  };
  /** Each case starts from a quiet window: no dialog or menu open, nothing selected. */
  const settle = async () => { for (let i = 0; i < 3 && await page.locator('[role=alertdialog], [role=dialog], [role=menu]').count(); i++) await page.keyboard.press('Escape'); };
  const expand = async name => { const button = page.getByRole('button', { name: `Expand agents in ${name}`, exact: true }); await button.click(); };

  await t.test('Ctrl+Shift+A archives every chat selected with Ctrl+click, not only the open one', async () => {
    await settle(); await link('Open one').click(); await link('Pick A').click({ modifiers: ['Control'] }); await link('Pick B').click({ modifiers: ['Control'] });
    assert.deepEqual(await marked(), ['Open one', 'Pick A', 'Pick B']);
    await page.keyboard.press('Control+Shift+A'); await without('Open one', 'Pick A', 'Pick B');
    assert.deepEqual(await marked(), [], 'nothing stays selected');
    assert.equal(await page.locator('.thread-row.active').count(), 0, 'the open chat was archived: a new chat shows');
    for (const name of ['Open one', 'Pick A', 'Pick B']) assert.ok((await archived()).includes(name), `${name} is archived`);
    await noError('Ctrl+click selection');
  });

  await t.test('Ctrl+Shift+A archives a Shift+click range, even with focus in the message box', async () => {
    await settle(); await link('Range A').click(); await link('Range B').click({ modifiers: ['Shift'] });
    assert.deepEqual(await marked(), ['Range A', 'Range B']);
    await page.getByRole('textbox', { name: 'Message Elpis' }).focus();
    await page.keyboard.press('Control+Shift+A'); await without('Range A', 'Range B');
    const list = await archived(); assert.ok(['Range A', 'Range B'].every(name => list.includes(name)));
    await noError('Shift+click range');
  });

  await t.test('the menu archives the selection; D deletes it and Ctrl+Z brings it back', async () => {
    await settle(); await link('Menu A').click(); await link('Menu B').click({ modifiers: ['Control'] });
    await row('Menu B').click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Archive 2 chats/ }).click(); await without('Menu A', 'Menu B');
    await link('Del A').click(); await link('Del B').click({ modifiers: ['Control'] }); await page.keyboard.press('d'); await confirmDelete(); await without('Del A', 'Del B');
    assert.ok(!(await archived()).includes('Del A'), 'a deleted chat is not offered in Archived chats');
    await page.keyboard.press('Control+z'); await row('Del A').waitFor(); await row('Del B').waitFor();
    await noError('menu and D');
  });

  await t.test('a chat put under another goes with it, and is never left alone in the list', async () => {
    await settle(); await row('Nested').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Put under…', exact: true }).click();
    await page.getByRole('combobox', { name: 'Parent chat' }).click(); await page.getByRole('option', { name: 'Host', exact: true }).click();
    await page.getByRole('button', { name: 'Put under', exact: true }).click();
    await row('Host').click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Archive/ }).click(); await without('Host');
    assert.ok(!(await shown()).includes('Nested'), 'the nested chat is not left at the top of the list');
    assert.ok((await archived()).includes('Nested'), 'it is archived with its chat');
    await noError('nested chat');
  });

  await t.test('archiving a chat archives its agents; Unarchive brings it back with them', async () => {
    await settle(); await expand('Mother'); await row('Worker one').waitFor();
    await row('Mother').click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Archive/ }).click(); await without('Mother', 'Worker one', 'Worker two');
    assert.deepEqual(await agentsOf('Mother'), [], 'no agent of the archived chat stays listed');
    await page.keyboard.press('Control+,'); await page.getByText('Archived chats', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Unarchive Mother', exact: true }).click();
    await page.locator(`.archived-row[data-thread-id="${ids.Mother}"]`).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Back to app', exact: true }).click(); await row('Mother').waitFor();
    assert.deepEqual((await agentsOf('Mother')).sort(), ['Worker one', 'Worker one child', 'Worker two']);
    await row('Worker one').waitFor(); await row('Worker two').waitFor();
    await noError('unarchive with agents');
  });

  await t.test('a chat and its agent selected together are deleted in one step, and Ctrl+Z restores both', async () => {
    await settle(); await expand('Father'); await link('Father').click(); await link('Son').click({ modifiers: ['Control'] });
    await page.keyboard.press('d'); await confirmDelete(); await without('Father', 'Son');
    await noError('chat with its agent');
    await page.keyboard.press('Control+z'); await row('Father').waitFor();
    assert.deepEqual(await agentsOf('Father'), ['Son']);
    await noError('undo chat with its agent');
  });

  await t.test('the last chat in the list, open, deleted from its menu', async () => {
    await settle(); await link('Last').click(); await row('Last').click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Delete/ }).click(); await confirmDelete(); await without('Last');
    assert.equal(await page.locator('.thread-row.active').count(), 0);
  });

  // The sidebar's theme button offers only the other theme.
  for (const theme of ['light', 'dark']) {
    const button = page.getByRole('button', { name: `Use ${theme} theme`, exact: true });
    if (await button.count()) await button.first().click();
    await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `sidebar-${theme}.png`) });
  }
  const gone = ['Open one', 'Pick A', 'Pick B', 'Range A', 'Range B', 'Menu A', 'Menu B', 'Host', 'Nested', 'Last'];
  await t.test('after reloading the window nothing comes back', async () => {
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await row('Mother').waitFor();
    const list = await shown(); assert.deepEqual(gone.filter(name => list.includes(name)), []);
  });
  await t.test('after restarting the app nothing comes back, and the deleted chat is gone for good', async () => {
    await browser.close(); const old = home; await run(helper, ['stop', old]); await new Promise(resolve => setTimeout(resolve, 4000));
    const snapshot = path.join(root, 'restart'); await fs.mkdir(snapshot);
    await fs.cp(path.join(old, 'elpis'), path.join(snapshot, 'elpis'), { recursive: true, filter: source => !/app-server-control|thread-writer-locks/.test(source) });
    await fs.cp(path.join(old, '.config'), path.join(snapshot, 'config'), { recursive: true, filter: source => !/Singleton/.test(source) });
    await start(path.join(snapshot, 'elpis'), path.join(snapshot, 'config'));
    const list = await shown(); assert.deepEqual(gone.filter(name => list.includes(name)), []);
    assert.ok(!(await archived()).includes('Last') && !(await live()).includes('Last'), 'the deleted chat was deleted for good');
    assert.deepEqual((await agentsOf('Mother')).sort(), ['Worker one', 'Worker one child', 'Worker two']);
  });
});
