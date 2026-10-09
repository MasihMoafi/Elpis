'use strict';
// Real app-server, isolated home, deterministic local provider; no provider credentials.
// Usage: node scripts/permissions-runtime.test.cjs /absolute/path/to/elpis [--code-mode]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppServer } = require('../editors/vscode/src/rpc');
const { Provider, message, call } = require('../editors/vscode/test/runtime-eval');
const binary = process.argv[2];
const codeMode = process.argv.includes('--code-mode');
assert(binary && path.isAbsolute(binary), 'provide the candidate binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-live-permissions-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'work');
fs.mkdirSync(home); fs.mkdirSync(cwd);
// /tmp is writable in the workspace preset. Use its explicitly protected metadata path
// so the negative case proves real sandbox enforcement, even in an isolated temp home.
const protectedDir = path.join(cwd, '.git');
fs.mkdirSync(protectedDir);
const provider = new Provider(), notifications = [], approvals = [], checks = [];
let rpc, selectedFull = false;
function notification(method) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { rpc.off('notification', receive); reject(Error(`${method} timed out`)); }, 20000);
    function receive(event) {
      if (event.method !== method) return;
      clearTimeout(timer); rpc.off('notification', receive); resolve(event.params);
    }
    rpc.on('notification', receive);
  });
}
async function select(threadId, full) {
  if (selectedFull === full) return;
  const applied = notification('thread/settings/updated');
  const profile = full === 'readOnly' ? ':read-only' : full ? ':danger-full-access' : ':workspace';
  await rpc.request('thread/settings/update', {
    threadId, permissions: profile,
    approvalPolicy: full ? 'never' : 'on-request', approvalsReviewer: 'user',
  });
  const snapshot = (await applied).threadSettings;
  assert.equal(snapshot.approvalPolicy, full ? 'never' : 'on-request');
  assert.equal(snapshot.activePermissionProfile.id, profile);
  selectedFull = full;
}
function releaseResponse(item) {
  const response = [...provider.hanging][0];
  assert(response, 'the model response must still be in flight');
  provider.hanging.delete(response);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    { type: 'response.created', response: { id: `r_${checks.length}` } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `r_${checks.length}`, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}
async function probe(threadId, { name, before, after, escalation, patch, inner, writes, prompts }) {
  await select(threadId, before);
  const marker = path.join(protectedDir, `sentinel-${checks.length}`);
  const args = {
    cmd: `printf permission-sentinel > '${marker}'`,
    sandbox_permissions: escalation ? 'require_escalated' : 'use_default',
    ...(escalation ? { justification: 'Isolated permission test write.' } : {}),
  };
  const edit = `*** Begin Patch\n*** Add File: ${marker}\n+permission-sentinel\n*** End Patch`;
  const ready = path.join(cwd, `ready-${checks.length}`), release = path.join(cwd, `release-${checks.length}`);
  const wait = inner ? `await tools.exec_command(${JSON.stringify({ cmd: `touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.05; done`, yield_time_ms: 10000 })});\n` : '';
  const item = codeMode ? { type: 'custom_tool_call', call_id: `probe_${checks.length}`, name: 'exec', input: wait + (patch ? `text(await tools.apply_patch(${JSON.stringify(edit)}));` : `text(await tools.exec_command(${JSON.stringify(args)}));`) }
    : patch ? { type: 'custom_tool_call', call_id: `probe_${checks.length}`, name: 'apply_patch', input: edit }
    : call(`probe_${checks.length}`, 'exec_command', args);
  const start = approvals.length;
  provider.actions.push(after === undefined || inner ? item : { hang: true }, message('Done.'));
  const completed = notification('turn/completed');
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Run the isolated write.' }] });
  if (after !== undefined) {
    const deadline = Date.now() + 10000;
    while (inner ? !fs.existsSync(ready) : !provider.hanging.size) {
      assert(Date.now() < deadline, 'provider request did not arrive');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await select(threadId, after);
    if (inner) fs.writeFileSync(release, 'release');
    else releaseResponse(item);
  }
  assert.equal((await completed).turn.status, 'completed', name);
  assert.equal(approvals.length - start, prompts, `${name}: approval count`);
  assert.equal(fs.existsSync(marker), writes, `${name}: actual write`);
  checks.push(name); console.log(`PASS ${name}`);
}
(async () => {
  await provider.start();
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\n[features]\ncode_mode=${codeMode}\n[model_providers.fixture]\nname="Permission fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  rpc = new AppServer(binary, cwd, { args: ['app-server'], env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home,
  } });
  rpc.on('notification', event => notifications.push(event));
  rpc.on('request', event => { approvals.push(event); rpc.respond(event.id, { decision: 'decline' }); });
  await rpc.request('initialize', { clientInfo: { name: 'permission_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  rpc.send({ method: 'initialized' });
  const { thread } = await rpc.request('thread/start', { cwd, approvalPolicy: 'on-request', permissions: ':workspace' });
  await probe(thread.id, { name: 'idle Full Access writes without approval', before: true, writes: true, prompts: 0 });
  await probe(thread.id, { name: 'idle restricted mode asks and denied write stays absent', before: false, escalation: true, writes: false, prompts: 1 });
  await probe(thread.id, { name: 'idle restricted sandbox blocks the unapproved write', before: false, writes: false, prompts: 0 });
  await probe(thread.id, { name: 'in-flight Full Access replaces stale approval and sandbox', before: false, after: true, escalation: true, writes: true, prompts: 0 });
  await probe(thread.id, { name: 'in-flight restriction revokes an unrestricted write', before: true, after: false, writes: false, prompts: 0 });
  await probe(thread.id, { name: 'in-flight restriction restores approval for escalation', before: true, after: false, escalation: true, writes: false, prompts: 1 });
  await probe(thread.id, { name: 'idle Full Access tolerates a redundant escalation', before: true, escalation: true, writes: true, prompts: 0 });
  await probe(thread.id, { name: 'read-only never policy does not grant escalation', before: true, after: 'readOnly', escalation: true, writes: false, prompts: 0 });
  await probe(thread.id, { name: 'in-flight Full Access permits a protected file edit', before: false, after: true, patch: true, writes: true, prompts: 0 });
  await probe(thread.id, { name: 'in-flight restriction restores approval for a protected edit', before: true, after: false, patch: true, writes: false, prompts: 1 });
  if (codeMode) {
    await probe(thread.id, { name: 'running code cell adopts Full Access for its next nested tool', before: false, after: true, inner: true, escalation: true, writes: true, prompts: 0 });
    await probe(thread.id, { name: 'running code cell adopts restrictions for its next nested tool', before: true, after: false, inner: true, escalation: true, writes: false, prompts: 1 });
  }
  await select(thread.id, false);
  const restored = await rpc.request('thread/resume', { threadId: thread.id });
  assert.equal(restored.approvalPolicy, 'on-request');
  checks.push('resume retains the selected restricted policy');
  await select(thread.id, true);
  const fullRestored = await rpc.request('thread/resume', { threadId: thread.id });
  assert.equal(fullRestored.approvalPolicy, 'never');
  assert.equal(fullRestored.activePermissionProfile.id, ':danger-full-access');
  assert.equal(fullRestored.sandbox.type, 'dangerFullAccess');
  checks.push('resume retains the selected Full Access policy');
  assert.equal(provider.error, undefined);
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, approvals, notifications, requests: provider.requests }, null, 2));
  console.log(`Evidence: ${root}`);
  rpc?.dispose(); if (provider.server) provider.close();
});
