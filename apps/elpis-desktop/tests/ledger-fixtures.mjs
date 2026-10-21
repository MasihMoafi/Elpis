import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Production provider bridge with real stdio engines. The byte relay adapts its loopback listener
 * to DesktopClient's Unix transport when the worker sandbox hides the shared daemon directory. */
export async function ledgerBridge(root, binary, env) {
  const log = path.join(root, 'provider.log'), socketPath = path.join(root, 'bridge.sock');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/elpis-claude/acp-bridge.mjs', import.meta.url))], { cwd: root, detached: true,
    env: { ...env, ELPIS_ENGINE_BIN: binary, PORT: '0', ACP_BRIDGE_LOG: log }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '', server;
  const sockets = new Set();
  child.stderr.on('data', chunk => { errors += chunk; });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  };
  try {
    let port;
    for (let attempt = 0; !port; attempt++) {
      try { port = Number((await fs.readFile(log, 'utf8')).match(/LISTENING (\d+)/)?.[1]); } catch {}
      if (attempt > 100 || child.exitCode !== null) throw Error(`Provider bridge unavailable: ${errors}`);
      if (!port) await new Promise(resolve => setTimeout(resolve, 100));
    }
    server = net.createServer(downstream => {
      const upstream = net.connect(port, '127.0.0.1');
      for (const socket of [downstream, upstream]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
      downstream.on('error', () => upstream.destroy()); upstream.on('error', () => downstream.destroy());
      downstream.on('close', () => upstream.destroy()); upstream.on('close', () => downstream.destroy());
      downstream.pipe(upstream).pipe(downstream);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await fs.chmod(socketPath, 0o600);
    return { socketPath, close };
  } catch (error) { await close(); throw error; }
}

/** Real on-disk marketplace formats; neither requires a download, account or model. */
export async function ledgerMarketplace(root, format) {
  const market = path.join(root, format), name = `ledger-${format}`, pluginName = `proof-${format}`, plugin = path.join(market, 'plugins', pluginName);
  const marketDir = format === 'codex' ? '.agents/plugins' : '.claude-plugin';
  const pluginDir = format === 'codex' ? '.codex-plugin' : '.claude-plugin';
  await fs.mkdir(path.join(market, marketDir), { recursive: true });
  await fs.mkdir(path.join(plugin, pluginDir), { recursive: true });
  await fs.mkdir(path.join(plugin, 'skills', 'proof'), { recursive: true });
  await fs.writeFile(path.join(plugin, pluginDir, 'plugin.json'), JSON.stringify({ name: pluginName, description: 'Ledger format proof', version: '1.0.0' }));
  await fs.writeFile(path.join(plugin, 'skills/proof/SKILL.md'), '---\nname: proof\ndescription: Ledger format proof\n---\nUse the proof marker.\n');
  await fs.writeFile(path.join(market, marketDir, 'marketplace.json'), JSON.stringify({ name, owner: { name: 'Ledger proof' }, plugins: [{ name: pluginName, description: 'Ledger format proof', source: format === 'codex' ? { source: 'local', path: `./plugins/${pluginName}` } : `./plugins/${pluginName}` }] }));
  return { market, name, pluginName };
}
