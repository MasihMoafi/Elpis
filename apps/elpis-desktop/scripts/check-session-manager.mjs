// A101 acceptance: production MCP subprocess -> private host socket -> DesktopClient -> real installed bridge/engine.
// No model or credentials. Usage: node scripts/check-session-manager.mjs --copy /absolute/session.jsonl [--app /absolute/package/app] [--engine /absolute/codex]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';

const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const app = path.resolve(option('--app') || new URL('../', import.meta.url).pathname);
const engine = fs.realpathSync(option('--engine') || path.join(os.homedir(), '.local/bin/elpis-next'));
const copy = option('--copy');
if (!copy) throw Error('Pass --copy with a real session JSONL; only copies will be changed.');
const raw = fs.readFileSync(copy, 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.equal(raw[0].type, 'session_meta');
const seededHome = option('--home');
if (seededHome && (!process.argv.includes('--seed-only') || !/^\/tmp\/(?:e2e-|a101-check-)[^/]+$/.test(seededHome)
  || !fs.lstatSync(seededHome).isDirectory() || fs.lstatSync(seededHome).uid !== process.getuid() || fs.realpathSync(seededHome) !== seededHome)) throw Error('--home must be an owned throwaway home and is only allowed with --seed-only.');
const home = seededHome || fs.mkdtempSync('/tmp/a101-check-');
console.log(`Evidence home: ${home}`);
for (const key of Object.keys(process.env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIAL/.test(key) || ['ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET'].includes(key)) delete process.env[key];
Object.assign(process.env, { HOME: home, ELPIS_HOME: `${home}/elpis`, CODEX_HOME: `${home}/elpis`, ELPIS_CONFIG_DIR: `${home}/elpis`,
  XDG_RUNTIME_DIR: `${home}/run`, XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`, TMPDIR: home, ELPIS_ENGINE_BIN: engine });
fs.mkdirSync(`${home}/run`, { mode: 0o700, recursive: true });
const project = `${home}/project`, other = `${home}/other`;
fs.mkdirSync(project); fs.mkdirSync(other);
const ids = {}, originals = {};
for (const [label, days, cwd] of [['old', 9, project], ['recent', 0, project], ['named', 9, project], ['other', 9, other], ['placeholder', 9, project]]) {
  const id = randomUUID(), at = new Date(Date.now() - days * 86400_000), stamp = at.toISOString(); ids[label] = id;
  const rows = structuredClone(raw);
  for (const row of rows) {
    row.timestamp = stamp;
    if (row.type === 'session_meta') Object.assign(row.payload, { id, session_id: id, parent_thread_id: null, timestamp: stamp,
      forked_from_id: null, cwd, runtime_workspace_roots: [cwd], source: 'cli', originator: 'elpis-cli', thread_source: null });
    if (row.type === 'turn_context') { row.payload.cwd = cwd; if (row.payload.runtime_workspace_roots) row.payload.runtime_workspace_roots = [cwd]; }
    // Backfill applies these AFTER session_meta. Leaving them unchanged seeds the original project,
    // not the throwaway project, and the production project guard correctly refuses the copy.
    if (row.type === 'event_msg' && row.payload.type === 'thread_settings_applied') {
      row.payload.thread_id = id;
      row.payload.thread_settings.cwd = cwd;
      row.payload.thread_settings.runtime_workspace_roots = [cwd];
    }
  }
  const directory = `${home}/elpis/sessions/${stamp.slice(0, 10).replaceAll('-', '/')}`;
  fs.mkdirSync(directory, { recursive: true });
  const file = `${directory}/rollout-${stamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`;
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); fs.utimesSync(file, at, at);
  originals[label] = file;
}
fs.writeFileSync(`${home}/seed.json`, JSON.stringify({ ids, originals, project, other }, null, 2), { mode: 0o600 });
const load = file => import(pathToFileURL(path.join(app, file)).href);
const { DesktopClient } = await load('bridge/client.mjs');
const { runtimeTools } = await load('bridge/runtime-paths.mjs');
const { sessionManagerMcpConfig } = await load('bridge/session-manager-mcp.mjs');
const { default: hostModule } = await load('desktop/session-manager-agent.cjs');
const { createStateStore } = (await load('desktop/state.cjs')).default;
const tools = runtimeTools(engine);
if (process.argv.includes('--seed-only')) {
  // An app started by W11's helper already owns this home's bridge. Prepare names without a model turn.
  if (!seededHome) throw Error('--seed-only requires --home from the running W11 throwaway app.');
  const seedClient = await DesktopClient.connect();
  try {
    await seedClient.listThreads({ limit: 100 });
    await seedClient.renameThread(ids.named, { name: 'Keep this named session' });
    await seedClient.renameThread(ids.placeholder, { name: 'Untitled conversation' });
    console.log(`Seed prepared for a real automatic review: ${home}/seed.json`);
  } finally { seedClient.close(); }
  process.exit(0);
}
let client, host, mcp, socket, config;
const early = sessionManagerMcpConfig(`${home}/manager.sock`, process.execPath, 'check-only')['mcp_servers.elpis_session_manager'];
console.log(`${early.tools.session_rename?.approval_mode === 'auto' && early.tools.session_archive?.approval_mode === 'auto' ? 'PASS' : 'FAIL'} packaged approval policy: rename=${early.tools.session_rename?.approval_mode ?? early.default_tools_approval_mode}, archive=${early.tools.session_archive?.approval_mode ?? early.default_tools_approval_mode}`);
try {
  socket = execFileSync(process.execPath, [path.join(tools, 'shared-runtime.mjs'), path.join(tools, 'acp-bridge.mjs')], { env: process.env, encoding: 'utf8', timeout: 30000 }).trim().replace(/^unix:\/\//, '');
  const store = createStateStore(`${home}/workspace.json`);
  host = await hostModule.startSessionManagerAgent({ store, client: {
    listThreads: (...args) => client.listThreads(...args), readThreadMetadata: (...args) => client.readThreadMetadata(...args),
    renameThread: (...args) => client.renameThread(...args), archiveThread: (...args) => client.archiveThread(...args),
    ...(DesktopClient.prototype.sessionHasChildren ? { sessionHasChildren: (...args) => client.sessionHasChildren(...args) } : {}),
  } });
  const managerConfig = { isManager: id => store.read()[hostModule.SESSION_MANAGER_ID_KEY] === id,
    forSession: id => sessionManagerMcpConfig(host.path, process.execPath, host.scope(id)), bind: (from, to) => host.bind(from, to), close: id => host.revoke(id) };
  client = await DesktopClient.connect({ socketPath: socket, sessionManagerConfig: managerConfig });
  const listed = await client.listThreads({ limit: 100 });
  for (const id of Object.values(ids)) assert.ok(listed.data.some(row => row.id === id), `copied session missing: ${id}`);
  await client.renameThread(ids.named, { name: 'Keep this named session' });
  await client.renameThread(ids.placeholder, { name: 'Untitled conversation' });
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const protectedCopies = Object.fromEntries(['named', 'other'].map(label => [label, digest(originals[label])]));
  // Naming can change activity; the old unnamed copy is the positive archive case.
  const manager = (await client.createThread({ sessionManager: true })).thread.id;
  await store.set(hostModule.SESSION_MANAGER_ID_KEY, manager);
  config = sessionManagerMcpConfig(host.path, process.execPath, host.scope(manager))['mcp_servers.elpis_session_manager'];
  mcp = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  const lines = readline.createInterface({ input: mcp.stdout });
  lines.on('line', line => { const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP timed out: ${method}`)); }, 40000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = (name, id, extra = {}, identity = manager) => rpc('tools/call', { name, arguments: { ...(id ? { sessionId: id } : {}), ...extra }, _meta: { threadId: identity } });
  const payload = response => { assert.ok(response.result, JSON.stringify(response)); assert.notEqual(response.result.isError, true, JSON.stringify(response.result)); return JSON.parse(response.result.content[0].text.split('\n').slice(1).join('\n')); };
  const refused = (response, reason) => { assert.equal(response.result?.isError, true, JSON.stringify(response)); assert.match(response.result.content.map(row => row.text ?? '').join('\n'), reason); };
  const failures = [];
  const check = async (label, action) => { try { await action(); console.log(`PASS ${label}`); } catch (error) { failures.push(label); console.log(`FAIL ${label}: ${error.message}`); } };
  await check('policy: only manager rename/archive auto; default and grouping still approve', () => {
    assert.equal(config.default_tools_approval_mode, 'approve');
    assert.equal(config.tools.session_rename?.approval_mode, 'auto'); assert.equal(config.tools.session_archive?.approval_mode, 'auto');
    assert.equal(config.tools.session_organize?.approval_mode ?? 'approve', 'approve');
  });
  await check('native copied project metadata matches the grant', async () => {
    for (const [label, id] of Object.entries(ids)) {
      const expected = fs.realpathSync(label === 'other' ? other : project);
      const listedRow = (await client.listThreads({ limit: 100 })).data.find(row => row.id === id);
      const current = await client.readThreadMetadata(id);
      assert.equal(fs.realpathSync(listedRow.cwd), expected, `${label}: list cwd ${listedRow.cwd}`);
      assert.equal(fs.realpathSync(current.cwd), expected, `${label}: read cwd ${current.cwd}`);
    }
  });
  await check('missing project scope refused', async () => refused(await call('session_archive', ids.old), /outside.*project/));
  const end = host.beginReview?.(manager, project);
  await check('session_list grants only rule-matching candidates', async () => {
    const sessions = payload(await call('session_list')).sessions;
    const row = label => sessions.find(session => session.sessionId === ids[label]);
    assert.equal(row('old').canArchive, true);
    assert.equal(row('recent').canRename, true); assert.equal(row('recent').canArchive, false);
    for (const label of ['named', 'other']) { assert.equal(row(label).canRename, false); assert.equal(row(label).canArchive, false); }
  });
  for (const [label, reason] of [['named', /meaningful name/], ['recent', /7 days/], ['other', /outside.*project/]]) await check(`${label} archive refused`, async () => refused(await call('session_archive', ids[label]), reason));
  for (const [label, reason] of [['named', /meaningful name/], ['other', /outside.*project/]]) await check(`${label} rename refused`, async () => refused(await call('session_rename', ids[label], { name: 'Must not change' }), reason));
  await check('forged chat identity refused', async () => assert.equal((await call('session_archive', ids.old, {}, ids.recent)).result.isError, true));
  await check('old unnamed archive persisted', async () => {
    assert.equal(payload(await call('session_archive', ids.old)).archived, true);
    assert.ok((await client.listThreads({ archived: true, limit: 100 })).data.some(row => row.id === ids.old));
    assert.equal(fs.existsSync(originals.old), false);
  });
  await check('recent unnamed rename persisted', async () => {
    assert.equal(payload(await call('session_rename', ids.recent, { name: 'A101 renamed task' })).renamed, true);
    assert.equal((await client.listThreads({ limit: 100 })).data.find(row => row.id === ids.recent)?.name, 'A101 renamed task');
  });
  await check('action reasons persisted in workspace on disk', () => {
    const saved = JSON.parse(fs.readFileSync(`${home}/workspace.json`, 'utf8'));
    assert.equal(typeof saved[hostModule.SESSION_MANAGER_ACTIONS_KEY], 'string', 'action journal was not written');
    const actions = JSON.parse(saved[hostModule.SESSION_MANAGER_ACTIONS_KEY]);
    assert.match(actions[ids.old].find(row => row.status === 'done').reason, /7 days/);
    assert.ok(actions[ids.recent].find(row => row.status === 'done').reason);
  });
  end?.();
  await check('expired project scope refused', async () => refused(await call('session_archive', ids.placeholder), /outside.*project/));
  await check('protected sessions untouched', async () => {
    const active = (await client.listThreads({ limit: 100 })).data;
    assert.equal(active.find(row => row.id === ids.named)?.name, 'Keep this named session');
    assert.equal(active.find(row => row.id === ids.other)?.name ?? null, null);
    assert.ok(active.some(row => row.id === ids.other));
    assert.ok(active.some(row => row.id === ids.recent));
    for (const label of ['named', 'other']) assert.equal(digest(originals[label]), protectedCopies[label], `${label}: copy changed`);
  });
  await check('archive date and reason survive a fresh desktop client', async () => {
    const cold = await DesktopClient.connect({ socketPath: socket });
    try {
      const archived = (await cold.listArchivedThreads({ limit: 100 })).data;
      const row = archived.find(row => row.id === ids.old);
      assert.ok(row.archivedAt > 0); assert.match(row.archiveReason, /7 days/);
      assert.equal((await cold.listThreads({ limit: 100 })).data.find(row => row.id === ids.recent)?.name, 'A101 renamed task');
    } finally { cold.close(); }
  });
  fs.writeFileSync(`${home}/result.json`, JSON.stringify({ app, ids, failures, config: { default: config.default_tools_approval_mode, tools: config.tools }, running: 'not run: no model credentials' }, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(`Acceptance could not complete: ${error.message}`);
  if (socket) {
    const log = path.join(path.dirname(socket), 'daemon.log');
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').split('\n').filter(line => /ERROR|Error:|exited/.test(line)).join('\n'));
  }
  process.exitCode = 1;
} finally {
  mcp?.stdin.end(); mcp?.kill(); client?.close(); await host?.close();
  if (socket) {
    const state = JSON.parse(fs.readFileSync(path.join(path.dirname(socket), 'state.json'), 'utf8'));
    if (state.socket === socket && socket.startsWith(home + '/') && state.pid > 0) {
      try { process.kill(state.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
