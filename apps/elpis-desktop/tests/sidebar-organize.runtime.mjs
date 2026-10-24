// Organization of chats in the sidebar, end to end: the packaged app, its own bridge and the real engine, in a throwaway
// home. The chat lists show only main chats; chats started by a chat or by a workflow sit folded under the chat that
// started them; the Workflows section starts folded and keeps its fold; Put under and New project from these survive a
// restart; archiving or deleting a chat takes its children. Chats are rollout fixtures, so every case is known. No inference.
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_PORT=9431] [ELPIS_TEST_SHOTS=/abs/dir] node --test tests/sidebar-organize.runtime.mjs
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
const { seedChats } = require('./seed-chats.cjs');
const run = promisify(execFile);
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const helper = process.env.ELPIS_E2E_APP_HELPER || path.join(os.homedir(), '.cache/elpis-tests/e2e/app.sh');
const port = process.env.ELPIS_TEST_PORT || '9431';
const MAINS = ['Mother', 'Plain one', 'Plain two', 'Host', 'Guest', 'Proj A', 'Proj B', 'Old host', 'Old guest'];
const CHILDREN = ['Agent one', 'Agent one child', 'Agent two', 'Legacy agent', 'Inspect code', 'Write tests'];

/** A mother with a native agent (and its agent), a chat it made with create_thread, a workflow run with two helper chats,
 * and plain chats to organize. The run is the desktop's own record of an ACP workflow, as the bridge saves it. */
async function seed(dir) {
  const ids = seedChats(dir, [
    { key: 'Mother', name: 'Mother', text: 'Plan the release', minutesAgo: 30 },
    { key: 'Agent one', name: 'Agent one', text: 'Check the tests', minutesAgo: 29, subAgentOf: 'Mother' },
    { key: 'Agent one child', name: 'Agent one child', text: 'Run one test', minutesAgo: 28, subAgentOf: 'Agent one' },
    { key: 'Agent two', name: 'Agent two', text: 'Draft the notes', minutesAgo: 27, parentKey: 'Mother' },
    { key: 'Legacy agent', name: 'Legacy agent', text: 'Summarise the log', minutesAgo: 26.5 },
    { key: 'Review team', name: 'Review team', text: 'Review the change', minutesAgo: 26 },
    { key: 'Inspect code', name: 'Workflows · Inspect code', text: 'Inspect the code', minutesAgo: 25 },
    { key: 'Write tests', name: 'Workflows · Write tests', text: 'Write the tests', minutesAgo: 24 },
    { key: 'Plain one', name: 'Plain one', text: 'Plain one', minutesAgo: 20 },
    { key: 'Plain two', name: 'Plain two', text: 'Plain two', minutesAgo: 19 },
    { key: 'Host', name: 'Host', text: 'Host', minutesAgo: 18 },
    { key: 'Guest', name: 'Guest', text: 'Guest', minutesAgo: 17 },
    { key: 'Proj A', name: 'Proj A', text: 'Proj A', minutesAgo: 16 },
    { key: 'Proj B', name: 'Proj B', text: 'Proj B', minutesAgo: 15 },
    { key: 'Old host', name: 'Old host', text: 'Old host', minutesAgo: 14 },
    { key: 'Old guest', name: 'Old guest', text: 'Old guest', minutesAgo: 13 },
  ]);
  // A chat the mother made before the desktop kept links: no record of it, only the mother's transcript naming the new
  // chat when she made it, and no user start of its own.
  const rollout = async key => { for (const file of await fs.readdir(path.join(dir, 'sessions'), { recursive: true })) if (file.endsWith(`${ids[key]}.jsonl`)) return path.join(dir, 'sessions', file); };
  const legacy = await rollout('Legacy agent'), legacyText = await fs.readFile(legacy, 'utf8');
  await fs.writeFile(legacy, legacyText.replace('"thread_source":"user",', ''));
  const made = new Date(Number.parseInt(ids['Legacy agent'].replaceAll('-', '').slice(0, 12), 16) + 3000).toISOString();
  await fs.appendFile(await rollout('Mother'), JSON.stringify({ timestamp: made, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ threadId: ids['Legacy agent'] }) } }) + '\n');
  const runId = randomUUID(), at = Date.now() - 26 * 60000;
  const task = (id, key) => ({ id, title: key, kind: 'code', instruction: key, acceptanceCriteria: ['done'], dependsOn: [], writeScopes: [], status: 'succeeded', assignedThreadId: ids[key], result: { summary: 'done' } });
  await fs.mkdir(path.join(dir, 'desktop-workflows'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'desktop-workflows', `${runId}.json`), JSON.stringify({ id: runId, rootThreadId: ids['Review team'], name: 'Review team', status: 'succeeded', startedAt: at, createdAt: at, endedAt: at + 60000, tasks: [task('inspect', 'Inspect code'), task('tests', 'Write tests')] }));
  return { ids, runId };
}

