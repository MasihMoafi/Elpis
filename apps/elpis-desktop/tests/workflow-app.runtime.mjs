// Workflows that run until they finish (SPEC WR3, WR5), as Masih meets them: the packaged app, its own runtime and the
// real engine in a throwaway home, a local stand-in model (tools/elpis-claude/test/mock-responses.mjs, no account) and
// his settings (Subagents off, Full access). He asks for a workflow in a chat; the app then quits, or the app and its
// runtime die; the run finishes either way and its result reaches the chat. A chat archived or deleted meanwhile
// neither loses the result nor stalls the runtime.
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_TOOLS=/abs/tools/elpis-claude (the runtime under test; default this checkout's)] [ELPIS_TEST_PORT=9471] \
//   [ELPIS_TEST_SHOTS=/abs/dir] node --test --test-timeout=900000 tests/workflow-app.runtime.mjs
// The copy starts through ~/.cache/elpis-tests/e2e/app.sh (xvfb, own home, no session bus); a restart reuses its home
// (ELPIS_E2E_HOME), as the app starts again on the same machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const helper = process.env.ELPIS_E2E_APP_HELPER || path.join(os.homedir(), '.cache/elpis-tests/e2e/app.sh');
const port = process.env.ELPIS_TEST_PORT || '9471';
const fixtures = fileURLToPath(new URL('../../../tools/elpis-claude/test/', import.meta.url));
const tools = path.resolve(process.env.ELPIS_TEST_TOOLS || fileURLToPath(new URL('../../../tools/elpis-claude/', import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });

/** The engine behind the runtime under test: the app starts the runtime found beside its engine (runtime-paths.mjs). */
function stageEngine(dir) {
  fs.mkdirSync(path.join(dir, 'package/bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'tools/elpis-claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package/bin/codex'), `#!/bin/sh\nexec ${JSON.stringify(fs.realpathSync(process.env.ELPIS_TEST_ENGINE))} "$@"\n`, { mode: 0o755 });
  for (const name of fs.readdirSync(tools)) fs.symlinkSync(path.join(tools, name), path.join(dir, 'tools/elpis-claude', name));
  return path.join(dir, 'package/bin/codex');
}

const META = name => `export const meta = { name: '${name}', description: 'end-to-end ${name}', phases: [{ title: 'Work' }] }\nphase('Work')\n`;
// Each script's first agent works 12 s the first time the model sees it, long enough to quit or kill mid-run.
const SCRIPTS = Object.fromEntries(['quit', 'crash', 'archive', 'delete'].map(tag => [tag, {
  script: `${META(`app-${tag}`)}const first = await agent('${tag} slow job SLOWONCE:12000', { label: '${tag} first' })\nconst second = await agent('${tag} then ' + first, { label: '${tag} second' })\nreturn { first, second }`,
}]));
const answer = tag => `{"first":"ANSWER(${tag} slow job SLOWONCE:12000)","second":"ANSWER(${tag} then ANSWER(${tag} slow job SLOWONCE:12000))"}`;

test('a workflow asked for in the app finishes after the app quits or dies, and its result reaches the chat', { skip: !ready, timeout: 900000 }, async t => {
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const root = fs.mkdtempSync(path.join(os.homedir(), '.cache/elpis-tests/workflow-app-'));
  const shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots'), mockDir = path.join(root, 'mock'), seed = path.join(root, 'seed');
  for (const dir of [shots, mockDir, seed]) fs.mkdirSync(dir, { recursive: true });
  const engine = stageEngine(path.join(root, 'engine'));
  const mockPort = await freePort();
  fs.writeFileSync(path.join(mockDir, 'scripts.json'), JSON.stringify(SCRIPTS));
  fs.writeFileSync(path.join(seed, 'config.toml'), ['model = "gpt-5.5"', 'model_provider = "mock"', 'approvals_reviewer = "user"', 'default_permissions = ":danger-full-access"', '',
    '[features]', 'multi_agent = false', '', '[model_providers.mock]', 'name = "Mock"', `base_url = "http://127.0.0.1:${mockPort}/v1"`, 'wire_api = "responses"',
    'request_max_retries = 0', 'stream_max_retries = 0', ''].join('\n'));
  const mock = spawn(process.execPath, [path.join(fixtures, 'mock-responses.mjs'), String(mockPort), mockDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(mock.stdout, 'data');
  const asked = prompt => fs.readFileSync(path.join(mockDir, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.kind === 'agent' && r.prompt === prompt).length;

  // The copy's runtime logs here, never into the machine's shared /tmp/acp-bridge log.
  const bridgeLog = path.join(root, 'bridge.log');
  let home = null, browser = null, page = null;
  const start = async () => {
    const { stdout } = await run(helper, ['start', path.resolve(process.env.ELPIS_TEST_APP), port, ...(home ? [] : [seed])],
      { env: { ...process.env, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_LOG: bridgeLog, ...(home ? { ELPIS_E2E_HOME: home } : {}) }, timeout: 240000 });
    home = stdout.trim().split('\n').pop();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the packaged app opens its window'); page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
    await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 });
    const notNow = page.getByRole('button', { name: 'Not now', exact: true });
    await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => {});
  };
  /** Every process of the copy: its window, its runtime, the runtime's engines and tools. */
  const processes = () => fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => {
    try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`); } catch { return false; }
  }).map(pid => ({ pid: Number(pid), args: (() => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { return ''; } })() }));
  const runtimeAlive = () => processes().some(p => /acp-bridge\.mjs/.test(p.args));
  /** The person quits the app (its window and display end); the runtime it started is left alone, as on his machine. */
  const quit = async () => {
    await browser?.close().catch(() => {}); browser = null;
    const app = processes().filter(p => !/acp-bridge|shared-runtime|elpis-agents-mcp|app-server|codex/.test(p.args));
    for (const p of app) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 100 && processes().some(p => app.some(a => a.pid === p.pid)); i++) await pause(100);
    for (const p of processes().filter(p => app.some(a => a.pid === p.pid))) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
  };
  /** Everything dies at once, as at a crash or a power cut. */
  const kill = async () => {
    await browser?.close().catch(() => {}); browser = null;
    for (let i = 0; i < 50 && processes().length; i++) { for (const p of processes()) { try { process.kill(p.pid, 'SIGKILL'); } catch {} } await pause(100); }
  };
  t.after(async () => { await browser?.close().catch(() => {}); if (home) await run(helper, ['stop', home]).catch(() => {}); mock.kill('SIGKILL'); });

  const runsDir = () => path.join(home, 'elpis/workflows/runs');
  const runOf = id => JSON.parse(fs.readFileSync(path.join(runsDir(), id, 'run.json'), 'utf8'));
  const until = async (what, check, ms = 120000) => {
    for (const end = Date.now() + ms; ; await pause(250)) {
      const value = await check(); if (value) return value;
      if (Date.now() > end) { await page?.screenshot({ path: path.join(shots, `timeout-${what.replace(/\W+/g, '-').slice(0, 60)}.png`) }).catch(() => {}); assert.fail(`timed out: ${what}`); }
    }
  };
  const composer = () => page.getByLabel('Message Elpis', { exact: true });
  const transcript = () => page.locator('.chat-content');
  const currentId = () => page.evaluate(() => document.querySelector('.thread-row.active, .thread-row[aria-current="page"]')?.getAttribute('data-thread-id'));
  const row = id => page.locator(`.thread-row[data-thread-id="${id}"]`);
  /** He opens a new chat and asks for the workflow; resolves with the chat and the run the model started. */
  const ask = async tag => {
    await page.keyboard.press('Control+n'); await composer().waitFor();
    await composer().fill(`ultracode: run WF:${tag}`); await composer().press('Enter');
    const reply = await until(`the chat says the ${tag} workflow runs`, async () => { const text = await transcript().innerText().catch(() => ''); return /running in the background as (wf_[\w-]+)/.exec(text)?.[1]; });
    const chat = await until('the new chat is selected', currentId);
    assert.equal(runOf(reply).parentThreadId, chat, 'the run belongs to the chat that asked');
    return { chat, runId: reply };
  };
  const openChat = async chat => { await row(chat).locator('.thread-link').click(); };
  /** The chat shows the run's end as one step and the model's answer after it, not as a message of his. */
  const resultShown = async (tag, runId, ms) => {
    await transcript().getByText(`NOTICE RECEIVED ${runId} completed: ${answer(tag)}`, { exact: true }).waitFor({ timeout: ms });
    assert.equal(await transcript().locator('.step').filter({ hasText: `Workflow app-${tag} finished` }).count(), 1, 'the run ends as one step');
    assert.equal(await transcript().locator('.message.user').filter({ hasText: 'workflow-notification' }).count(), 0, 'no message of his shows the notice\'s tags');
  };
  const shot = async name => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await pause(300); await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
    }
  };

  await start();

  await t.test('he asks for a workflow and quits the app: the run finishes without the app, and the reopened chat shows its result', async () => {
    const { chat, runId } = await ask('quit');
    await until('the model works on the slow agent', () => asked('quit slow job SLOWONCE:12000') === 1);
    await quit();
    assert.ok(runtimeAlive(), 'the runtime outlives the app, as on his machine');
    const ended = await until('the run completes while the app is closed', () => { const r = runOf(runId); return r.status === 'completed' && r.notice?.state === 'delivered' ? r : null; }, 180000);
    assert.deepEqual(ended.result, JSON.parse(answer('quit')));
    await start();
    await openChat(chat);
    await resultShown('quit', runId, 30000);
    assert.equal(asked('quit slow job SLOWONCE:12000'), 1, 'nothing ran twice');
    await shot('quit-result');
  });

  await t.test('the app and its runtime die mid-run: when he starts the app again, the run resumes and its result arrives in the open chat', async () => {
    const { chat, runId } = await ask('crash');
    await until('the model works on the slow agent', () => asked('crash slow job SLOWONCE:12000') === 1);
    await kill();
    assert.equal(runOf(runId).status, 'running', 'the journal still says running');
    await start();
    await openChat(chat);
    // Nothing is clicked or sent: the restarted runtime resumes the run, and the result appears in the open chat.
    await resultShown('crash', runId, 180000);
    const state = runOf(runId);
    assert.equal(state.launches, 2, 'one resume after the restart');
    assert.equal(asked('crash slow job SLOWONCE:12000'), 2, 'only the unfinished agent ran again');
    assert.equal(asked('crash then ANSWER(crash slow job SLOWONCE:12000)'), 1);
    await shot('crash-result');
  });

  await t.test('the chat is archived mid-run: the run finishes, the result is kept for the chat, and the runtime does not keep retrying', async () => {
    const { chat, runId } = await ask('archive');
    await until('the model works on the slow agent', () => asked('archive slow job SLOWONCE:12000') === 1);
    await row(chat).click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Archive/ }).first().click();
    await page.waitForFunction(id => !document.querySelector(`.thread-row[data-thread-id="${id}"]`), chat);
    const ended = await until('the run completes and its notice waits for the chat', () => { const r = runOf(runId); return r.status === 'completed' && r.notice?.waiting === 'archived' ? r : null; }, 180000);
    assert.deepEqual(ended.result, JSON.parse(answer('archive')), 'its agents finished');
    assert.equal(ended.notice.state, 'pending', 'the notice is kept, not dropped');
    await pause(8000);
    const tries = fs.readFileSync(bridgeLog, 'utf8').split('\n').filter(line => line.includes(runId) && /notice/.test(line));
    assert.ok(tries.length <= 3, `the runtime does not keep retrying the notice: ${tries.slice(-3).join(' | ')}`);
    assert.equal(await row(chat).count(), 0, 'an archived chat is not brought back by the notice');
    // He brings the chat back and finds the result.
    await page.evaluate(id => fetch(`/api/threads/${id}/unarchive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), chat);
    await until('the chat is back in the list', () => row(chat).count());
    await openChat(chat);
    await resultShown('archive', runId, 60000);
    assert.equal(runOf(runId).notice.state, 'delivered');
    await shot('archive-result');
  });

  await t.test('the chat is deleted mid-run: the run finishes, its result is kept on disk, and the runtime goes quiet', async () => {
    const { chat, runId } = await ask('delete');
    await until('the model works on the slow agent', () => asked('delete slow job SLOWONCE:12000') === 1);
    await row(chat).click({ button: 'right' }); await page.getByRole('menuitem', { name: /^Delete/ }).first().click();
    const dialog = page.getByRole('alertdialog'); await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(id => !document.querySelector(`.thread-row[data-thread-id="${id}"]`), chat);
    const ended = await until('the run completes and its notice is set aside', () => { const r = runOf(runId); return r.status === 'completed' && (r.notice?.waiting || r.notice?.state === 'undeliverable') ? r : null; }, 180000);
    assert.deepEqual(ended.result, JSON.parse(answer('delete')), 'its agents finished');
    assert.notEqual(ended.notice.state, 'delivered');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runsDir(), runId, 'result.json'), 'utf8')), JSON.parse(answer('delete')), 'the result stays on disk');
    await pause(8000);
    const tries = fs.readFileSync(bridgeLog, 'utf8').split('\n').filter(line => line.includes(runId) && /notice/.test(line));
    assert.ok(tries.length <= 3, `the runtime goes quiet: ${tries.slice(-3).join(' | ')}`);
    assert.equal(await row(chat).count(), 0, 'the deleted chat stays deleted');
    const errors = (await page.locator('.error-banner[role=alert]').allInnerTexts()).filter(text => !text.startsWith('Models unavailable'));
    assert.deepEqual(errors, [], 'no error in the window');
  });
});
