'use strict';
// /usage reads every account's limits through account/rateLimits/read. The engine only knows
// OpenAI's, so a Claude chat showed the GPT plan. A real bridge with a stand-in Anthropic usage
// endpoint must answer with Claude's limits too.
// Usage: node scripts/bridge-usage.test.cjs /absolute/engine [/absolute/bridge-dir]
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'); const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..'), binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'absolute engine binary required');
const bridgeDir = process.argv[3] ?? path.join(repo, 'tools/elpis-claude');
const { WebSocket } = require(path.join(bridgeDir, 'node_modules/ws'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-bridge-usage-'));
const userHome = path.join(root, 'home'), home = path.join(userHome, '.elpis-next'), runtime = path.join(root, 'run');
for (const p of [home, runtime, path.join(userHome, '.claude')]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(userHome, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', subscriptionType: 'max' } }));
let usageRequests = 0;
const usage = http.createServer((req, res) => {
  usageRequests++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ five_hour: { utilization: 41, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 86, resets_at: '2030-01-07T00:00:00Z' } }));
});
(async () => {
  await new Promise((resolve) => usage.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, HOME: userHome, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, XDG_RUNTIME_DIR: runtime, LANG: 'C.UTF-8',
    ELPIS_ENGINE_BIN: binary, ELPIS_NO_AGY: '1', PERMISSION_FIXTURE_ADAPTER: '1', ACP_ADAPTER: path.join(repo, 'scripts/permissions-bridge.test.cjs'),
    ACP_BRIDGE_STORE: path.join(home, 'elpis-claude/sessions.json'), ELPIS_CLAUDE_USAGE_URL: `http://127.0.0.1:${usage.address().port}/usage`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const start = spawnSync(process.execPath, [path.join(bridgeDir, 'shared-runtime.mjs'), path.join(bridgeDir, 'acp-bridge.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(start.status, 0, start.stderr);
  const endpoint = start.stdout.trim().replace(/^unix:\/\//, '');
  const ws = new WebSocket(`ws+unix://${endpoint}:/`);
  let id = 0; const pending = new Map();
  const call = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.on('message', (data) => { const m = JSON.parse(data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await call('initialize', { clientInfo: { name: 'bridge-usage-test', version: '0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const answer = await call('account/rateLimits/read', {});
  fs.writeFileSync(path.join(root, 'answer.json'), JSON.stringify(answer, null, 2));
  ws.close();
  const state = JSON.parse(fs.readFileSync(path.join(runtime, 'elpis-bridge', fs.readdirSync(path.join(runtime, 'elpis-bridge'))[0], 'state.json')));
  process.kill(state.pid, 'SIGTERM');
  const claude = answer.result?.rateLimitsByLimitId?.claude;
  console.log(JSON.stringify({ root, usageRequests, error: answer.error?.message ?? null, claude: claude ? { primary: claude.primary?.usedPercent, secondary: claude.secondary?.usedPercent } : null }));
  assert(claude, 'account/rateLimits/read includes Claude limits');
  assert.equal(claude.primary.usedPercent, 41);
  assert.equal(claude.secondary.usedPercent, 86);
  console.log('PASS /usage answer includes Claude subscription limits');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => usage.close());