test('the sidebar lists only main chats; children sit folded under them; organizing survives a restart', { skip: !ready, timeout: 400000 }, async t => {
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidebar-organize-')), shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots');
  await fs.mkdir(shots, { recursive: true });
  const { ids } = await seed(path.join(root, 'seed')), names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
  const env = { ...process.env, ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE };
  let home, browser, page;
  const start = async (seedDir, configSeed) => {
    const { stdout } = await run(helper, ['start', path.resolve(process.env.ELPIS_TEST_APP), port, seedDir], { env: { ...env, ...(configSeed ? { ELPIS_E2E_CONFIG_SEED: configSeed } : {}) }, timeout: 240000 });
    home = stdout.trim().split('\n').pop(); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the packaged app opens its renderer'); page.setDefaultTimeout(15000);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator(`.thread-row[data-thread-id="${ids["Plain one"]}"]`).waitFor();
    // The first-run name question can come a moment after the list; it is not part of these checks.
    const notNow = page.getByRole('button', { name: 'Not now', exact: true });
    await notNow.waitFor({ timeout: 6000 }).then(() => notNow.click(), () => {});
    await page.waitForTimeout(1500); // the workflow history arrives after the chat list
  };
  const stop = async () => { await browser?.close().catch(() => {}); if (home) await run(helper, ['stop', home]).catch(() => {}); };
  t.after(stop);
  await start(path.join(root, 'seed'));
  // A failed case leaves a picture of the window behind it.
  let cases = 0;
  t.afterEach(async () => { cases++; await page?.screenshot({ path: path.join(shots, `after-case-${cases}.png`) }).catch(() => {}); });

  const aside = () => page.locator('aside.sidebar');
  const row = name => aside().locator(`.thread-row[data-thread-id="${ids[name]}"]`).first(), link = name => row(name).locator('.thread-link');
  const named = list => list.map(id => names[id] ?? id);
  const rowsIn = async locator => named(await locator.locator('.thread-row').evaluateAll(rows => rows.map(item => item.dataset.threadId)));
  const topRows = async locator => named(await locator.locator('.thread-row:not(.child)').evaluateAll(rows => rows.map(item => item.dataset.threadId)));
  const section = label => aside().locator(`section[aria-label="${label}"]`);
  const sectionToggle = label => section(label).locator('.section-toggle').first();
  /** Every row any chat list draws: Projects, Pinned, Groups and Recents. */
  const chatLists = async () => [...await rowsIn(section('Projects')), ...await rowsIn(section('Pinned')), ...await rowsIn(section('Groups')), ...await rowsIn(section('Recents'))];
  const listed = async (query = '') => named(await page.evaluate(async q => { const all = []; let cursor; do { const page = await (await fetch(`/api/threads?limit=100${q}${cursor ? `&cursor=${cursor}` : ''}`)).json(); all.push(...page.data.map(item => item.id)); cursor = page.nextCursor; } while (cursor); return all; }, query));
  const archived = () => listed('&archived=true');
  const banners = async () => (await page.locator('.error-banner[role=alert], [role=alert]').allInnerTexts()).map(text => text.trim()).filter(text => text && !text.startsWith('Models unavailable'));
  const noError = async label => assert.deepEqual(await banners(), [], `${label}: no error`);
  const settle = async () => { for (let i = 0; i < 3 && await page.locator('[role=alertdialog], [role=dialog], [role=menu]').count(); i++) await page.keyboard.press('Escape'); };
  const action = async (name, label) => { await row(name).click({ button: 'right' }); await page.getByRole('menuitem', { name: label, exact: true }).click(); };
  const eventually = async (check, ms = 10000) => { const end = Date.now() + ms; for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await page.waitForTimeout(250); } } };
  const shoot = async name => {
    for (const theme of ['light', 'dark']) {
      const button = page.getByRole('button', { name: `Use ${theme} theme`, exact: true });
      if (await button.count()) await button.first().click();
      await page.waitForTimeout(1200); const box = await aside().boundingBox();
      await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`), clip: { x: 0, y: 0, width: Math.ceil(box.x + box.width) + 40, height: Math.ceil(box.height) } });
    }
  };

  await t.test('the chat lists show only main chats: no agent, created chat or workflow helper', async () => {
    const lists = await chatLists();
    assert.deepEqual(CHILDREN.filter(name => lists.includes(name)), [], 'no child is listed');
    assert.deepEqual(MAINS.filter(name => !lists.includes(name)), [], 'every main chat is listed');
    assert.deepEqual([...new Set(lists)].length, lists.length, 'no chat is listed twice');
    assert.equal(await aside().locator('[aria-label="Agents whose parent is not listed"]').count(), 0, 'no list of orphan agents');
    await shoot('on-start');
  });

  await t.test('the Workflows section is there and starts folded; its run hides its helper chats', async () => {
    await section('Workflows').waitFor();
    assert.equal(await sectionToggle('Workflows').getAttribute('aria-expanded'), 'false', 'Workflows starts folded');
    assert.deepEqual(await rowsIn(section('Workflows')), [], 'nothing of it shows while folded');
    await sectionToggle('Workflows').click();
    await eventually(async () => assert.deepEqual(await rowsIn(section('Workflows')), ['Review team']), 5000);
    const expand = section('Workflows').getByRole('button', { name: /^Expand .* in Review team$/ });
    await expand.click();
    await eventually(async () => assert.deepEqual((await rowsIn(section('Workflows'))).sort(), ['Inspect code', 'Review team', 'Write tests']));
    await shoot('workflow-open');
    await page.waitForTimeout(6000); // the sidebar follows an expanded branch every five seconds
    await noError('expanded workflow run');
    await section('Workflows').getByRole('button', { name: /^Collapse .* in Review team$/ }).click();
    await sectionToggle('Workflows').click();
    assert.equal(await sectionToggle('Workflows').getAttribute('aria-expanded'), 'false');
  });

  await t.test('a mother starts folded, also when opened; her agents and their agents are one click away', async () => {
    await link('Mother').click(); await page.waitForTimeout(1500);
    const expand = row('Mother').getByRole('button', { name: /^(Expand|Collapse) agents in Mother$/ });
    assert.equal(await expand.getAttribute('aria-expanded'), 'false', 'opening the mother leaves her folded');
    assert.equal(await row('Agent two').count(), 0);
    await expand.click();
    await row('Agent two').waitFor(); await row('Agent one').waitFor(); await row('Legacy agent').waitFor();
    await row('Agent one').getByRole('button', { name: /^Expand agents in / }).click();
    await row('Agent one child').waitFor();
    await shoot('mother-open');
    await row('Mother').getByRole('button', { name: 'Collapse agents in Mother', exact: true }).click();
    await eventually(async () => assert.equal(await row('Agent two').count(), 0));
    await noError('mother branches');
  });

  await t.test('search finds a child chat by name, in one flat list of results', async () => {
    await page.getByLabel('Search conversations', { exact: true }).fill('Agent two');
    await eventually(async () => assert.ok((await rowsIn(section('Results'))).includes('Agent two')));
    await page.getByLabel('Search conversations', { exact: true }).fill('');
    await row('Mother').waitFor();
  });

  await t.test('Put under nests a chat under another and leaves the list', async () => {
    await settle(); await action('Guest', 'Put under…');
    await page.getByRole('combobox', { name: 'Parent chat' }).click(); await page.getByRole('option', { name: 'Host', exact: true }).click();
    await page.getByRole('button', { name: 'Put under', exact: true }).click();
    await eventually(async () => assert.ok(!(await topRows(section('Recents'))).includes('Guest')));
    await noError('put under');
  });

  await t.test('New project from these makes a project of two chats in Recents', async () => {
    await settle(); await link('Proj A').click(); await link('Proj B').click({ modifiers: ['Control'] });
    await action('Proj B', 'New project from these…');
    const dialog = page.getByRole('alertdialog', { name: 'New project', exact: true });
    await dialog.getByLabel('Project name', { exact: true }).fill('Launch');
    await dialog.getByRole('combobox', { name: 'Working folder', exact: true }).click();
    await page.getByRole('option').filter({ hasText: '/work' }).first().click();
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
    const launch = section('Projects').getByRole('group', { name: 'Launch', exact: true });
    await eventually(async () => assert.deepEqual((await rowsIn(launch)).sort(), ['Proj A', 'Proj B']));
    assert.deepEqual((await rowsIn(section('Recents'))).filter(name => name.startsWith('Proj')), []);
    await noError('new project');
  });

  await t.test('archiving the mother takes her agents and the chat she made; deleting a chat takes the chat put under it', async () => {
    await settle(); await row('Mother').hover(); await page.getByRole('button', { name: 'Archive Mother', exact: true }).click();
    await eventually(async () => assert.equal(await row('Mother').count(), 0));
    await eventually(async () => { const list = await archived(); for (const name of ['Mother', 'Agent two', 'Legacy agent']) assert.ok(list.includes(name), `${name} is archived`); });
    assert.deepEqual((await listed()).filter(name => ['Mother', 'Agent two', 'Legacy agent'].includes(name)), [], 'nothing of the mother stays live');
    await action('Old guest', 'Put under…');
    await page.getByRole('combobox', { name: 'Parent chat' }).click(); await page.getByRole('option', { name: 'Old host', exact: true }).click();
    await page.getByRole('button', { name: 'Put under', exact: true }).click();
    await eventually(async () => assert.ok(!(await topRows(section('Recents'))).includes('Old guest')));
    await row('Old host').click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Delete/ }).click();
    const dialog = page.getByRole('alertdialog'); await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
    await eventually(async () => { assert.equal(await row('Old host').count(), 0); assert.equal(await row('Old guest').count(), 0); });
    await page.waitForTimeout(1500);
    assert.deepEqual((await listed()).filter(name => ['Old host', 'Old guest'].includes(name)), [], 'the nested chat went with its host');
    await noError('archive and delete');
  });
  await shoot('organized');

  await t.test('after a restart: the project, the nested chat and the folded Workflows section are as they were left', async () => {
    await browser.close(); const old = home; await run(helper, ['stop', old]); await new Promise(resolve => setTimeout(resolve, 4000));
    const snapshot = path.join(root, 'restart'); await fs.mkdir(snapshot);
    await fs.cp(path.join(old, 'elpis'), path.join(snapshot, 'elpis'), { recursive: true, filter: source => !/app-server-control|thread-writer-locks/.test(source) });
    await fs.cp(path.join(old, '.config'), path.join(snapshot, 'config'), { recursive: true, filter: source => !/Singleton/.test(source) });
    // The requests log of the first run, before the copy is reused.
    const log = await fs.readFile(path.join(old, 'elpis/logs/desktop-requests.jsonl'), 'utf8').catch(() => '');
    assert.equal(log.trim(), '', `no failed request in the first run: ${log.slice(0, 400)}`);
    await start(path.join(snapshot, 'elpis'), path.join(snapshot, 'config'));
    const launch = section('Projects').getByRole('group', { name: 'Launch', exact: true });
    await eventually(async () => assert.deepEqual((await rowsIn(launch)).sort(), ['Proj A', 'Proj B']));
    assert.ok(!(await topRows(section('Recents'))).includes('Guest'), 'Guest stays under Host');
    await row('Host').getByRole('button', { name: 'Expand chats in Host', exact: true }).click(); await row('Guest').waitFor();
    assert.equal(await sectionToggle('Workflows').getAttribute('aria-expanded'), 'false', 'Workflows stays folded');
    await sectionToggle('Workflows').click();
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await row('Plain one').waitFor();
    await eventually(async () => assert.equal(await sectionToggle('Workflows').getAttribute('aria-expanded'), 'true', 'an opened Workflows section stays open'));
    await sectionToggle('Workflows').click();
    const lists = await chatLists();
    assert.deepEqual(CHILDREN.filter(name => lists.includes(name)), [], 'still no child listed');
    assert.deepEqual(['Mother', 'Agent two', 'Old host', 'Old guest'].filter(name => lists.includes(name)), [], 'archived and deleted chats stay gone');
    await noError('after restart');
    const after = await fs.readFile(path.join(home, 'elpis/logs/desktop-requests.jsonl'), 'utf8').catch(() => '');
    assert.equal(after.trim(), '', `no failed request after the restart: ${after.slice(0, 400)}`);
  });

});
