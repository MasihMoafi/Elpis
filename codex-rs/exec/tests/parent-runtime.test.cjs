const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { AppServer } = require('../../../scripts/lib/rpc.js');
const { Provider, message } = require('../../../scripts/lib/mock-provider.js');

const binary = path.resolve(process.env.ELPIS_PARENT_TEST_BINARY || 'codex-rs/target/dev-small/codex');

async function fixture(t, config = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-exec-parent-'));
  const provider = new Provider();
  await provider.start();
  t.after(() => provider.close());
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.2-codex"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${provider.url}"\nwire_api="responses"\nrequires_openai_auth=false\n${config}`);
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
  const env = { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home, CODEX_AUTH_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state') };
  async function connect() {
    const rpc = new AppServer(binary, home, { args: ['app-server'], env });
    rpc.on('disconnect', () => {});
    await rpc.request('initialize', { clientInfo: { name: 'exec_parent_test', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized' });
    return rpc;
  }
  let rpc = await connect();
  t.after(() => rpc.dispose());
  async function restart() {
    const exited = once(rpc.child, 'exit');
    rpc.dispose();
    await exited;
    rpc = await connect();
  }
  async function exec(args, context = {}) {
    const child = spawn(binary, ['exec', '--skip-git-repo-check', '--json', ...args], { cwd: home, env: { ...env, ...context }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    return { code, stdout, stderr };
  }
  const list = async (extra = {}) => (await rpc.request('thread/list', { sourceKinds: ['exec', 'subAgentThreadSpawn'], ...extra })).data;
  return { home, provider, rpc, exec, list, restart };
}

test('exec parent persists ancestry, its own preview, and supports listing, resume and archive', { timeout: 120000 }, async t => {
  const { home, provider, rpc, exec, list } = await fixture(t);
  provider.actions.push(message('parent ready'), message('worker ready'), message('grandchild ready'), message('resumed'));
  async function create(args) {
    const result = await exec(args);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout.split('\n').find(line => line.includes('"thread.started"'))).thread_id;
  }
  const parent = await create(['Mother · coordinate parser work']);
  const parentRow = (await list()).find(row => row.id === parent);
  assert.equal(parentRow.parentThreadId, null);
  assert.equal(parentRow.source, 'exec', 'no parent keeps the ordinary exec source');
  await rpc.request('thread/name/set', { threadId: parent, name: 'Mother title' });
  const child = await create(['--parent', parent, 'Worker · inspect argument parsing']);
  const grandchild = await create(['--parent', child, 'Worker · inspect nested parsing']);
  for (const [id, parentId, depth, prompt] of [[child, parent, 1, 'Worker · inspect argument parsing'], [grandchild, child, 2, 'Worker · inspect nested parsing']]) {
    const row = (await list()).find(row => row.id === id);
    assert.ok(row, 'spawned worker is listed');
    assert.equal(row.parentThreadId, parentId);
    assert.equal(row.preview, prompt);
    assert.notEqual(row.name, 'Mother title');
    assert.equal(row.source.subAgent.thread_spawn.parent_thread_id, parentId);
    assert.equal(row.source.subAgent.thread_spawn.depth, depth);
    assert.deepEqual((await list({ parentThreadId: parentId })).map(row => row.id), [id]);
    // Read the durable rollout as well as the app-server projection.
    const meta = JSON.parse(fs.readFileSync(row.path, 'utf8').split('\n')[0]).payload;
    assert.equal(meta.source.subagent.thread_spawn.parent_thread_id, parentId);
    assert.equal(meta.source.subagent.thread_spawn.depth, depth);
    assert.ok(row.path.startsWith(home));
  }
  const resumed = await exec(['resume', child, 'Continue checking the parser']);
  assert.equal(resumed.code, 0, resumed.stderr);
  await rpc.request('thread/archive', { threadId: child });
  assert.ok(!(await list()).some(row => row.id === child));
  assert.ok((await list({ archived: true })).some(row => row.id === child));
  await rpc.request('thread/unarchive', { threadId: child });
  assert.equal((await list()).find(row => row.id === child).parentThreadId, parent);
  assert.equal(provider.requests.length, 4);
});

test('exec inherits its chat parent instead of becoming an unparented Background run', { timeout: 120000 }, async t => {
  const { provider, exec, list } = await fixture(t);
  provider.actions.push(message('parent ready'), message('worker ready'), message('grandchild ready'), message('explicit ready'), message('unparented ready'), message('resumed'), message('temporary'));
  async function create(args, context) {
    const result = await exec(args, context);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout.split('\n').find(line => line.includes('"thread.started"'))).thread_id;
  }
  const parent = await create(['Mother · automatic ancestry']);
  const child = await create(['Worker · inherited ancestry'], { CODEX_THREAD_ID: parent });
  let row = (await list()).find(row => row.id === child);
  assert.equal(row.parentThreadId, parent, 'exec given CODEX_THREAD_ID must nest under its chat, not Background runs');
  assert.equal(row.source.subAgent.thread_spawn.depth, 1);
  const grandchild = await create(['Worker · helper of a helper'], { CODEX_THREAD_ID: child });
  row = (await list()).find(row => row.id === grandchild);
  assert.equal(row.parentThreadId, child);
  assert.equal(row.source.subAgent.thread_spawn.depth, 2);
  const explicit = await create(['--parent', parent, 'Worker · explicit parent wins'], { CODEX_THREAD_ID: grandchild });
  assert.equal((await list()).find(row => row.id === explicit).parentThreadId, parent);
  const unparented = await create(['Worker · no context'], { CODEX_THREAD_ID: '' });
  assert.equal((await list()).find(row => row.id === unparented).parentThreadId, null);
  const resumed = await exec(['resume', child, 'Continue without reparenting'], { CODEX_THREAD_ID: grandchild });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal((await list()).find(row => row.id === child).parentThreadId, parent);
  await create(['--ephemeral', 'Worker · temporary'], { CODEX_THREAD_ID: 'invalid' });
  assert.equal(provider.requests.length, 7);
});

test('inherited missing, archived, deleted and malformed parents fail before inference', { timeout: 120000 }, async t => {
  const { provider, rpc, exec } = await fixture(t);
  for (const id of ['0199e643-657b-7000-8000-000000000001', 'invalid']) {
    const result = await exec(['Worker · invalid context'], { CODEX_THREAD_ID: id });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, id === 'invalid' ? /CODEX_THREAD_ID/ : /Parent thread .* was not found/);
  }
  assert.equal(provider.requests.length, 0);
  provider.actions.push(message('parent ready'));
  const result = await exec(['Mother · archive context']);
  assert.equal(result.code, 0, result.stderr);
  const parent = JSON.parse(result.stdout.split('\n').find(line => line.includes('"thread.started"'))).thread_id;
  await rpc.request('thread/archive', { threadId: parent });
  const archived = await exec(['Worker · archived context'], { CODEX_THREAD_ID: parent });
  assert.notEqual(archived.code, 0);
  assert.match(archived.stderr, /Parent thread .* is archived/);
  assert.equal(provider.requests.length, 1);
  await rpc.request('thread/delete', { threadId: parent });
  const deleted = await exec(['Worker · deleted context'], { CODEX_THREAD_ID: parent });
  assert.notEqual(deleted.code, 0);
  assert.match(deleted.stderr, /Parent thread .* was not found/);
  assert.equal(provider.requests.length, 1);
});

test('many exec helpers keep ancestry and paging after an engine restart', { timeout: 120000 }, async t => {
  const { provider, exec, list, restart } = await fixture(t);
  provider.actions.push(message('parent ready'));
  const result = await exec(['Mother · many helpers']);
  assert.equal(result.code, 0, result.stderr);
  const parent = JSON.parse(result.stdout.split('\n').find(line => line.includes('"thread.started"'))).thread_id;
  const ids = [];
  for (let index = 0; index < 12; index++) {
    provider.actions.push(message(`helper ${index}`));
    const helper = await exec(['--parent', parent, `Worker ${index} · ${'long title '.repeat(12)}`]);
    assert.equal(helper.code, 0, helper.stderr);
    ids.push(JSON.parse(helper.stdout.split('\n').find(line => line.includes('"thread.started"'))).thread_id);
  }
  await restart();
  const children = await list({ parentThreadId: parent, limit: 4 });
  assert.equal(children.length, 4, 'first page remains bounded after restart');
  const descendants = await list({ ancestorThreadId: parent });
  assert.deepEqual(new Set(descendants.map(row => row.id)), new Set(ids));
  for (const index of [0, 6, 11]) {
    const row = descendants.find(row => row.id === ids[index]);
    assert.equal(row.parentThreadId, parent);
    assert.equal(row.source.subAgent.thread_spawn.depth, 1);
  }
  assert.equal(provider.requests.length, 13);
});

test('archiving a parent preserves saved helper ancestry and deleting it removes descendants', { timeout: 120000 }, async t => {
  const { provider, rpc, exec, list } = await fixture(t);
  provider.actions.push(message('parent ready'), message('helper ready'));
  const result = await exec(['Mother · parent lifecycle']);
  assert.equal(result.code, 0, result.stderr);
  const parent = JSON.parse(result.stdout.split('\n').find(line => line.includes('"thread.started"'))).thread_id;
  const helper = await exec(['--parent', parent, 'Worker · parent lifecycle']);
  assert.equal(helper.code, 0, helper.stderr);
  const child = (await list({ parentThreadId: parent }))[0].id;
  await rpc.request('thread/archive', { threadId: parent });
  assert.equal((await list({ archived: true })).find(row => row.id === child).parentThreadId, parent);
  const refused = await exec(['--parent', parent, 'Worker · archived parent']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Parent thread .* is archived/);
  await rpc.request('thread/delete', { threadId: parent });
  assert.equal((await list()).length, 0);
  assert.equal((await list({ archived: true })).length, 0);
  assert.equal(provider.requests.length, 2);
});

test('unknown and archived parents are refused before inference', { timeout: 120000 }, async t => {
  const { provider, rpc, exec, list } = await fixture(t);
  const callCount = () => provider.requests.length + provider.titleRequests.length;
  const unknown = await exec(['--parent', '0199e643-657b-7000-8000-000000000001', 'Worker · must not run']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Parent thread .* was not found/);
  assert.equal(callCount(), 0);
  provider.actions.push(message('parent ready'));
  const result = await exec(['Mother · archived parent']);
  assert.equal(result.code, 0, result.stderr);
  const parent = (await list())[0].id;
  const beforeRefusal = callCount();
  const reparent = await exec(['--parent', parent, 'resume', parent, 'Worker · must not reparent']);
  assert.notEqual(reparent.code, 0);
  assert.match(reparent.stderr, /--parent is only supported when starting a new/);
  assert.equal(callCount(), beforeRefusal);
  await rpc.request('thread/archive', { threadId: parent });
  const archived = await exec(['--parent', parent, 'Worker · must not run']);
  assert.notEqual(archived.code, 0);
  assert.match(archived.stderr, /Parent thread .* is archived/);
  assert.equal(callCount(), beforeRefusal);
  assert.equal((await list()).length, 0);
});

test('exec workers accept direct turns with multi-agent v2 enabled', { timeout: 120000 }, async t => {
  const { provider, rpc, exec, list } = await fixture(t, '[features]\nmulti_agent_v2=true\n');
  provider.actions.push(message('parent ready'), message('worker ready'), message('resumed'));
  const parentResult = await exec(['Mother · coordinate v2 work']);
  assert.equal(parentResult.code, 0, parentResult.stderr);
  const parent = (await list())[0].id;
  const childResult = await exec(['--parent', parent, 'Worker · inspect v2 parsing']);
  assert.equal(childResult.code, 0, childResult.stderr);
  const child = (await list()).find(row => row.parentThreadId === parent);
  assert.ok(child);
  const resumed = await exec(['resume', child.id, 'Continue v2 parsing']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal((await rpc.request('thread/resume', { threadId: child.id })).thread.canAcceptDirectInput, true);
  assert.equal(provider.requests.length, 3);
});
