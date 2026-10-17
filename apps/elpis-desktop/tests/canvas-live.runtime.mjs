// The agents canvas, run once for real: the installed engine on the ChatGPT subscription (every agent and the Mother
// on gpt-6-luna), its provider bridge on a socket of this run's own, this app's bridge and the built renderer (out/),
// driven by Playwright as a user drives the packaged app. The project is a throwaway git repository under /tmp; the
// chats the run makes are archived at the end, by their ids. Nothing of an already running Elpis is touched.
// Usage: [CANVAS_LIVE_PROJECT=/tmp/<new folder at a path config.toml already trusts>] ELPIS_PLAYWRIGHT_PACKAGE=...
//   ELPIS_CHROMIUM=... node tests/canvas-live.runtime.mjs /abs/elpis-next voting|split
// Screenshots, the graph, the board and the archived ids go to /tmp/canvas-live (CANVAS_LIVE_EVIDENCE).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../bridge/server.mjs';
const require = createRequire(import.meta.url);
const { chooseTheme } = require('./controls.cjs');
const { uiFit } = require('./ui-fit.cjs');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const [engine, plan = 'voting'] = process.argv.slice(2);
assert(engine && path.isAbsolute(engine), 'Provide the absolute path of the installed Elpis engine');
const PLANS = {
  voting: { template: /^Voting/, agents: 4, folders: ['answer-1', 'answer-2', 'answer-3', 'tally'],
    goal: 'Question: which is larger, 2 to the power of 10 or 10 to the power of 3? Each answer is one short markdown file with the arithmetic as evidence. Keep every file under 15 lines.' },
  split: { template: /^Split by parts/, agents: null, folders: ['src', 'tests'],
    goal: 'A two-file task: write src/greet.py with greet(name) returning "Hello, <name>!", and src/shout.py with shout(text) returning the text upper-cased with "!" appended. Each part adds its own test under tests/ (plain assert, run with python3). The join runs every test.' },
};
const chosen = PLANS[plan]; assert(chosen, `Plan is voting or split, not ${plan}`);
const bridgeScript = path.join(path.dirname(realpathSync(engine)), 'tools', 'elpis-claude', 'acp-bridge.mjs');
assert(existsSync(bridgeScript), `No provider bridge beside ${engine}`);
const appRoot = fileURLToPath(new URL('..', import.meta.url));
// A short root: the engine's socket lives under it and a Unix socket path has 108 bytes.
const root = await fs.mkdtemp('/tmp/cl-'), runtimeDir = path.join(root, 'rt');
// A chat started in a folder the engine does not trust yet makes it write that folder's trust into the user's
// config.toml. CANVAS_LIVE_PROJECT names a new folder at a path already trusted there, so nothing is written.
const project = process.env.CANVAS_LIVE_PROJECT || path.join(root, 'project');
assert(path.isAbsolute(project) && project.startsWith('/tmp/'), 'The project must be a new folder under /tmp');
for (const taken of [project, `${project}-elpis`]) assert(!existsSync(taken), `${taken} already exists`);
const userConfig = path.join(process.env.ELPIS_HOME || path.join(process.env.HOME, '.elpis-next'), 'config.toml');
const trusted = async () => (await fs.readFile(userConfig, 'utf8').catch(() => '')).includes(`[projects.${JSON.stringify(project)}]`);
const trustedBefore = await trusted();
const evidence = process.env.CANVAS_LIVE_EVIDENCE || '/tmp/canvas-live';
await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(runtimeDir, { mode: 0o700 }); await fs.mkdir(project);
const say = line => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);

// The throwaway project: a small git repository with one folder per agent.
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Canvas live', GIT_AUTHOR_EMAIL: 'canvas@live.invalid', GIT_COMMITTER_NAME: 'Canvas live', GIT_COMMITTER_EMAIL: 'canvas@live.invalid' } });
git('init', '-q', '-b', 'main');
await fs.writeFile(path.join(project, 'README.md'), `# Canvas live check\n\n${chosen.goal}\n`);
for (const folder of chosen.folders) { await fs.mkdir(path.join(project, folder)); await fs.writeFile(path.join(project, folder, 'README.md'), `The ${folder} part writes here.\n`); }
git('add', '.'); git('commit', '-q', '-m', 'Throwaway project for the canvas live check');

