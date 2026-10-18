import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { ensureInstalledRuntime } from './runtime.mjs';

for (const packaged of [false, true]) test(`desktop reuses ${packaged ? 'packaged' : 'legacy'} installation and keeps explicit sockets external`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-app-launch-'));
  const engine = path.join(dir, packaged ? 'package/bin/codex' : 'elpis-next');
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  const bridgeDir = path.join(dir, 'tools', 'elpis-claude');
  fs.mkdirSync(bridgeDir, { recursive: true }); fs.writeFileSync(engine, 'fixture');
  const marker = path.join(dir, 'called.json');
  fs.writeFileSync(path.join(bridgeDir, 'acp-bridge.mjs'), '');
  fs.writeFileSync(path.join(bridgeDir, 'shared-runtime.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ engine:process.env.ELPIS_ENGINE_BIN, home:process.env.ELPIS_HOME, bridge:process.argv[2] }));`);
  const env = { PATH: process.env.PATH, ELPIS_ENGINE_BIN: engine, ELPIS_HOME: dir };
  await ensureInstalledRuntime({ env: { ...env, ELPIS_APP_BRIDGE_SOCKET: '/explicit/runtime.sock' } });
  assert.equal(fs.existsSync(marker), false);
  await ensureInstalledRuntime({ env });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), { engine, home: dir, bridge: path.join(bridgeDir, 'acp-bridge.mjs') });
  // A graphical session need not have node on PATH; the launcher passes its resolved executable.
  const dockHome = path.join(dir, 'dock-profile');
  await ensureInstalledRuntime({ env: { ...env, PATH: dir, ELPIS_NODE_BIN: process.execPath, ELPIS_HOME: dockHome } });
  assert.equal(JSON.parse(fs.readFileSync(marker)).home, dockHome);
  await assert.rejects(ensureInstalledRuntime({ env: { ...env, ELPIS_ENGINE_BIN: path.join(dir, 'missing') } }), /could not be found/);
});

test('desktop runtime startup keeps loopback traffic outside a configured proxy', async () => {
  const server = http.createServer((_request, response) => response.end('local-runtime'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-app-proxy-'));
  const engine = path.join(dir, 'elpis-next');
  const bridgeDir = path.join(dir, 'tools', 'elpis-claude');
  fs.mkdirSync(bridgeDir, { recursive: true }); fs.writeFileSync(engine, 'fixture');
  fs.writeFileSync(path.join(bridgeDir, 'acp-bridge.mjs'), '');
  fs.writeFileSync(path.join(bridgeDir, 'shared-runtime.mjs'), `const response = await fetch('http://127.0.0.1:${server.address().port}'); if (await response.text() !== 'local-runtime') throw new Error('Wrong endpoint');`);
  try {
    await ensureInstalledRuntime({ env: { PATH: process.env.PATH, ELPIS_HOME: dir, ELPIS_ENGINE_BIN: engine, HTTP_PROXY: 'http://127.0.0.1:1' } });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('desktop reuses a live private runtime even when the launcher points to an older installation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-app-live-'));
  const key = createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 16);
  const socketDir = path.join(dir, 'elpis-bridge', key);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(socketDir, 'bridge.sock');
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  const env = { PATH: process.env.PATH, ELPIS_HOME: dir, XDG_RUNTIME_DIR: dir };
  const explicit = { ...env, ELPIS_ENGINE_BIN: path.join(dir, 'old-missing-engine') };
  try {
    await ensureInstalledRuntime({ env });
    await assert.rejects(ensureInstalledRuntime({ env: explicit }), /could not be found/);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(ensureInstalledRuntime({ env: explicit }), /could not be found/);
});
