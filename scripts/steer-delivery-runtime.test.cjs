'use strict';
// Real native input delivery with an isolated local provider and a held Stop hook.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { Provider, message } = require('./lib/mock-provider.js');
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'Provide an absolute immutable native binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-steer-delivery-'));
const home = path.join(root, 'home'); const cwd = path.join(root, 'workspace');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const provider = new Provider(); const pending = new Map(); const protocol = []; const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const texts = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(texts).join('\n') : value && typeof value === 'object' ? Object.values(value).map(texts).join('\n') : '';
let child; let sequence = 0; let stderr = ''; let failure; let diagnosis;
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
function rpc(method, params) {
  const id = `fixture-${++sequence}`; protocol.push({ direction: 'out', id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function eventually(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (provider.error) throw provider.error;
    const value = await fn(); if (value) return value;
    if (child.exitCode !== null) throw new Error(`Native runtime exited: ${stderr}`);
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function user(text) { return [{ type: 'text', text, text_elements: [] }]; }
function completed(turnId) { return protocol.find(event => event.method === 'turn/completed' && event.params?.turn?.id === turnId); }
function finishHeldResponse(response) {
  const item = message('CONTROL_INITIAL_DONE'); const id = 'held_control_response';
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
(async () => {
  await provider.start();
  const model = require('../codex-rs/models-manager/models.json').models.find(entry => entry.slug === 'gpt-5.5'); assert(model);
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ models: [model] }));
  const hook = path.join(home, 'held-stop.py');
  fs.writeFileSync(hook, `import json, pathlib, sys, time\npayload = json.load(sys.stdin)\nbase = pathlib.Path(${JSON.stringify(root)})\nwith (base / "hook-log.jsonl").open("a") as log: log.write(json.dumps(payload) + "\\n")\nif (base / "arm").exists() and not (base / "entered").exists():\n    (base / "entered").write_text("entered")\n    until = time.monotonic() + 15\n    while not (base / "release").exists() and time.monotonic() < until: time.sleep(0.02)\nprint("{}")\n`);
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `python3 ${hook}`, statusMessage: 'Held closing-window fixture' }] }] } }));
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="never"\nsandbox_mode="workspace-write"\n[features]\nhooks=true\ncode_mode=false\nautomatic_context_pruning=false\n[memories]\ngenerate_memories=false\nuse_memories=false\n[model_providers.fixture]\nname="Local steer fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  child = spawn(binary, ['app-server'], { cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { failure = error; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let event; try { event = JSON.parse(line); } catch { stderr += line + '\n'; return; }
    protocol.push({ direction: 'in', ...event });
    const waiting = !event.method && pending.get(event.id);
    if (waiting) {
      pending.delete(event.id); clearTimeout(waiting.timer);
      if (event.error) waiting.reject(Object.assign(new Error(event.error.message), event.error)); else waiting.resolve(event.result);
    } else if (event.method && event.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: 'No approval expected in steer fixture' } }) + '\n');
    }
  });
  await rpc('initialize', { clientInfo: { name: 'steer-delivery-fixture', version: '0.1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  // Trust only this isolated profile's generated hook; no user's hooks/config are loaded.
  const threadId = (await rpc('thread/start', { cwd, model: 'gpt-5.5', modelProvider: 'fixture', config: { bypass_hook_trust: true } })).thread.id;

  provider.actions.push({ hang: true }, message('CONTROL_STEER_ANSWERED'));
  const control = (await rpc('turn/start', { threadId, input: user('CONTROL_INITIAL_9541') })).turn.id;
  await eventually(() => provider.hanging.size, 'held ordinary sampling request');
  const ordinaryAck = await rpc('turn/steer', { threadId, expectedTurnId: control, clientUserMessageId: 'control-steer-9541', input: user('CONTROL_STEER_9541') });
  assert.equal(ordinaryAck.turnId, control);
  for (const response of provider.hanging) finishHeldResponse(response);
  await eventually(() => provider.requests.some(request => texts(request.body.input).includes('CONTROL_STEER_9541')), 'ordinary steer consumed by a model request');
  await eventually(() => completed(control), 'ordinary control completed');
  pass('ordinary acknowledged steer reaches a subsequent model request');

  const before = provider.requests.length;
  fs.writeFileSync(path.join(root, 'arm'), 'armed');
  provider.actions.push(message('CLOSING_INITIAL_DONE'), message('CLOSING_STEER_ANSWERED'));
  const closing = (await rpc('turn/start', { threadId, input: user('CLOSING_INITIAL_9541') })).turn.id;
  await eventually(() => fs.existsSync(path.join(root, 'entered')), 'Stop hook entered after final response');
  const closingAck = await rpc('turn/steer', { threadId, expectedTurnId: closing, clientUserMessageId: 'closing-steer-9541', input: user('CLOSING_STEER_9541') });
  assert.equal(closingAck.turnId, closing);
  fs.writeFileSync(path.join(root, 'release'), 'released');
  await eventually(() => completed(closing), 'closing turn completed');
  // Event completion is definitive for the owned turn. Briefly allow any queued
  // automatic turn to surface so the fixture also accepts a safe follow-up turn.
  await pause(500);
  const consumed = provider.requests.slice(before).some(request => texts(request.body.input).includes('CLOSING_STEER_9541'));
  const receipt = protocol.find(event => event.method === 'item/completed' && event.params?.item?.type === 'userMessage' && event.params.item.clientId === 'closing-steer-9541');
  diagnosis = { closingAck, modelRequestsAfterInitial: provider.requests.length - before - 1, consumed, receipt: receipt?.params, completion: completed(closing)?.params };
  assert(consumed, 'Acknowledged closing-window steer was never consumed by a model request');
  pass('acknowledged closing-window steer is consumed after Stop hook release');
})().catch(error => { failure = error; process.exitCode = 1; console.error(error.stack); }).finally(async () => {
  fs.writeFileSync(path.join(root, 'release'), 'cleanup');
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ binary, checks, failure: failure?.message, diagnosis }, null, 2));
  fs.writeFileSync(path.join(root, 'protocol.json'), JSON.stringify(protocol, null, 2));
  fs.writeFileSync(path.join(root, 'provider.json'), JSON.stringify(provider.requests, null, 2));
  fs.writeFileSync(path.join(root, 'runtime.log'), stderr);
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Fixture shutdown')); } pending.clear();
  provider.close();
  if (child && child.exitCode === null) { child.stdin.end(); child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]); }
  console.log(`Evidence: ${root}`);
});
