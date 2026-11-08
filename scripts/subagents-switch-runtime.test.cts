// Real app-server, isolated home and an offline Responses fixture; no paid inference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { AppServer } = require('./lib/rpc.cts');

async function main() {
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), 'Pass the absolute path of the Elpis executable.');
  const cache = path.join(os.homedir(), '.cache', 'elpis-tests');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'subagents-switch-'));
  const engineHome = path.join(root, 'engine'), cwd = path.join(root, 'project');
  fs.mkdirSync(engineHome); fs.mkdirSync(cwd);
  const events = [], requests = [], spawned = new Set();
  const offeredTools = request => [
    ...(request.tools || []),
    ...(request.input || []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools || []),
  ].flatMap(tool => tool.type === 'namespace'
    ? (tool.tools || []).map(child => ({ ...child, namespace: tool.name })) : [tool]);
  const server = http.createServer(async (request, response) => {
    if (!request.url.includes('/responses')) { response.writeHead(404); response.end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const modelRequest = JSON.parse(body);
    requests.push(modelRequest);
    const id = `offline_${requests.length}`;
    let item = { type: 'message', id: `message_${requests.length}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
    const latestUser = (modelRequest.input || []).filter(entry => entry.role === 'user').at(-1);
    const fixture = JSON.stringify(latestUser || {}).match(/SPAWN_SUBAGENT_FIXTURE_(control|existing)/)?.[1];
    const spawn = offeredTools(modelRequest).find(tool => tool.name === 'spawn_agent');
    if (fixture && spawn && !spawned.has(fixture)) {
      spawned.add(fixture);
      item = { type: 'function_call', id: `spawn_${fixture}`, call_id: `spawn_${fixture}`,
        name: spawn.name, ...(spawn.namespace && { namespace: spawn.namespace }),
        arguments: JSON.stringify({ task_name: `fixture_${fixture}`, fork_turns: 'none',
          message: `CHILD_FIXTURE_${fixture}: Reply done.` }) };
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(engineHome, 'config.toml'), [
    'model = "gpt-5.6-terra"', 'model_provider = "fixture"',
    '[model_providers.fixture]', 'name = "Offline fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
    '[features]', 'multi_agent = false', '',
  ].join('\n'));
  const rpc = new AppServer(binary, cwd, { args: ['app-server', '--listen', 'stdio://'],
    env: { PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C.UTF-8', CODEX_HOME: engineHome,
      CODEX_AUTH_HOME: engineHome, ELPIS_HOME: engineHome, XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') } });
  rpc.on('disconnect', () => {});
  rpc.on('notification', event => events.push(event));
  rpc.on('request', request => rpc.respond(request.id, { decision: 'decline' }));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(predicate, label) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(25); }
    throw new Error(`Timed out waiting for ${label}.`);
  }
  function modes(threadId) {
    const directory = path.join(engineHome, 'sessions');
    if (!fs.existsSync(directory)) return [];
    const file = fs.readdirSync(directory, { recursive: true }).find(name => String(name).includes(threadId) && String(name).endsWith('.jsonl'));
    if (!file) return [];
    return fs.readFileSync(path.join(directory, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter(row => row.type === 'turn_context').map(row => row.payload.multi_agent_version);
  }
  try {
    await rpc.request('initialize', { clientInfo: { name: 'elpis_subagents_switch_test', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    const threadId = (await rpc.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
    let turnNumber = 0;
    const turn = async (threadId, expectedEnabled, text = 'Complete the offline test.') => {
      const before = modes(threadId).length, start = events.length, firstRequest = requests.length;
      const marker = `ELPIS_PARENT_TURN_${++turnNumber}_END`;
      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: `${text}\n${marker}` }] });
      const completion = await waitFor(() => events.slice(start).find(event => event.method === 'turn/completed' && event.params.threadId === threadId), 'the offline turn');
      assert.equal(completion.params.turn.status, 'completed', `offline turn failed: ${JSON.stringify(completion.params.turn.error)}`);
      const actual = await waitFor(() => { const values = modes(threadId); return values.length > before && values.at(-1); }, 'the turn context');
      assert.equal(actual !== 'disabled', expectedEnabled, `the same chat must follow the subagent switch; got ${actual}`);
      const turnRequests = requests.slice(firstRequest).filter(request => JSON.stringify(
        (request.input || []).filter(item => item.role === 'user').at(-1) || {},
      ).includes(marker));
      assert(turnRequests.length, 'the parent turn must make a provider request');
      const tools = turnRequests.flatMap(offeredTools);
      assert.equal(tools.some(tool => tool.name === 'spawn_agent'), expectedEnabled,
        `the model must see delegation only while enabled (mode ${actual}; tools ${tools.map(tool => tool.name).join(', ')})`);
    };
    const spawnFixture = async (threadId, fixture) => {
      await turn(threadId, true, `SPAWN_SUBAGENT_FIXTURE_${fixture}`);
      assert(spawned.has(fixture), 'the offline model requested the native delegation tool');
      await waitFor(() => requests.some(request => (request.input || []).some(item =>
        (item.role === 'user' || item.type === 'agent_message') && JSON.stringify(item).includes(`CHILD_FIXTURE_${fixture}`))),
      'the offline child agent to receive its task');
    };
    await turn(threadId, false);
    let checkedNewChat = false;
    for (const enabled of [true, false, true]) {
      await rpc.request('config/batchWrite', { edits: [{ keyPath: 'features.multi_agent', value: enabled, mergeStrategy: 'replace' }], reloadUserConfig: true });
      assert.equal((await rpc.request('config/read', {})).config.features.multi_agent, enabled);
      if (enabled && !checkedNewChat) {
        const control = (await rpc.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
        await turn(control, true);
        await spawnFixture(control, 'control');
        checkedNewChat = true;
        console.log('PASS: a newly opened chat sees the enabled delegation tool.');
      }
      await turn(threadId, enabled);
    }
    await spawnFixture(threadId, 'existing');
    console.log('PASS: the same chat follows the subagent switch on every turn.');
  } finally {
    const exited = rpc.child.exitCode === null ? once(rpc.child, 'exit') : Promise.resolve();
    rpc.dispose(); await exited;
    await new Promise(resolve => server.close(resolve));
    execFileSync('gio', ['trash', root], { stdio: 'ignore' });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
