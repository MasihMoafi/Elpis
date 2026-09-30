// Hidden reasoning expires from working history when its turn ends (v0.3.0
// core/src/context_cleaner.rs), against a real app-server and a loopback-only fake provider in a
// temporary Elpis home. No credentials.
// usage: node scripts/reasoning-expiry-runtime.test.cjs /absolute/path/to/binary
// The binary is the elpis multitool (run as `<binary> app-server`) or a codex-app-server build.
// Run it without network access, e.g. `unshare -rn sh -c 'ip link set lo up && node ...'`.
// Positive: turn 2's request carries none of turn 1's reasoning.
// Negative: turn 1's own follow-up request (after its tool call) still carries that reasoning,
// and the rollout on disk keeps it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {AppServer} = require('../editors/vscode/src/rpc');

const SENTINEL = 'ELPIS_REASONING_SENTINEL_4c1e7b09d2';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-reasoning-expiry-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const requests = [];
let rpc, fixtureFailure;

function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [file] : [];
  });
}

function shellCall(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const selected = tools.find(tool => tool.name === 'exec_command')
    || tools.find(tool => tool.name === 'shell_command');
  assert(selected, 'the turn-1 request did not advertise exec_command or shell_command');
  return selected.name === 'exec_command'
    ? {name:selected.name, arguments:JSON.stringify({cmd:'echo ok', yield_time_ms:10000, login:false})}
    : {name:selected.name, arguments:JSON.stringify({command:'echo ok', timeout_ms:2000, login:false})};
}

const server = http.createServer((req, res) => { void (async () => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/responses')) {res.writeHead(404); res.end(); return;}
  const body = JSON.parse(raw);
  requests.push(body);
  const id = 'resp_'+requests.length;
  // Request 1 answers with reasoning and a tool call; every later request finishes a turn.
  const output = requests.length === 1 ? [
    {type:'reasoning', id:'rs_turn1', summary:[], encrypted_content:SENTINEL},
    {type:'function_call', id:'fc_turn1', call_id:'call-turn1', ...shellCall(body)},
  ] : [{type:'message', id:'msg_'+requests.length, role:'assistant', status:'completed',
    content:[{type:'output_text', text:'Finished.', annotations:[]}]}];
  res.writeHead(200, {'content-type':'text/event-stream'});
  const events = [{type:'response.created', response:{id, status:'in_progress', output:[]}}];
  output.forEach((item, index) => events.push({type:'response.output_item.done', output_index:index, item}));
  events.push({type:'response.completed', response:{id, status:'completed', output,
    usage:{input_tokens:100, output_tokens:50, total_tokens:150}}});
  for (const event of events) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
})().catch(error => {
  fixtureFailure ||= error;
  if (!res.headersSent) res.writeHead(500);
  res.end();
}); });

async function turn(threadId, text) {
  let listener, timer;
  const done = new Promise((resolve, reject) => {
    listener = event => {
      if (event.method === 'turn/completed' && event.params.threadId === threadId) resolve(event.params);
    };
    rpc.on('notification', listener);
    timer = setTimeout(() => reject(Error('turn timed out: '+text)), 30000);
  });
  try {
    await rpc.request('turn/start', {threadId, input:[{type:'text', text}]});
    const completed = await done;
    assert.equal(completed.turn.status, 'completed', 'turn did not complete: '+text);
  } finally {
    clearTimeout(timer);
    rpc.removeListener('notification', listener);
  }
  if (fixtureFailure) throw fixtureFailure;
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model="gpt-5.5"', 'model_provider="fixture"', 'model_context_window=100000',
    '[model_providers.fixture]', 'name="Fixture"',
    `base_url="http://127.0.0.1:${server.address().port}/v1"`, 'wire_api="responses"',
    'requires_openai_auth=false',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary),
    'usage: reasoning-expiry-runtime.test.cjs /absolute/path/to/binary');
  rpc = new AppServer(binary, cwd, {
    args:path.basename(binary) === 'codex-app-server' ? [] : ['app-server'],
    // Only PATH is inherited, so neither the real home nor a proxy reaches the runtime.
    env:{PATH:process.env.PATH, HOME:home, CODEX_HOME:home, CODEX_AUTH_HOME:home, ELPIS_HOME:home}});
  rpc.child.stderr.on('data', data => fs.appendFileSync(path.join(root, 'stderr.log'), data));
  rpc.on('disconnect', () => {});
  rpc.on('request', event => rpc.respond(event.id, {decision:'decline'}));
  await rpc.request('initialize', {clientInfo:{name:'reasoning_fixture', version:'1'},
    capabilities:{experimentalApi:true}});
  rpc.send({method:'initialized'});
  const {thread} = await rpc.request('thread/start', {model:'gpt-5.5', cwd,
    approvalPolicy:'never', sandbox:'danger-full-access'});
  await rpc.request('thread/name/set', {threadId:thread.id, name:'Reasoning expiry fixture'});

  await turn(thread.id, 'Run the check.');
  assert.equal(requests.length, 2, 'turn 1 must be one tool call and one follow-up request');
  assert(JSON.stringify(requests[1].input).includes(SENTINEL),
    'negative case: reasoning was dropped inside its own turn, before the follow-up request');

  await turn(thread.id, 'Anything else?');
  assert.equal(requests.length, 3, 'turn 2 must be one request');
  assert(!JSON.stringify(requests[2].input).includes(SENTINEL),
    'positive case: turn 1 reasoning is still in the working history sent with turn 2');

  const rollouts = filesUnder(path.join(home, 'sessions'), '.jsonl');
  assert(rollouts.some(file => fs.readFileSync(file, 'utf8').includes(SENTINEL)),
    'negative case: the rollout on disk lost the reasoning');
  console.log(JSON.stringify({passed:true, root, checks:[
    'reasoning stays in its own turn\'s follow-up request',
    'reasoning is gone from the next turn\'s request',
    'the rollout keeps the reasoning',
  ]}));
})().catch(error => {console.error(error.stack); process.exitCode = 1;}).finally(() => {
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  console.log('Evidence: '+root);
  rpc?.dispose(); server.closeAllConnections(); server.close();
});
