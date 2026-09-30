// The RTK PreToolUse hook Elpis writes on first run (codex-rs/tui/src/rtk_hook.rs) rewrites a
// shell command at runtime, against a real app-server and a loopback-only fake provider in a
// temporary Elpis home. No credentials, and no real RTK: a fake `rtk` on PATH answers exactly
// as `rtk hook claude` 0.43 does (updatedInput and a reason, no permissionDecision).
// usage: node scripts/rtk-hook-runtime.test.cjs /absolute/path/to/binary
// The binary is the elpis multitool (run as `<binary> app-server`) or a codex-app-server build.
// Run it without network access, e.g. `unshare -rn sh -c 'ip link set lo up && node ...'`.
// Positive: a command RTK rewrites runs as rewritten. Negative: a command RTK leaves alone runs
// unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {AppServer} = require('../editors/vscode/src/rpc');

const RAW = 'ELPIS_RTK_RAW_OUTPUT_61d0';
const REWRITTEN = 'ELPIS_RTK_REWRITTEN_OUTPUT_93af';
const UNTOUCHED = 'ELPIS_RTK_UNTOUCHED_OUTPUT_27be';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-rtk-hook-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project'), bin = path.join(root, 'bin');
for (const directory of [home, cwd, bin]) fs.mkdirSync(directory);

// The hook definition under test is the one Elpis writes, read from its source.
const source = fs.readFileSync(path.join(__dirname, '../codex-rs/tui/src/rtk_hook.rs'), 'utf8');
const hooksJson = source.match(/const RTK_HOOKS_JSON: &str = r#"([\s\S]*?)"#;/)?.[1];
assert(hooksJson, 'RTK_HOOKS_JSON not found in codex-rs/tui/src/rtk_hook.rs');
fs.writeFileSync(path.join(home, 'hooks.json'), hooksJson);
fs.writeFileSync(path.join(bin, 'rtk'), `#!${process.execPath}
let raw = '';
process.stdin.on('data', chunk => raw += chunk).on('end', () => {
  const command = JSON.parse(raw).tool_input?.command || '';
  if (!command.includes(${JSON.stringify(RAW)})) return;
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',
    permissionDecisionReason:'RTK auto-rewrite',
    updatedInput:{command:'echo ${REWRITTEN}'}}}));
});
`, {mode:0o755});

const requests = [], notifications = [];
let rpc, command, awaitingCall = false, fixtureFailure;

function shellCall(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const selected = tools.find(tool => tool.name === 'exec_command');
  assert(selected, 'the request did not advertise exec_command');
  return {name:selected.name, arguments:JSON.stringify({cmd:command, yield_time_ms:10000, login:false})};
}

const server = http.createServer((req, res) => { void (async () => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/responses')) {res.writeHead(404); res.end(); return;}
  const body = JSON.parse(raw);
  requests.push(body);
  const id = 'resp_'+requests.length;
  // The first request of each turn asks for the command; the follow-up finishes the turn.
  const item = awaitingCall
    ? {type:'function_call', id:'fc_'+requests.length, call_id:'call-'+requests.length, ...shellCall(body)}
    : {type:'message', id:'msg_'+requests.length, role:'assistant', status:'completed',
      content:[{type:'output_text', text:'Finished.', annotations:[]}]};
  awaitingCall = false;
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const event of [
    {type:'response.created', response:{id, status:'in_progress', output:[]}},
    {type:'response.output_item.done', output_index:0, item},
    {type:'response.completed', response:{id, status:'completed', output:[item],
      usage:{input_tokens:100, output_tokens:50, total_tokens:150}}},
  ]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
})().catch(error => {
  fixtureFailure ||= error;
  if (!res.headersSent) res.writeHead(500);
  res.end();
}); });

