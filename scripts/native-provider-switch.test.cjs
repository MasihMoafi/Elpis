'use strict';
// One actual shared bridge, independent terminals, deterministic subscription provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message } = require('./lib/mock-provider.js');
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, label) => { const until = Date.now() + 20000; while (!f()) { assert(Date.now() < until, `timed out: ${label}`); await pause(20); } };
async function main() {
  const binary = process.argv[2];
  const gemini = process.argv.includes('--gemini');
  const model = gemini ? 'agy/gemini-3.8-flash-medium' : 'claude/haiku';
  assert(path.isAbsolute(binary), 'absolute engine path required');
  const repo = path.resolve(__dirname, '..'); const provider = new Provider(); await provider.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-shared-provider-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), other = path.join(root, 'other');
  for (const p of [home, cwd, other]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\n[features]\nmulti_agent=false\n[model_providers.fixture]\nname="offline fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const sock = path.join(root, 'bridge.sock'), log = path.join(root, 'bridge.log'), control = path.join(root, 'control.json'), calls = path.join(root, 'calls.jsonl');
  const adapter = path.join(root, 'adapter.cjs');
  const agy = path.join(root, 'agy.cjs');
  fs.writeFileSync(agy, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--input-format'))process.stdin.on('data',()=>fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'agy/prompt',args:process.argv.slice(2)})+'\\n'));process.argv.push('--agy-fixture');require(${JSON.stringify(path.resolve(path.join(repo, 'scripts'), 'permissions-bridge.test.cjs'))});\n`, { mode: 0o755 });
  fs.writeFileSync(adapter, `const fs=require('node:fs');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l)fs.appendFileSync(${JSON.stringify(calls)},l+'\\n');}});require(${JSON.stringify(path.resolve(path.join(repo, 'scripts'), 'permissions-bridge.test.cjs'))});\n`);
  const bridgeShaAtStart = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(repo,'tools/elpis-claude/acp-bridge.mjs'))).digest('hex');
  const bridge = spawn(process.execPath, [process.env.SHARED_PROVIDER_BRIDGE ?? path.resolve(path.join(repo, 'scripts'), '../tools/elpis-claude/acp-bridge.mjs')], { cwd, env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home,
    ELPIS_ENGINE_BIN: binary, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: sock, ...(gemini ? { AGY_BIN: agy } : { ELPIS_NO_AGY: '1' }),
    ACP_BRIDGE_LOG: log, ACP_ADAPTER: adapter, ACP_BRIDGE_NO_AGENTS: '1', PERMISSION_FIXTURE_ADAPTER: '1', PERMISSION_FIXTURE_CONTROL: control,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; bridge.stderr.on('data', d => { errors += d; });
  const clients = []; let serial = 0;
  const pass = text => console.log(`PASS ${text}`);
  const history = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const hold = () => { const p = { ready: path.join(root, `ready-${++serial}`), release: path.join(root, `release-${serial}`), marker: path.join(root, `marker-${serial}`) }; fs.writeFileSync(control, JSON.stringify(p)); return p; };
  async function connect(name = 'codex-tui') {
    const ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = { ws, seen: [], pending: new Map(), next: 1, approvals: [] }; clients.push(c);
    ws.on('message', data => {
      const m = JSON.parse(String(data)); c.seen.push(m);
      if (m.method && m.id !== undefined) { c.approvals.push(m); ws.send(JSON.stringify({ id: m.id, result: { decision: 'decline' } })); }
      else if (!m.method) { const p = c.pending.get(m.id); if (p) { c.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    });
    c.req = (method, params = {}) => new Promise((resolve, reject) => { const id = c.next++; const timer = setTimeout(() => { c.pending.delete(id); reject(Error(`timeout ${method}: ${errors}`)); }, 20000); c.pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
    c.event = (method, tid) => c.seen.filter(m => m.method === method && (m.params.threadId ?? m.params.thread?.id) === tid);
    await c.req('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } }); ws.send(JSON.stringify({ method: 'initialized' }));
    return c;
  }
  try {
    await wait(() => fs.existsSync(sock) || bridge.exitCode !== null, 'listener');
    assert.equal(bridge.exitCode, null, errors);
    const a = await connect();
    const checks = [];
    const {thread:native} = await a.req('thread/start', {cwd,model:'gpt-5.5',approvalPolicy:'never',permissions:':danger-full-access'});
    provider.actions.push(message('Positive native response.'));
    const {turn:nt} = await a.req('turn/start', {threadId:native.id,model:'gpt-5.5',input:[{type:'text',text:'positive native',text_elements:[]}]});
    await wait(()=>a.event('turn/completed',native.id).some(m=>m.params.turn.id===nt.id),'positive native completes');
    checks.push({name:'positive native provider',passed:provider.requests.length>0});
    const {thread} = await a.req('thread/start', {cwd,model,approvalPolicy:'never',permissions:':danger-full-access'});
    const f=hold();fs.writeFileSync(f.release,'release');
    const {turn:ct} = await a.req('turn/start',{threadId:thread.id,input:[{type:'text',text:'subscription history marker',text_elements:[]}]});
    await wait(()=>a.event('turn/completed',thread.id).some(m=>m.params.turn.id===ct.id),'initial subscription completes');
    const beforeNative=provider.requests.length,beforeACP=history().filter(m=>m.method==='session/prompt').length;
    const f2=hold();fs.writeFileSync(f2.release,'release');provider.actions.push(message('Explicit native response.'));
    const {turn:sw} = await a.req('turn/start',{threadId:thread.id,model:'gpt-5.5',input:[{type:'text',text:'explicit native route marker',text_elements:[]}]});
    await wait(()=>a.event('turn/completed',thread.id).some(m=>m.params.turn.id===sw.id),'explicit native completes');
    checks.push({name:'explicit native turn uses native provider',passed:provider.requests.length===beforeNative+1 && history().filter(m=>m.method==='session/prompt').length===beforeACP && provider.requests.at(-1).body.model==='gpt-5.5',nativeRequests:provider.requests.length-beforeNative,ACPprompts:history().filter(m=>m.method==='session/prompt').length-beforeACP});
    const settings=await a.req('thread/settings/update',{threadId:thread.id,model:'gpt-5.5'});
    const read=await a.req('thread/read',{threadId:thread.id,includeTurns:false});
    checks.push({name:'native settings clears stale model attribution',passed:read.thread?.model!==model,readModel:read.thread?.model??null,settingsModel:settings.model??settings.threadSettings?.model??null});
    const b=await connect();const resumed=await b.req('thread/resume',{threadId:thread.id,excludeTurns:true,initialTurnsPage:{limit:1,sortDirection:'desc',itemsView:'summary'}});
    checks.push({name:'new viewer does not restore stale subscription route',passed:resumed.model==='gpt-5.5',resumedModel:resumed.model,threadModel:resumed.thread?.model??null});
    const report={root,binary,checks,bridgeShaAtStart,bridgeSourceSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(repo,'tools/elpis-claude/acp-bridge.mjs'))).digest('hex')};
    fs.writeFileSync(path.join(root,'provider-requests.json'),JSON.stringify(provider.requests,null,2));
    fs.writeFileSync(path.join(root,'route-repro.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    assert(checks.every(c=>c.passed),'native switch must use requested provider and remove stale subscription attribution');
  } finally {
    for (const c of clients) { for (const p of c.pending.values()) clearTimeout(p.timer); c.ws.terminate(); }
    bridge.kill('SIGTERM');
    await Promise.race([new Promise(r => bridge.once('exit', r)), pause(5000).then(() => bridge.kill('SIGKILL'))]);
    provider.close();
    fs.writeFileSync(path.join(root, 'stderr.log'), errors); console.log(`Evidence ${root}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
