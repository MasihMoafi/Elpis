import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
const run = promisify(execFile);
if (process.env.ELPIS_POLICY_FIXTURE) {
  if (process.argv.includes('app-server')) readline.createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line); if (m.id === undefined) return;
    const result = m.method === 'config/read' ? { config: JSON.parse(process.env.POLICY_CONFIG) } : m.method === 'configRequirements/read' ? { requirements: JSON.parse(process.env.POLICY_REQUIREMENTS) } : {};
    process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
  });
  else process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\n');
} else test('headless launcher uses shared defaults, honors each explicit field and stops forbidden defaults', async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/exec-policy-'));
  t.after(() => run('gio', ['trash', root]));
  const engine = path.join(root, 'engine.mjs');
  await fs.writeFile(engine, `#!${process.execPath}\nprocess.env.ELPIS_POLICY_FIXTURE='1'; await import(${JSON.stringify(import.meta.url)});\n`, { mode: 0o755 });
  const invoke = async (config = {}, args = [], requirements = {}) => {
    const result = await run(process.execPath, [new URL('../exec-policy.mjs', import.meta.url).pathname, 'exec', ...args], { env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, ELPIS_ENGINE_BIN: engine, POLICY_CONFIG: JSON.stringify(config), POLICY_REQUIREMENTS: JSON.stringify(requirements) } });
    return JSON.parse(result.stdout);
  };
  const setting = (args, key) => args.find(arg => arg.startsWith(`${key}=`));
  const full = await invoke({ default_permissions: ':danger-full-access' });
  assert.equal(setting(full, 'approval_policy'), 'approval_policy="never"');
  assert.equal(setting(full, 'default_permissions'), 'default_permissions=":danger-full-access"');
  assert.equal(full.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  const ask = await invoke({ approval_policy: 'on-request', sandbox_mode: 'workspace-write' });
  assert.equal(setting(ask, 'approval_policy'), 'approval_policy="on-request"');
  assert.equal(setting(ask, 'default_permissions'), 'default_permissions=":workspace"');
  const scoped = await invoke({}, ['-s', 'read-only']);
  assert.equal(setting(scoped, 'approval_policy'), 'approval_policy="never"');
  assert.equal(setting(scoped, 'default_permissions'), undefined, 'an explicit scope wins over the default profile');
  const explicit = await invoke({}, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(explicit, ['exec', '--dangerously-bypass-approvals-and-sandbox']);
  assert.equal(setting(await invoke({}, ['--', 'approval_policy="on-request"']), 'approval_policy'), 'approval_policy="never"', 'prompt text cannot choose the permission mode');
  await fs.mkdir(path.join(root, 'permission-choices'));
  const id = '00000000-0000-0000-0000-000000000001';
  await fs.writeFile(path.join(root, 'permission-choices', `${id}.json`), JSON.stringify({ approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':workspace' }));
  assert.equal(setting(await invoke({}, ['resume', id]), 'approval_policy'), 'approval_policy="on-request"');
  await assert.rejects(invoke({}, [], { allowedSandboxModes: ['workspace-write'] }), /restricted by managed/);
});