async function runCommand(threadId, nextCommand) {
  command = nextCommand;
  awaitingCall = true;
  const start = requests.length, notificationStart = notifications.length;
  let listener, timer;
  const done = new Promise((resolve, reject) => {
    listener = event => {
      if (event.method === 'turn/completed' && event.params.threadId === threadId) resolve(event.params);
    };
    rpc.on('notification', listener);
    timer = setTimeout(() => reject(Error('turn timed out: '+nextCommand)), 30000);
  });
  try {
    await rpc.request('turn/start', {threadId, input:[{type:'text', text:'Run it.'}]});
    assert.equal((await done).turn.status, 'completed', 'turn did not complete: '+nextCommand);
  } finally {
    clearTimeout(timer);
    rpc.removeListener('notification', listener);
  }
  if (fixtureFailure) throw fixtureFailure;
  const hookRuns = notifications.slice(notificationStart)
    .filter(event => event.method === 'hook/completed').map(event => event.params.run);
  assert.equal(hookRuns.length, 1, 'the RTK hook must run once for '+nextCommand);
  assert.equal(hookRuns[0].status, 'completed',
    'the RTK hook failed for '+nextCommand+': '+JSON.stringify(hookRuns[0].entries));
  const outputs = requests.slice(start).flatMap(body => body.input)
    .filter(item => item.type === 'function_call_output');
  assert(outputs.length > 0, 'no tool output reached the provider for '+nextCommand);
  return JSON.stringify(outputs.at(-1).output);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model="gpt-5.5"', 'model_provider="fixture"', 'model_context_window=100000',
    '[model_providers.fixture]', 'name="Fixture"',
    `base_url="http://127.0.0.1:${server.address().port}/v1"`, 'wire_api="responses"',
    'requires_openai_auth=false',
  ].join('\n'));
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), 'usage: rtk-hook-runtime.test.cjs /absolute/path/to/binary');
  rpc = new AppServer(binary, cwd, {
    args:path.basename(binary) === 'codex-app-server' ? [] : ['app-server'],
    // Only PATH is inherited, with the fake rtk first.
    env:{PATH:bin+path.delimiter+process.env.PATH, HOME:home, CODEX_HOME:home,
      CODEX_AUTH_HOME:home, ELPIS_HOME:home}});
  rpc.child.stderr.on('data', data => fs.appendFileSync(path.join(root, 'stderr.log'), data));
  rpc.on('notification', event => notifications.push(event));
  rpc.on('disconnect', () => {});
  rpc.on('request', event => rpc.respond(event.id, {decision:'decline'}));
  await rpc.request('initialize', {clientInfo:{name:'rtk_fixture', version:'1'},
    capabilities:{experimentalApi:true}});
  rpc.send({method:'initialized'});
  // Hook review is the TUI's job; this run trusts the hook it was given.
  const {thread} = await rpc.request('thread/start', {model:'gpt-5.5', cwd,
    approvalPolicy:'never', sandbox:'danger-full-access', config:{bypass_hook_trust:true}});

  const rewritten = await runCommand(thread.id, 'echo '+RAW);
  assert(rewritten.includes(REWRITTEN) && !rewritten.includes(RAW),
    'positive case: RTK\'s rewrite was not applied; the tool output was '+rewritten.slice(0, 300));
  const untouched = await runCommand(thread.id, 'echo '+UNTOUCHED);
  assert(untouched.includes(UNTOUCHED) && !untouched.includes(REWRITTEN),
    'negative case: a command RTK left alone changed; the tool output was '+untouched.slice(0, 300));
  console.log(JSON.stringify({passed:true, root, checks:[
    'the command RTK rewrites runs as rewritten',
    'a command RTK leaves alone runs unchanged',
  ]}));
})().catch(error => {console.error(error.stack); process.exitCode = 1;}).finally(() => {
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(root, 'notifications.json'), JSON.stringify(notifications, null, 2));
  console.log('Evidence: '+root);
  rpc?.dispose(); server.closeAllConnections(); server.close();
});
