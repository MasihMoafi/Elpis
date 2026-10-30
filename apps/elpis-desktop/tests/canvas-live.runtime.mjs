// The agents canvas, run once for real: the installed engine on the ChatGPT subscription (every agent and the Mother
// on gpt-6-luna), its provider bridge on a socket of this run's own, this app's bridge and the built renderer (out/),
// driven by Playwright as a user drives the packaged app. The project is a throwaway git repository under /tmp; the
// chats the run makes are archived at the end, by their ids. Nothing of an already running Elpis is touched.
// Usage: [CANVAS_LIVE_PROJECT=/tmp/<new folder at a path config.toml already trusts>] ELPIS_PLAYWRIGHT_PACKAGE=...
//   ELPIS_CHROMIUM=... node tests/canvas-live.runtime.mjs /abs/elpis-next tiny|voting|split|father|clash
// father/clash use explicit saved boards and require a new project at an already trusted /tmp path.
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
  tiny: { template: /^Sequential/, agents: 3, folders: ['page'],
    goal: 'Write one short page/page.md that explains why 2 to the power of 10 is larger than 10 to the power of 3. Keep it under 20 lines, show both values, and run a final check of the file.' },
  father: { agents: 12, folders: Array.from({ length: 12 }, (_, i) => `writers/${String(i + 1).padStart(2, '0')}`),
    goal: 'Twelve tiny independent files, one writer per folder. Each result.txt contains its writer number and the absolute working directory from pwd -P. Do not commit or edit any other files.' },
  clash: { agents: 2, folders: ['shared'],
    goal: 'Exercise a merge conflict: two independent writers replace the same line of shared/result.txt with different values. Do not resolve the conflict or commit.' },
  voting: { template: /^Voting/, agents: 4, folders: ['answer-1', 'answer-2', 'answer-3', 'tally'],
    goal: 'Question: which is larger, 2 to the power of 10 or 10 to the power of 3? Each answer is one short markdown file with the arithmetic as evidence. Keep every file under 15 lines.' },
  split: { template: /^Split by parts/, agents: null, folders: ['src', 'tests'],
    goal: 'A two-file task: write src/greet.py with greet(name) returning "Hello, <name>!", and src/shout.py with shout(text) returning the text upper-cased with "!" appended. Each part adds its own test under tests/ (plain assert, run with python3). The join runs every test.' },
};
const chosen = PLANS[plan]; assert(chosen, `Unknown plan: ${plan}`);
const custom = plan === 'father' || plan === 'clash';
const savedBoard = custom ? { name: `Live ${plan}`, maxAgents: 12, mother: { brief: chosen.goal, model: 'gpt-6-luna', provider: null }, edges: [],
  nodes: Array.from({ length: chosen.agents }, (_, i) => {
    const number = String(i + 1).padStart(2, '0'), folder = plan === 'clash' ? 'shared' : `writers/${number}`;
    const instruction = plan === 'clash' ? `Replace shared/result.txt with exactly writer-${number} followed by a newline. Leave every other file alone. Do not commit.`
      : `Write only ${folder}/result.txt, one line containing writer-${number} followed by the absolute working directory from pwd -P. Do not commit. Check its content with cat.`;
    return { id: `writer-${number}`, type: 'agent', position: { x: 260 + Math.floor(i / 6) * 270, y: (i % 6) * 130 },
      data: { title: `Writer ${number}`, instruction, model: 'gpt-6-luna', writeScopes: [folder], acceptanceCriteria: [`${folder}/result.txt contains writer-${number}`] } };
  }) } : null;
const engineDirectory = path.dirname(realpathSync(engine));
const bridgeScript = [
  ...(path.basename(engineDirectory) === 'bin' && path.basename(path.dirname(engineDirectory)) === 'package' ? [path.resolve(engineDirectory, '../../tools/elpis-claude/acp-bridge.mjs')] : []),
  path.join(engineDirectory, 'tools/elpis-claude/acp-bridge.mjs'),
].find(candidate => existsSync(candidate));
assert(bridgeScript, `No installed provider bridge for ${engine}`);
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
if (custom) assert.ok(trustedBefore, 'Set CANVAS_LIVE_PROJECT to a new, already trusted /tmp path to avoid config writes');
const evidence = process.env.CANVAS_LIVE_EVIDENCE || '/tmp/canvas-live';
await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(runtimeDir, { mode: 0o700 }); await fs.mkdir(project);
const say = line => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);

