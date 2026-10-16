import { chooseOption, controlValue } from "./controls.cjs";
// Real Elpis protocol + real browser, with only inference supplied by a local fixture.
// Usage: ELPIS_PLAYWRIGHT_PACKAGE=... ELPIS_CHROMIUM=... node tests/runtime.mjs /absolute/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../bridge/server.mjs';
const require = createRequire(import.meta.url);
const { Provider, message } = require('../../../editors/vscode/test/runtime-eval.js');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'Provide an absolute Elpis executable');
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-app-runtime-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
await fs.mkdir(home); await fs.mkdir(cwd);
const checkPruner = process.argv.includes('--pruner');
if (checkPruner) await fs.writeFile(path.join(home,'pruner.json'),JSON.stringify({model:null,provider:null,system_prompt:'Preserve this user pruning prompt.'}));
const provider = new Provider(); await provider.start();
const catalog = require('../../../codex-rs/models-manager/models.json');
const model = catalog.models.find(model => model.slug === 'gpt-5.5');
assert(model);
await fs.writeFile(path.join(home, 'models.json'), JSON.stringify({ models: [model] }));
await fs.writeFile(path.join(home, 'hooks.json'), '{}');
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Local app fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
const socketPath = path.join(root, 'runtime.sock');
const child = spawn(binary, ['app-server', '--listen', `unix://${socketPath}`], { cwd,
  env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', app, browser;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const exited = once(child, 'exit');
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Runtime exited: ' + logs);
    try { await fs.stat(socketPath); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await fs.chmod(socketPath, 0o600);
  app = await startDesktopServer({ staticDir: path.join(appRoot, 'out'), socketPath: await fs.realpath(socketPath) });
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.getByText('Local workspace', { exact: true }).waitFor();
  await chooseOption(page.getByLabel('Model', { exact: true }), 'gpt-5.5');
  provider.actions.push(message('APP_REAL_PROTOCOL_REPLY_4197'));
  await page.getByLabel('Message Elpis', { exact: true }).fill('APP_INPUT_SENTINEL_4197');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('APP_REAL_PROTOCOL_REPLY_4197', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0].body.input), /APP_INPUT_SENTINEL_4197/);
  assert.equal(await controlValue(page.getByLabel('Message Elpis', { exact: true })), '');
  // A rejected request retains the draft and doesn't invent a response.
  await page.route('**/api/threads/*/turns', route => route.fulfill({ status: 503, json: { error: 'Deliberate local write failure' } }));
  await page.getByLabel('Message Elpis', { exact: true }).fill('KEEP_UNSENT_DRAFT_4197');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Deliberate local write failure' }).waitFor();
  assert.equal(await controlValue(page.getByLabel('Message Elpis', { exact: true })), 'KEEP_UNSENT_DRAFT_4197');
  assert.equal(provider.requests.length, 1);
  await page.unroute('**/api/threads/*/turns');
  // Restart just the app connection. Opening the chat rejoins it natively and keeps history and controls.
  await app.close();
  app = await startDesktopServer({ staticDir: path.join(appRoot, 'out'), socketPath: await fs.realpath(socketPath) });
  await page.goto(app.url);
  await page.locator('.thread-link').first().click();
  assert.equal(await page.getByRole('button', { name: 'Continue here', exact: true }).count(), 0);
  provider.actions.push(message('APP_RESUMED_REPLY_4197'));
  await page.getByLabel('Message Elpis', { exact: true }).fill('APP_RESUME_INPUT_4197');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('APP_RESUMED_REPLY_4197', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1].body.input), /APP_INPUT_SENTINEL_4197/);
  assert.match(JSON.stringify(provider.requests[1].body.input), /APP_RESUME_INPUT_4197/);
  // Exercise actual configuration persistence in this isolated runtime profile.
  const settings = await page.evaluate(async () => (await fetch('/api/settings')).json());
  assert.equal(settings.main.model, 'gpt-5.5');
  const changed = await page.evaluate(async version => {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, memory: { generate: false, extractionModel: 'fixture-extract', consolidationModel: 'fixture-consolidate' } }) });
    return { status: response.status, body: await response.json() };
  }, settings.version);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.memory.generate, false);
  assert.equal(changed.body.memory.extractionModel, 'fixture-extract');
  assert.equal(changed.body.memory.consolidationModel, 'fixture-consolidate');
  assert.equal(changed.body.main.model, 'gpt-5.5');
  const stale = await page.evaluate(async version => (await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, memory: { generate: true } }) })).status, settings.version);
  assert.equal(stale, 409);
  assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), /generate_memories = false/);
  const savedConfig = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  assert.match(savedConfig, /\bextract_model = "fixture-extract"/);
  assert.doesNotMatch(savedConfig, /\bextraction_model\s*=/);
  if(checkPruner){
    const initial=await page.evaluate(()=>fetch('/api/settings').then(r=>r.json()));
    assert.equal(initial.smartPrune.explicitOverride.available,true,'native pruning settings endpoint is available');
    const writePruner=body=>page.evaluate(async body=>{const response=await fetch('/api/pruner',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};},body);
    const changed=await writePruner({version:initial.smartPrune.explicitOverride.version,model:'test-pruner',provider:'fixture'});
    assert.equal(changed.status,200,JSON.stringify(changed.body));
    assert.equal(changed.body.smartPrune.explicitOverride.model,'test-pruner');
    assert.equal(changed.body.main.model,'gpt-5.5');
    const saved=JSON.parse(await fs.readFile(path.join(home,'pruner.json'),'utf8'));
    assert.deepEqual(saved,{model:'test-pruner',provider:'fixture',system_prompt:'Preserve this user pruning prompt.'});
    assert.equal((await writePruner({version:initial.smartPrune.explicitOverride.version,model:null,provider:null})).status,409);
    assert.equal((await writePruner({version:changed.body.smartPrune.explicitOverride.version,model:'other',provider:'unknown'})).status,400);
    const cleared=await writePruner({version:changed.body.smartPrune.explicitOverride.version,model:null,provider:null});
    assert.equal(cleared.status,200,JSON.stringify(cleared.body));
    assert.equal(cleared.body.smartPrune.explicitOverride.model,null);
    assert.equal(JSON.parse(await fs.readFile(path.join(home,'pruner.json'),'utf8')).system_prompt,saved.system_prompt);
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'real-protocol-chat.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'passed', root, checks: ['real thread/start', 'real turn/start', 'SSE response rendered', 'failed submission retains draft', 'app restart + opening the chat rejoins it with history', 'two submitted messages = two fixture requests', 'native settings persistence with stale-version rejection and unchanged main model',...(checkPruner?['native pruning override save/clear; stale version and unknown provider rejected; custom prompt preserved']:[])] }));
} finally {
  await browser?.close(); await app?.close(); provider.close();
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  await fs.writeFile(path.join(root, 'runtime.log'), logs);
  if (provider.error) console.error(provider.error);
}
