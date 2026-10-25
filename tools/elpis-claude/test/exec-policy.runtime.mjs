// Installed native engine, local model, private HOME. Verifies that the launcher flags
// really change native turn contexts, including a legacy resume and an automatic child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('headless native turns and old resumes use the shared default; a child never asks', { skip: !process.env.ELPIS_TEST_ENGINE, timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/exec-native-'));
  const home = path.join(root, 'elpis'), work = path.join(root, 'work'); await fs.mkdir(home); await fs.mkdir(work);
  const mock = spawn(process.execPath, [new URL('./mock-responses.mjs', import.meta.url).pathname, '0', root], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { mock.kill('SIGTERM'); await run('gio', ['trash', root]); });
  let output = ''; mock.stdout.on('data', b => { output += b; });
  const deadline = Date.now() + 10000;
  while (!/listening (\d+)/.test(output)) { assert.ok(Date.now() < deadline, 'local model started'); await new Promise(r => setTimeout(r, 10)); }
  const config = approval => `model="gpt-5.5"\nmodel_provider="mock"\ndefault_permissions=":danger-full-access"\n${approval ? `approval_policy="${approval}"\n` : ''}[features]\nhooks=false\n[model_providers.mock]\nname="Mock"\nbase_url="http://127.0.0.1:${/listening (\d+)/.exec(output)[1]}/v1"\nwire_api="responses"\n`;
  await fs.writeFile(path.join(home, 'config.toml'), config(null));
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: home, CODEX_HOME: home, ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE };
  const turn = async (fixed, args, extra = {}) => {
    const result = fixed ? run(process.execPath, [new URL('../exec-policy.mjs', import.meta.url).pathname, ...args], { env: { ...env, ...extra }, timeout: 30000 }) : run(process.env.ELPIS_TEST_ENGINE, args, { env, timeout: 30000 });
    result.child.stdin.end();
    const { stdout } = await result;
    return stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'thread.started').thread_id;
  };
  const settings = async id => {
    const file = (await fs.readdir(path.join(home, 'sessions'), { recursive: true })).find(name => name.endsWith(`${id}.jsonl`));
    const rows = (await fs.readFile(path.join(home, 'sessions', file), 'utf8')).trim().split('\n').map(JSON.parse);
    const ctx = rows.filter(row => row.type === 'turn_context').at(-1).payload;
    return [ctx.approval_policy, ctx.active_permission_profile?.id];
  };
  const base = await turn(false, ['exec', '--skip-git-repo-check', '-C', work, '--json', '-c', 'approval_policy="on-request"', 'legacy permission context']);
  const legacyFile = (await fs.readdir(path.join(home, 'sessions'), { recursive: true })).find(name => name.endsWith(`${base}.jsonl`));
  const legacyPath = path.join(home, 'sessions', legacyFile);
  const legacy = (await fs.readFile(legacyPath, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const row of legacy) if (row.type === 'turn_context') row.payload.approval_policy = 'on-request';
  await fs.writeFile(legacyPath, legacy.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(await settings(base), ['on-request', ':danger-full-access']);
  await fs.writeFile(path.join(home, 'config.toml'), config(null).replace('default_permissions=":danger-full-access"\n', ''));
  const fresh = await turn(true, ['exec', '--skip-git-repo-check', '-C', work, '--json', 'new headless turn']);
  assert.deepEqual(await settings(fresh), ['never', ':danger-full-access']);
  await turn(true, ['exec', 'resume', base, '--skip-git-repo-check', '--json', 'resume with the default']);
  assert.deepEqual(await settings(base), ['never', ':danger-full-access']);
  await fs.writeFile(path.join(home, 'config.toml'), config('on-request'));
  const child = await turn(true, ['exec', '--skip-git-repo-check', '-C', work, '--json', 'automatic child'], { CODEX_THREAD_ID: fresh });
  assert.deepEqual(await settings(child), ['never', ':danger-full-access']);
});
