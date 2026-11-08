// Real engine, isolated home, no inference or credentials. Run with an absolute engine executable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ledgerBridge, ledgerMarketplace } from './ledger-fixtures.mts';

type Plugin = { id: string; name: string; enabled: boolean; installed: boolean };
type Marketplace = { name: string; path: string; plugins: Plugin[] };
type ConfigRead = { layers: { name?: { type?: string }; version?: string }[]; config: { mcp_servers: { ledger: { enabled: boolean } } } };
type Customize = { plugins: { data: Plugin[]; version: string }; connectors: { data: { name: string; enabled: boolean }[]; version: string } };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'Provide an absolute engine executable');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
const home = path.join(root, 'engine');
await fs.mkdir(home);
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: root, ELPIS_HOME: home, CODEX_HOME: home,
  CODEX_AUTH_HOME: home, XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`,
  XDG_DATA_HOME: `${root}/data`, XDG_STATE_HOME: `${root}/state` };
await fs.writeFile(path.join(home, 'config.toml'), '[features]\nplugins = true\n[mcp_servers.ledger]\ncommand = "node"\nargs = ["--version"]\nenabled = true\n');
let sequence = 0;
const pending = new Map<number, Pending>();
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '';
child.stderr.on('data', chunk => { logs += chunk; });
createInterface({ input: child.stdout }).on('line', line => {
  const reply = JSON.parse(String(line)), entry = pending.get(reply.id);
  if (!entry) return;
  pending.delete(reply.id); clearTimeout(entry.timer);
  reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.result);
});
function rpc<T = unknown>(method: string, params: object = {}): Promise<T> {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`Timed out: ${method}\n${logs.slice(-2000)}`)), 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  }) as Promise<T>;
}
const report = (method: string, params: unknown, result: unknown) => console.log(JSON.stringify({ method, params, result }));
async function call<T = unknown>(method: string, params: object = {}): Promise<T> { const result = await rpc<T>(method, params); report(method, params, result); return result; }
let app: Awaited<ReturnType<typeof import('../bridge/server.mts').startDesktopServer>> | undefined, bridge: Awaited<ReturnType<typeof ledgerBridge>> | undefined;
try {
  console.log(`Throwaway home: ${root}`);
  await call('initialize', { clientInfo: { name: 'ledger-proof', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  for (const format of ['codex', 'claude'] as const) {
    const { market, name, pluginName } = await ledgerMarketplace(root, format);
    await call('marketplace/add', { source: market });
    const catalog = await call<{ marketplaces: Marketplace[] }>('plugin/list');
    const entry = catalog.marketplaces.find(item => item.name === name);
    assert(entry?.plugins.some(item => item.name === pluginName), 'Added marketplace must be listed');
    assert.ok(entry);
    const search = await call<{ data: { plugin: Plugin }[] }>('plugin/search', { searchTerm: pluginName });
    assert(search.data.some(item => item.plugin.name === pluginName));
    await call('plugin/install', { marketplacePath: entry.path, pluginName });
    for (const enabled of [false, true]) {
      const read = await rpc<ConfigRead>('config/read', { includeLayers: true });
      const layer = read.layers.find(item => item.name?.type === 'user');
      await call('config/batchWrite', { edits: [{ keyPath: `plugins.${JSON.stringify(`${pluginName}@${name}`)}.enabled`, value: enabled, mergeStrategy: 'replace' }], expectedVersion: layer?.version, reloadUserConfig: true });
      const installed = await call<{ marketplaces: Marketplace[] }>('plugin/installed');
      assert.equal(installed.marketplaces.find(item => item.name === name)?.plugins.find(item => item.name === pluginName)?.enabled, enabled);
      assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), new RegExp(`enabled = ${enabled}`));
    }
    await call('plugin/uninstall', { pluginId: `${pluginName}@${name}` });
    const installed = await call<{ marketplaces: Marketplace[] }>('plugin/installed');
    assert(!installed.marketplaces.flatMap(item => item.plugins).some(item => item.id === `${pluginName}@${name}` && item.installed));
    await call('marketplace/remove', { marketplaceName: name });
  }
  for (const enabled of [false, true]) {
    await call('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.ledger.enabled', value: enabled, mergeStrategy: 'replace' }], reloadUserConfig: true });
    assert.equal((await rpc<ConfigRead>('config/read')).config.mcp_servers.ledger.enabled, enabled);
    console.log(`MCP persisted ${enabled}:\n${await fs.readFile(path.join(home, 'config.toml'), 'utf8')}`);
  }
  // The production HTTP bridge over a second real engine connection, using exactly the renderer's requests.
  process.env = { ...env };
  // The production provider bridge's per-connection engine transport also works in a worker sandbox,
  // where the host's shared daemon rendezvous directory is deliberately hidden.
  bridge = await ledgerBridge(root, binary, env);
  const { startDesktopServer } = await import('../bridge/server.mts');
  app = await startDesktopServer({ socketPath: bridge.socketPath, elpisHome: home });
  const url = new URL(app.url);
  const session = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }) });
  assert.equal(session.status, 200);
  const cookieHeader = session.headers.get('set-cookie'); assert.ok(cookieHeader); const cookie = cookieHeader.split(';')[0]; assert.ok(cookie);
  const { DesktopClient } = await import('../bridge/client.mts');
  const bridgeSocket = bridge.socketPath;
  const freshState = async () => {
    const client = await DesktopClient.connect({ socketPath: bridgeSocket });
    try { return await client.customize(); } finally { client.close(); }
  };
  const api = async <T extends object = Customize>(endpoint: string, body?: object, expected = 200): Promise<T> => {
    const response = await fetch(`${url.origin}/api${endpoint}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: url.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json() as T; report(`HTTP ${endpoint}`, body, { status: response.status, ...result });
    assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  for (const format of ['codex', 'claude'] as const) {
    const { market, name, pluginName } = await ledgerMarketplace(root, format), id = `${pluginName}@${name}`;
    await api('/customize/marketplace', { action: 'add', source: market });
    assert((await api<{ plugins: Plugin[] }>(`/customize/plugins?search=${pluginName}`)).plugins.some(plugin => plugin.id === id));
    let state = await api('/customize/plugin', { action: 'install', id });
    assert(state.plugins.data.some(plugin => plugin.id === id));
    for (const enabled of [false, true]) {
      state = await api('/customize/plugin', { action: 'enable', id, enabled, version: state.plugins.version });
      const selected = state.plugins.data.find(plugin => plugin.id === id); assert.ok(selected); assert.equal(selected.enabled, enabled);
      const freshPlugins = (await freshState()).plugins; assert.ok(freshPlugins?.data);
      const fresh = freshPlugins.data.find(plugin => plugin.id === id); assert.ok(fresh); assert.equal(fresh.enabled, enabled, 'A new real engine must read the saved plugin state');
      assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), new RegExp(`\\[plugins\\."${id}"\\]\\nenabled = ${enabled}`));
    }
    await api('/customize/plugin', { action: 'enable', id, enabled: false, version: 'stale-version' }, 409);
    state = await api('/customize/plugin', { action: 'uninstall', id });
    assert(!state.plugins.data.some(plugin => plugin.id === id));
    await api('/customize/marketplace', { action: 'remove', name });
  }
  let state = await api('/customize');
  for (const enabled of [false, true]) {
    await api('/mcp', { action: 'enable', name: 'ledger', enabled, version: state.connectors.version });
    state = await api('/customize');
    const selected = state.connectors.data.find(server => server.name === 'ledger'); assert.ok(selected); assert.equal(selected.enabled, enabled);
    const fresh = (await freshState()).connectors.data.find(server => server.name === 'ledger'); assert.ok(fresh); assert.equal(fresh.enabled, enabled, 'A new real engine must read the saved MCP state');
    assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), new RegExp(`enabled = ${enabled}`));
  }
  await api('/customize/marketplace', { action: 'add', source: '/nonexistent-ledger-marketplace' }, 502);
  console.log('PASS: both formats, production HTTP bridge, stale-write rejection, MCP config persistence');
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  await app?.close(); child.stdin.end(); child.kill('SIGTERM');
  await bridge?.close();
}
