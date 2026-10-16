// Native MCP config acceptance only; no chat, provider request, or real-profile writes.
// node bridge/mcp.runtime.mjs /absolute/path/to/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DesktopClient } from './client.mjs';

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'Provide an absolute native binary');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-mcp-settings-'));
const home = path.join(root, 'home');
await fs.mkdir(home);
await fs.writeFile(path.join(home, 'config.toml'), '[mcp_servers.rag]\ncommand="/bin/true"\n[mcp_servers.rag.env]\nOPENROUTER_API_KEY="fixture-original"\n[mcp_servers.whispertype]\ncommand="/bin/true"\n[mcp_servers.whispertype.env]\nWHISPERTYPE_BACKEND="openrouter"\n');
const socketPath = path.join(root, 'bridge.sock');
const env = { PATH: process.env.PATH, HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home, CODEX_HOME: home, LANG: 'C.UTF-8', RUST_LOG: 'error' };
delete env.OPENROUTER_API_KEY;
delete env.OPENROUTER_API_KEY_COMPANY;
const child = spawn(binary, ['app-server', '--listen', `unix://${socketPath}`], { cwd: root, env, stdio: 'ignore' });
let client;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.chmod(socketPath, 0o600); ready = true; break; } catch {}
    if (child.exitCode !== null) throw Error('Native fixture exited before its socket was ready');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Native socket did not start');
  // Native app-server exposes its private canonical socket through the requested alias.
  const canonicalSocket = await fs.realpath(socketPath);
  client = await DesktopClient.connect({ socketPath: canonicalSocket, beforeConnect: () => fs.chmod(canonicalSocket, 0o600) });
  let config = await client.mcp();
  assert.equal(config.configPath, path.join(home, 'config.toml'));
  config = await client.saveMcp({ version: config.version, action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: 'fixture-replacement' } });
  assert.equal((await fs.stat(path.join(home, 'config.toml'))).mode & 0o777, 0o600);
  assert(!JSON.stringify(config).includes('fixture-replacement'));
  assert.equal((await client.ragEnvironment()).OPENROUTER_API_KEY, 'fixture-replacement');
  for (const value of ['', '********', '••••••••']) config = await client.saveMcp({ version: config.version, action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: value } });
  assert.equal((await client.ragEnvironment()).OPENROUTER_API_KEY, 'fixture-replacement');
  await assert.rejects(client.saveMcp({ version: config.version, action: 'credentials', name: 'unknown', env: { OPENROUTER_API_KEY: 'fixture-invalid' } }), /Unknown MCP/);
  await assert.rejects(client.saveMcp({ version: 'stale', action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: 'fixture-invalid' } }), /changed in another client/);
  config = await client.saveMcp({ version: config.version, action: 'credentials', name: 'whispertype', env: { OPENROUTER_API_KEY_COMPANY: 'fixture-whisper' } });
  config = await client.saveMcp({ version: config.version, action: 'whispertype', name: 'whispertype', backend: 'local', model: 'openai/gpt-4o-mini-transcribe' });
  const whisper = config.servers.find(server => server.name === 'whispertype');
  assert.equal(whisper.whispertype.backend, 'local');
  assert.equal(whisper.credentials.find(key => key.name === 'OPENROUTER_API_KEY_COMPANY').set, true);
  assert(!JSON.stringify(config).includes('fixture-whisper'));
  config = await client.saveMcp({ version: config.version, action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: null } });
  assert.equal((await client.ragEnvironment()).OPENROUTER_API_KEY, undefined);
  let providers = await client.providerSettings();
  const provider = { id: 'fixture-native', name: 'Native fixture', baseUrl: 'http://127.0.0.1:1234/v1' };
  providers = await client.saveProvider({ ...provider, version: providers.version, credential: { action: 'replace', value: 'fixture-provider-key' } });
  assert.equal(providers.providers.find(item => item.id === provider.id).auth.source, 'stored');
  assert.equal(providers.providers.find(item => item.id === provider.id).auth.keySet, true);
  assert(!JSON.stringify(providers).includes('fixture-provider-key'));
  assert.equal((await fs.stat(path.join(home, 'config.toml'))).mode & 0o777, 0o600);
  for (const value of ['', '********']) providers = await client.saveProvider({ ...provider, version: providers.version, credential: { action: 'replace', value } });
  assert.equal(providers.providers.find(item => item.id === provider.id).auth.keySet, true);
  await assert.rejects(client.saveProvider({ ...provider, version: 'stale', credential: { action: 'clear' } }), error => error.status === 409);
  providers = await client.saveProvider({ ...provider, version: providers.version, credential: { action: 'clear' } });
  assert.equal(providers.providers.find(item => item.id === provider.id).auth.keySet, false);
  console.log('Native provider settings: add/replace/preserve/clear/redact + CAS +0600 passed. No inference.');
  console.log('Native MCP settings: replace/preserve/redact/remove keys, reject unknown/stale writes, and persist WhisperType local backend passed. No inference.');
} finally {
  client?.close();
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
}