// The provider bridge as the packaged app starts it (shared-runtime.mjs), on this run's socket, with its own store.
const socketPath = path.join(runtimeDir, 'bridge.sock'), bridgeLog = path.join(root, 'bridge.log');
const log = await fs.open(bridgeLog, 'a');
const bridge = spawn(process.execPath, [bridgeScript], { cwd: process.env.HOME, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, 'elpis-claude', 'sessions.json'), NODE_USE_ENV_PROXY: '1' } });
const bridgeExit = once(bridge, 'exit');
const created = [], runs = [];
let app, browser, page, failure;
try {
  for (let attempt = 0; ; attempt++) {
    if (bridge.exitCode !== null) throw Error(`The provider bridge exited: ${await fs.readFile(bridgeLog, 'utf8')}`);
    if (existsSync(socketPath)) break;
    if (attempt > 200) throw Error('The provider bridge did not listen within 20 s');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  app = await startDesktopServer({ staticDir: path.join(appRoot, 'out'), socketPath });
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Every chat the run makes: the Mother's (and a Father's), and each agent's, read from the app's own requests.
  page.on('response', async response => {
    const url = new URL(response.url());
    if (response.request().method() !== 'POST' || !response.ok()) return;
    if (url.pathname === '/api/threads') created.push((await response.json()).thread.id);
    if (url.pathname === '/api/workflows/run') runs.push(await response.json());
  });
  await page.addInitScript(cwd => {
    if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'canvas-live', name: 'canvas-live', cwd }], selectedId: 'canvas-live' }));
  }, project);
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Agents canvas', exact: true }); await canvas.waitFor();
  const api = (pathname, body) => page.evaluate(async ([pathname, body]) => {
    const response = await fetch(`/api${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw Error(value.error || response.status); return value;
  }, [pathname, body]);
  /** Opens a model menu and picks gpt-6-luna on the ChatGPT subscription, as a user does. */
  const luna = async combobox => {
    await combobox.click();
    const option = page.getByRole('option').and(page.locator('[data-value$="|gpt-6-luna"]')).first();
    await option.waitFor().catch(async error => { throw Error(`No gpt-6-luna to pick; the menu offers ${(await page.getByRole('option').evaluateAll(items => items.map(item => item.dataset.value))).join(', ')}: ${error.message.split('\n')[0]}`); });
    const value = await option.getAttribute('data-value'); await option.click();
    assert.equal(await combobox.getAttribute('data-value'), value); return value;
  };

  say(`engine models: ${(await api('/models')).data.map(model => model.model).join(', ')}`);
  await canvas.getByRole('button', { name: chosen.template }).click();
  await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
  const mother = canvas.getByRole('complementary', { name: 'Mother', exact: true });
  await mother.getByRole('textbox', { name: 'Goal', exact: true }).fill(chosen.goal);
  say(`Mother on ${await luna(mother.getByRole('combobox', { name: 'Her model', exact: true }))}`);
  const titles = await canvas.locator('.react-flow__node-agent .agent-node-title').allInnerTexts();
  for (const title of titles) {
    await canvas.locator('.react-flow__node-agent').filter({ has: page.locator('.agent-node-title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).click();
    const panel = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    say(`${title} on ${await luna(panel.getByRole('combobox', { name: 'Model', exact: true }))}`);
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await page.screenshot({ path: path.join(evidence, `${plan}-before.png`) });
  const started = Date.now();
  await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
  // The planner fills the empty folders first; then the run starts and the header follows it.
  let last = '';
  for (;;) {
    const chip = (await canvas.locator('.canvas-header [role=status]').innerText().catch(() => '')).trim();
    // An alert is a refusal; the planner's "Elpis is on it" is a status.
    const notice = (await canvas.locator('.canvas-notice[role=alert]').innerText().catch(() => '')).trim();
    const listed = runs[0] ? (await api(`/workflows?threadId=${encodeURIComponent(runs[0].threadId)}`)).data.find(item => item.id === runs[0].graphId) : null;
    const line = `${chip || 'no run yet'}${notice ? ` | notice: ${notice}` : ''}${listed ? ` | graph ${listed.status}: ${listed.tasks.map(task => `${task.id.replace(/^agent-[^-]+-/, '')}=${task.status}`).join(' ')}` : ''}`;
    if (line !== last) { say(line); last = line; }
    if (listed && ['succeeded', 'completed', 'failed', 'cancelled', 'blocked'].includes(listed.status) && /Finished/.test(chip)) break;
    if (!runs[0] && notice) throw Error(`The run did not start: ${notice}`);
    if (Date.now() - started > 40 * 60000) throw Error('The run did not finish within 40 minutes');
    await page.waitForTimeout(5000);
  }
  say(`Run took ${Math.round((Date.now() - started) / 1000)} s`);
  const graph = (await api(`/workflows?threadId=${encodeURIComponent(runs[0].threadId)}`)).data.find(item => item.id === runs[0].graphId);
  await fs.writeFile(path.join(evidence, `${plan}-graph.json`), JSON.stringify(graph, null, 1));
  const board = JSON.parse(await page.evaluate(() => localStorage.getItem('elpis-workflow-draft-v1')));
  await fs.writeFile(path.join(evidence, `${plan}-board.json`), JSON.stringify(board, null, 1));
  say(`git log:\n${git('log', '--oneline', '--all', '-12')}files:\n${git('ls-files')}`);

  // Screenshots of the finished board, 2D and 3D, light and dark, each checked by ui-fit.
  const fits = {};
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
    for (const iso of [false, true]) {
      await canvas.getByRole('button', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
      await canvas.getByRole('button', { name: /fit view/i }).click(); await page.waitForTimeout(500);
      const name = `${plan}-${iso ? '3d' : '2d'}-${theme}`;
      await page.screenshot({ path: path.join(evidence, `${name}.png`) });
      fits[name] = await uiFit(canvas);
    }
  }
  await fs.writeFile(path.join(evidence, `${plan}-fit.json`), JSON.stringify(fits, null, 1));
  // Read before the asserts, so that a failed run still leaves its evidence.
  for (const [name, issues] of Object.entries(fits)) assert.deepEqual(issues, [], `ui-fit ${name}`);
  assert.equal(graph.status, 'succeeded', `graph ${graph.status}: ${graph.error ?? ''}`);
  for (const task of graph.tasks) assert.equal(task.status, 'succeeded', `${task.title}: ${task.status} ${task.failureReason ?? ''}`);
  if (chosen.agents) assert.equal(graph.tasks.length, chosen.agents * 2);
  assert.match(await canvas.locator('.canvas-header').innerText(), new RegExp(`Finished · ${graph.tasks.length / 2} of ${graph.tasks.length / 2} done`));
  // The last agent got every answer it waits for: each one's reported summary is in its first message.
  const last_ = graph.tasks.find(task => task.kind === 'implement' && task.dependencies.length === Math.max(...graph.tasks.map(item => item.dependencies.length)));
  const pages = [];
  for (let cursor = null, n = 0; n < 20; n++) {
    const items = await api(`/threads/${encodeURIComponent(last_.assignedThreadId)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    pages.push(...items.data); cursor = items.nextCursor; if (!cursor) break;
  }
  await fs.writeFile(path.join(evidence, `${plan}-last-agent-items.json`), JSON.stringify(pages, null, 1));
  const asked = JSON.stringify(pages.filter(row => row.item?.type === 'userMessage'));
  for (const id of last_.dependencies) {
    const summary = graph.tasks.find(task => task.id === id).result?.summary;
    assert.ok(typeof summary === 'string' && asked.includes(JSON.stringify(JSON.stringify(summary).slice(1, -1)).slice(1, -1)), `${last_.title} did not receive ${id}'s result`);
  }
  say(`${last_.title} received ${last_.dependencies.length} results`);
  assert.deepEqual(errors, []);
  say('PASS');
} catch (error) { failure = error; say(`FAIL ${error.stack}`); }
finally {
  // Archive this run's chats, by their ids: the run chats, and every agent under them (a failed task no longer names
  // its chat in workGraph/list, so they are read as the run chats' descendants). CANVAS_LIVE_ARCHIVE adds ids an
  // interrupted earlier run left behind.
  const ids = [...created, ...(process.env.CANVAS_LIVE_ARCHIVE ?? '').split(',').filter(Boolean)];
  try {
    for (const id of created) {
      const listed = await page.evaluate(async id => (await (await fetch(`/api/threads?ancestorThreadId=${encodeURIComponent(id)}&limit=100`)).json()), id).catch(() => ({ data: [] }));
      for (const thread of listed.data ?? []) if (!ids.includes(thread.id)) ids.push(thread.id);
    }
    for (const run of runs) {
      const listed = await page.evaluate(async id => (await (await fetch(`/api/workflows?threadId=${encodeURIComponent(id)}`)).json()), run.threadId).catch(() => ({ data: [] }));
      for (const item of listed.data ?? []) for (const task of item.tasks) if (task.assignedThreadId && !ids.includes(task.assignedThreadId)) ids.push(task.assignedThreadId);
    }
    const archived = [];
    for (const id of ids) {
      const ok = await page.evaluate(async id => (await fetch(`/api/threads/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, id).catch(error => String(error));
      archived.push({ id, status: ok });
    }
    await fs.writeFile(path.join(evidence, `${plan}-archived.json`), JSON.stringify(archived, null, 1));
    say(`archived: ${archived.map(item => `${item.id} (${item.status})`).join(', ')}`);
  } catch (error) { say(`archiving failed: ${error.message}; chats ${ids.join(', ')}`); }
  await browser?.close(); await app?.close();
  bridge.kill('SIGTERM'); await Promise.race([bridgeExit, new Promise(resolve => setTimeout(resolve, 15000))]); await log.close();
  if (!trustedBefore && await trusted()) say(`WARNING: the engine wrote [projects.${JSON.stringify(project)}] into ${userConfig}; remove that entry`);
  say(`project ${project}; bridge log ${bridgeLog}; evidence ${evidence}`);
  process.exitCode = failure ? 1 : 0;
}