// The throwaway project: a small git repository with one folder per agent.
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Canvas live', GIT_AUTHOR_EMAIL: 'canvas@live.invalid', GIT_COMMITTER_NAME: 'Canvas live', GIT_COMMITTER_EMAIL: 'canvas@live.invalid' } });
git('init', '-q', '-b', 'main');
await fs.writeFile(path.join(project, 'README.md'), `# Canvas live check\n\n${chosen.goal}\n`);
for (const folder of chosen.folders) { await fs.mkdir(path.join(project, folder), { recursive: true }); await fs.writeFile(path.join(project, folder, 'README.md'), `The ${folder} part writes here.\n`); }
if (plan === 'clash') await fs.writeFile(path.join(project, 'shared/result.txt'), 'baseline\n');
git('add', 'README.md', ...chosen.folders.map(folder => `${folder}/README.md`), ...(plan === 'clash' ? ['shared/result.txt'] : []));
git('commit', '-q', '-m', 'Throwaway project for the canvas live check');

// The provider bridge as the packaged app starts it (shared-runtime.mjs), on this run's socket, with its own store.
const socketPath = path.join(runtimeDir, 'bridge.sock'), bridgeLog = path.join(root, 'bridge.log');
const log = await fs.open(bridgeLog, 'a');
const bridge = spawn(process.execPath, [bridgeScript], { cwd: process.env.HOME, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, 'elpis-claude', 'sessions.json'), NODE_USE_ENV_PROXY: '1' } });
const bridgeExit = once(bridge, 'exit');
const created = [], runs = [], submitted = [], worktrees = new Set();
let app, browser, page, failure;
try {
  for (let attempt = 0; ; attempt++) {
    if (bridge.exitCode !== null) throw Error(`The provider bridge exited: ${await fs.readFile(bridgeLog, 'utf8')}`);
    if (existsSync(socketPath)) break;
    if (attempt > 200) throw Error('The provider bridge did not listen within 20 s');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  app = await startDesktopServer({ staticDir: process.env.CANVAS_LIVE_RENDERER || path.join(appRoot, 'out'), socketPath });
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Every chat the run makes: the Mother's (and a Father's), and each agent's, read from the app's own requests.
  page.on('response', async response => {
    const url = new URL(response.url());
    if (response.request().method() !== 'POST' || !response.ok()) return;
    if (url.pathname === '/api/threads') created.push((await response.json()).thread.id);
    if (url.pathname === '/api/workflows/run') { runs.push(await response.json()); submitted.push(JSON.parse(response.request().postData())); }
  });
  await page.addInitScript(({ cwd, board }) => {
    if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'canvas-live', name: 'canvas-live', cwd }], selectedId: 'canvas-live' }));
    if (board) localStorage.setItem('elpis-workflow-draft-v1', JSON.stringify(board));
  }, { cwd: project, board: savedBoard });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Workflows', exact: true }); await canvas.waitFor();
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
  if (!custom) { await canvas.getByText('More patterns', { exact: true }).click(); await canvas.getByRole('button', { name: chosen.template }).click(); }
  await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
  const mother = canvas.getByRole('complementary', { name: 'Mother', exact: true });
  await mother.getByRole('textbox', { name: 'Goal', exact: true }).fill(chosen.goal);
  say(`Mother on ${await luna(mother.getByRole('combobox', { name: 'Her model', exact: true }))}`);
  if (custom) await mother.getByRole('button', { name: 'Done', exact: true }).click();
  const titles = custom ? [] : await canvas.locator('.react-flow__node-agent .agent-node-title').allInnerTexts();
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
  let last = '', tabVerified = false;
  for (;;) {
    const statusChip = canvas.locator('.canvas-header > .canvas-chip[role=status]');
    const chip = await statusChip.count() ? (await statusChip.innerText()).trim() : '';
    // An alert is a refusal; the planner's "Elpis is on it" is a status.
    const alert = canvas.locator('.canvas-notice[role=alert]');
    const notice = await alert.count() ? (await alert.innerText()).trim() : '';
    const listed = runs.length ? (await api(`/workflows?threadId=${encodeURIComponent(runs.at(-1).threadId)}`)).data.find(item => item.id === runs.at(-1).graphId) : null;
    if (runs[0] && !tabVerified) {
      await page.waitForFunction(threadId => JSON.parse(localStorage.getItem('elpis-chat-tabs-v1') || '{"tabs":[]}').tabs.some(tab => tab.threadId === threadId), runs[0].threadId);
      assert.equal(await canvas.isVisible(), true, 'starting the run keeps the Workflows board open');
      assert.equal(await canvas.getByRole('button', { name: 'New workflow', exact: true }).isEnabled(), true, 'New workflow stays usable during the run');
      tabVerified = true;
    }
    for (const row of git('worktree', 'list', '--porcelain').split('\n')) if (row.startsWith('worktree ')) worktrees.add(row.slice(9));
    const line = `${chip || 'no run yet'}${notice ? ` | notice: ${notice}` : ''}${listed ? ` | graph ${listed.status}: ${listed.tasks.map(task => `${task.id.replace(/^agent-[^-]+-/, '')}=${task.status}`).join(' ')}` : ''}`;
    if (line !== last) { say(line); last = line; }
    if (listed && ['succeeded', 'completed', 'failed', 'cancelled', 'blocked'].includes(listed.status) && /Finished/.test(chip)) break;
    if (!runs[0] && notice) throw Error(`The run did not start: ${notice}`);
    if (Date.now() - started > 40 * 60000) throw Error('The run did not finish within 40 minutes');
    await page.waitForTimeout(1000);
  }
  say(`Run took ${Math.round((Date.now() - started) / 1000)} s`);
  assert.equal(tabVerified, true, 'the real run opened its Mother chat tab');
  const graphs = [];
  for (const run of runs) graphs.push((await api(`/workflows?threadId=${encodeURIComponent(run.threadId)}`)).data.find(item => item.id === run.graphId));
  const graph = graphs.at(-1);
  await fs.writeFile(path.join(evidence, `${plan}-graphs.json`), JSON.stringify(graphs, null, 1));
  await fs.writeFile(path.join(evidence, `${plan}-runs.json`), JSON.stringify(runs, null, 1));
  await fs.writeFile(path.join(evidence, `${plan}-submitted.json`), JSON.stringify(submitted, null, 1));
  await fs.writeFile(path.join(evidence, `${plan}-worktrees.json`), JSON.stringify([...worktrees], null, 1));
  await fs.writeFile(path.join(evidence, `${plan}-graph.json`), JSON.stringify(graph, null, 1));
  const board = JSON.parse(await page.evaluate(() => localStorage.getItem('elpis-workflow-draft-v1')));
  await fs.writeFile(path.join(evidence, `${plan}-board.json`), JSON.stringify(board, null, 1));
  say(`git log:\n${git('log', '--oneline', '--all', '-12')}files:\n${git('ls-files')}`);

  // Screenshots of the finished board, 2D and 3D, light and dark, each checked by ui-fit.
  const fits = {};
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
    for (const iso of [false, true]) {
      await canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
      await canvas.getByRole('button', { name: /fit view/i }).click(); await page.waitForTimeout(500);
      const name = `${plan}-${iso ? '3d' : '2d'}-${theme}`;
      await page.screenshot({ path: path.join(evidence, `${name}.png`) });
      fits[name] = await uiFit(canvas);
    }
  }
  await fs.writeFile(path.join(evidence, `${plan}-fit.json`), JSON.stringify(fits, null, 1));
  // Read before the asserts, so that a failed run still leaves its evidence.
  for (const [name, issues] of Object.entries(fits)) assert.deepEqual(issues, [], `ui-fit ${name}`);
  if (custom) {
    for (const item of graphs) for (const task of item.tasks) assert.equal(task.model, 'gpt-6-luna');
    for (const part of submitted) {
      assert.equal(part.isolation, 'worktree');
      for (const task of part.tasks) assert.equal(task.model, 'gpt-6-luna');
    }
    if (plan === 'clash') {
      assert.equal(graph.status, 'failed');
      assert.match(await canvas.locator('.canvas-notice').innerText(), /Merge stopped:.*shared\/result.txt/);
      assert.equal(await fs.readFile(path.join(project, 'shared/result.txt'), 'utf8'), 'baseline\n', 'conflict leaves main unchanged');
    } else {
      assert.equal(graphs.length, 2, 'Mother and Father each ran a graph');
      assert.deepEqual(graphs.map(item => item.tasks.length), [20, 4]);
      const paths = [];
      for (const item of graphs) {
        assert.equal(item.status, 'succeeded', item.error ?? 'graph succeeded');
        for (const task of item.tasks) assert.equal(task.status, 'succeeded', `${task.id}: ${task.failureReason}`);
      }
      for (let i = 1; i <= 12; i++) {
        const number = String(i).padStart(2, '0');
        const content = await fs.readFile(path.join(project, `writers/${number}/result.txt`), 'utf8');
        assert.equal(git('ls-files', `writers/${number}/result.txt`).trim(), `writers/${number}/result.txt`);
        assert.match(content, new RegExp(`writer-${number} `));
        const cwd = content.trim().split(/\s+/).at(-1);
        const roots = [...worktrees].filter(root => root !== project && (cwd === root || cwd.startsWith(`${root}/`)));
        assert.equal(roots.length, 1, `working directory ${cwd} belongs to one observed worktree`); paths.push(roots[0]);
      }
      assert.equal(new Set(paths).size, 12, 'a distinct worktree per writer');
      assert.equal(git('status', '--porcelain'), '', 'the merged branch is clean');
      let items;
      for (const until = Date.now() + 60000; ;) {
        items = await api(`/threads/${encodeURIComponent(runs[0].threadId)}?limit=100`);
        if (items.thread.status.type !== 'active') break;
        assert.ok(Date.now() < until, 'the Mother finished receiving the report'); await page.waitForTimeout(1000);
      }
      await fs.writeFile(path.join(evidence, `${plan}-mother-items.json`), JSON.stringify(items, null, 1));
      assert.equal(items.thread.model, 'gpt-6-luna');
      const asked = items.data.filter(row => row.item?.type === 'userMessage').flatMap(row => row.item.content ?? []).map(item => item.text ?? '').join('\n');
      assert.ok(asked.includes(runs[1].threadId), 'the Father reports back to the Mother with his chat id');
      for (const task of graphs[1].tasks) assert.ok(asked.includes(JSON.stringify(task.result)), `${task.id} accepted result reached the Mother`);
    }
    assert.deepEqual(errors, []); say('PASS');
  } else {
  assert.equal(graph.status, 'succeeded', `graph ${graph.status}: ${graph.error ?? ''}`);
  for (const task of graph.tasks) assert.equal(task.status, 'succeeded', `${task.title}: ${task.status} ${task.failureReason ?? ''}`);
  if (chosen.agents) assert.equal(graph.tasks.length, chosen.agents * 2);
  assert.match(await canvas.locator('.canvas-header').innerText(), new RegExp(`Finished · ${graph.tasks.length / 2} of ${graph.tasks.length / 2} done`));
  // The last agent got every answer it waits for: each one's reported summary is in its first message.
  const last_ = graph.tasks.find(task => task.kind === 'implement' && task.dependsOn.length === Math.max(...graph.tasks.map(item => item.dependsOn.length)));
  const pages = [];
  for (let cursor = null, n = 0; n < 20; n++) {
    const items = await api(`/threads/${encodeURIComponent(last_.assignedThreadId)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    pages.push(...items.data); cursor = items.nextCursor; if (!cursor) break;
  }
  await fs.writeFile(path.join(evidence, `${plan}-last-agent-items.json`), JSON.stringify(pages, null, 1));
  const asked = JSON.stringify(pages.filter(row => row.item?.type === 'userMessage'));
  for (const id of last_.dependsOn) {
    const summary = graph.tasks.find(task => task.id === id).result?.summary;
    assert.ok(typeof summary === 'string' && asked.includes(JSON.stringify(JSON.stringify(summary).slice(1, -1)).slice(1, -1)), `${last_.title} did not receive ${id}'s result`);
  }
  say(`${last_.title} received ${last_.dependsOn.length} results`);
  assert.deepEqual(errors, []);
  say('PASS');
  }
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
