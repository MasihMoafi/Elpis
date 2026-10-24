import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loveNodeSpec } from './love-agents.mjs';
import { runAcpNode } from './acp-nodes.mjs';
const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));

test('Claude nodes use the account selected in Elpis and respect its sign-out', { timeout: 20000 }, async t => {
  const homeRoot = fs.mkdtempSync(path.join(os.homedir(), '.cache/elpis-briefs/cc/wfrun-account-'));
  const f = { home: homeRoot, cwd: homeRoot };
  t.after(() => execFileSync('gio', ['trash', homeRoot]));
  const install = path.join(f.home, 'installation'), tools = path.join(install, 'tools/elpis-claude'), engine = path.join(install, 'elpis');
  const adapter = path.join(tools, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
  fs.mkdirSync(path.dirname(adapter), { recursive: true }); fs.writeFileSync(engine, ''); fs.symlinkSync(FAKE, adapter);
  for (const file of ['claude-accounts.mjs', 'anthropic-signout.mjs']) fs.symlinkSync(fileURLToPath(new URL(`../../../tools/elpis-claude/${file}`, import.meta.url)), path.join(tools, file));
  const home = path.join(f.home, 'elpis'), state = path.join(home, 'elpis-claude'), id = '11111111-1111-1111-1111-111111111111';
  fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'claude-accounts.json'), JSON.stringify({ activeId: id, ids: [id] }));
  const env = { ELPIS_HOME: home, ELPIS_ENGINE_BIN: engine }, node = { name: 'Claude', prompt: 'Tiny task', model: 'claude/opus', provider: 'claude' };
  const spec = loveNodeSpec(node, env);
  spec.env = { ANTHROPIC_API_KEY: 'wrong-inherited-route', ...spec.env, FAKE_ACP_MODELS: 'opus', FAKE_ACP_EXPECT_ENV: JSON.stringify({ CLAUDE_CONFIG_DIR: path.join(state, 'claude-accounts', id), ANTHROPIC_API_KEY: null }) };
  assert.match((await runAcpNode(spec, { task: 'Account routing evidence' }, { cwd: f.cwd })).answer, /Account routing evidence/);
  fs.writeFileSync(path.join(state, 'anthropic.json'), JSON.stringify({ signedOut: true }));
  assert.throws(() => loveNodeSpec(node, env), /signed out/i);
});
