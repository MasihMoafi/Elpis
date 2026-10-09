'use strict';
// Exercise the real launcher with private homes and shared Unix-socket bridges.
// A moving default command must not change the runtime selected for this session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-launcher-'));
const bridge = process.env.BRIDGE_LAUNCHER_DIR ?? path.resolve(__dirname, '../tools/elpis-claude');
const expected = path.join(root, '.local/lib/elpis-next/elpis-next');
const fallback = path.join(root, '.local/bin/elpis');
const fixtureBridge = path.join(root, 'Desktop/p/Elpis-wt-acp/tools/elpis-claude');
fs.mkdirSync(path.dirname(expected), { recursive: true });
fs.mkdirSync(path.dirname(fallback), { recursive: true });
fs.mkdirSync(path.dirname(fixtureBridge), { recursive: true });
fs.symlinkSync(bridge, fixtureBridge);
fs.writeFileSync(expected, '#!/bin/sh\nprintf "selected:%s\\n" "$ELPIS_ENGINE_BIN"\nprintf "arg:%s\\n" "$@"\n', { mode: 0o755 });
fs.writeFileSync(fallback, '#!/bin/sh\nprintf "fallback\\n"\nprintf "arg:%s\\n" "$@"\n', { mode: 0o755 });
const env = { ...process.env, HOME: root, CODEX_HOME: root, ELPIS_HOME: root, ELPIS_NO_AGY: '1', ACP_BRIDGE_LOG: path.join(root, 'bridge.log') };
delete env.ELPIS_ENGINE_BIN;
delete env.ELPIS_NO_CLAUDE;
function launch(script, args, extra = {}) {
  const result = spawnSync('bash', [path.join(bridge, script), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function main() {
  const standaloneHome = path.join(root, 'standalone');
  fs.mkdirSync(standaloneHome);
  try {
    let output = launch('elpis-wrapper', ['resume', 'fixture-session']);
    assert(output.includes(`selected:${expected}`), output);
    assert(!output.includes('fallback'), output);
    assert.match(output, /arg:--remote\narg:unix:\/\/[^\n]+\narg:resume\narg:fixture-session/);
    console.log('PASS interactive wrapper pins the same runtime for bridge and TUI');
    output = launch('elpis-claude', ['resume', 'fixture-session'], { ELPIS_HOME: standaloneHome });
    assert(output.includes('fallback'), output);
    assert(!output.includes('selected:'), output);
    console.log('PASS standalone bridge launcher retains the default command when no runtime is selected');
  } finally {
    const { runtimeDir, startToken } = await import('../tools/elpis-claude/shared-runtime.mjs');
    for (const home of [root, standaloneHome]) {
      const stateFile = runtimeDir(home).state;
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (startToken(state.pid) === state.token) process.kill(state.pid, 'SIGTERM');
      }
    }
    console.log(`Evidence: ${root}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
