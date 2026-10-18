// Explicit live acceptance check. Uses a disposable ELPIS_HOME and only the ChatGPT gpt-6-luna subscription.
// ELPIS_PLAYWRIGHT_PACKAGE=... ELPIS_CHROMIUM=... node tests/experiment-lab.runtime.mjs /abs/elpis-next /abs/evidence-dir
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../bridge/server.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseOption } = require('./controls.cjs');
const [engine, evidence] = process.argv.slice(2);
assert(engine && evidence && path.isAbsolute(engine) && path.isAbsolute(evidence), 'Give an absolute engine path and evidence directory');
const bridgeScript = path.join(path.dirname(realpathSync(engine)), 'tools/elpis-claude/acp-bridge.mjs');
assert(existsSync(bridgeScript));
const cache = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
const profile = await fs.mkdtemp(path.join(cache, 'provenance-')), runtime = path.join(profile, 'runtime'); await fs.mkdir(runtime);
const work = path.join(profile, 'work'); await fs.mkdir(work); await fs.mkdir(evidence, { recursive: true });
await fs.copyFile(path.join(process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'), 'auth.json'), path.join(profile, 'auth.json'));
await fs.chmod(path.join(profile, 'auth.json'), 0o600);
await fs.writeFile(path.join(profile, 'config.toml'), 'model = "gpt-6-luna"\nmodel_provider = "openai"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n');
process.env.ELPIS_HOME = profile;
const socketPath = path.join(runtime, 'bridge.sock'), log = await fs.open(path.join(runtime, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [bridgeScript], { cwd: work, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(profile, 'provider/sessions.json'), NODE_USE_ENV_PROXY: '1' } });
const exited = new Promise(resolve => bridge.once('exit', resolve));
let app, browser;
try {
  for (let i = 0; !existsSync(socketPath); i++) {
    assert.equal(bridge.exitCode, null, 'Disposable bridge exited'); assert.ok(i < 200, 'Disposable bridge did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  app = await startDesktopServer({ staticDir: fileURLToPath(new URL('../out/', import.meta.url)), socketPath, elpisHome: profile, trashFile: path.join(profile, 'trash.json') });
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1130, height: 660 } }); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(cwd => { localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'lab', name: 'Lab check', cwd }], selectedId: 'lab' })); }, work);
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByRole('button', { name: 'Experiment Lab', exact: true }).click();
  const lab = page.getByRole('region', { name: 'Experiment Lab', exact: true });
  await chooseOption(lab.getByRole('combobox', { name: 'Pattern', exact: true }), 'evaluator-optimizer');
  await lab.getByRole('textbox', { name: 'Task', exact: true }).fill('What is 19 + 23? Return only the integer.');
  await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).fill('42');
  await lab.getByRole('spinbutton', { name: 'Repetitions', exact: true }).fill('2');
  await lab.getByRole('button', { name: 'Run comparison', exact: true }).click();
  let record;
  for (let i = 0; i < 480; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    record = await page.evaluate(async () => (await (await fetch('/api/experiment-lab')).json()).record);
    if (record && record.status !== 'running') break;
  }
  assert.ok(record, 'No experiment record');
  await fs.writeFile(path.join(evidence, 'live.json'), JSON.stringify(record, null, 2));
  assert.equal(record.status, 'completed'); assert.equal(record.trials.length, 4);
  assert.ok(record.trials.every(trial => trial.passed), record.trials.map(t => t.error || t.answer).join('; '));
  assert.ok(record.trials.every(trial => trial.tokens > 0), 'Every live trial must have real token usage');
  assert.equal(record.model, 'gpt-6-luna');
  assert.deepEqual(errors, []);
  await lab.getByRole('status').filter({ hasText: 'Completed' }).waitFor();
  await lab.getByRole('table', { name: 'Comparison', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'live.png') });
  await page.reload(); await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByRole('button', { name: 'Experiment Lab', exact: true }).click();
  await page.getByRole('table', { name: 'Comparison', exact: true }).waitFor();
  console.log(JSON.stringify({ trials: record.trials.length, passed: record.trials.filter(t => t.passed).length, calls: record.trials.reduce((n, t) => n + t.steps.length, 0), tokens: record.trials.reduce((n, t) => n + t.tokens, 0), evidence }));
} finally {
  await browser?.close(); await app?.close();
  bridge.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (bridge.exitCode === null && bridge.signalCode === null) { bridge.kill('SIGKILL'); await exited; }
  await log.close(); execFileSync('gio', ['trash', profile]);
}
