// Installed TUI under tmux, real native engine, local model. No Rust build.
// ELPIS_TEST_ENGINE=/runtime/elpis-next [ELPIS_TEST_TOOLS=/runtime/tools/elpis-claude] node --test test/full-access-tui.runtime.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const run = promisify(execFile);
const tools = process.env.ELPIS_TEST_TOOLS ?? new URL('../', import.meta.url).pathname;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('installed TUI follows shared defaults and keeps its own Ask choice across restart', { skip: !process.env.ELPIS_TEST_ENGINE, timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/full-access-tui-'));
  const home = path.join(root, 'elpis'), work = path.join(root, 'work'), output = process.env.ELPIS_TUI_EVIDENCE ?? root;
  await fs.mkdir(home); await fs.mkdir(work); await fs.mkdir(output, { recursive: true });
  const socketName = `elpis-full-${process.pid}`;
  const mock = spawn(process.execPath, [new URL('./mock-responses.mjs', import.meta.url).pathname, '0', root], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let mockOutput = ''; mock.stdout.on('data', b => { mockOutput += b; });
  const tmux = (...args) => run('tmux', ['-L', socketName, ...args]);
  let runtimeState;
  t.after(async () => {
    await tmux('capture-pane', '-pt', 'permissions').then(result => fs.writeFile(path.join(output, 'last-screen.txt'), result.stdout), () => {});
    await tmux('kill-server').catch(() => {}); mock.kill('SIGTERM');
    if (runtimeState) { try { const state = JSON.parse(await fs.readFile(runtimeState, 'utf8')); process.kill(state.pid, 'SIGTERM'); } catch {} }
    t.diagnostic(`Evidence: ${output}`);
  });
  const until = async (check, message) => { const end = Date.now() + 30000; for (;;) { if (await check()) return; assert.ok(Date.now() < end, message); await new Promise(r => setTimeout(r, 50)); } };
  await until(() => /listening (\d+)/.test(mockOutput), 'mock started');
  const configFile = path.join(home, 'config.toml');
  const config = approval => `model="gpt-5.5"\nmodel_provider="mock"\ndefault_permissions=":${approval === 'on-request' ? 'workspace' : 'danger-full-access'}"\n${approval ? `approval_policy="${approval}"\n` : ''}[features]\nhooks=false\n[model_providers.mock]\nname="Mock"\nbase_url="http://127.0.0.1:${/listening (\d+)/.exec(mockOutput)[1]}/v1"\nwire_api="responses"\n[projects.${JSON.stringify(work)}]\ntrust_level="trusted"\n`;
  await fs.writeFile(configFile, config(null));
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: home, CODEX_HOME: home, ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE, TERM: 'xterm-256color', ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1' };
  const started = await run(process.execPath, [path.join(tools, 'shared-runtime.mjs'), path.join(tools, 'acp-bridge.mjs')], { env, timeout: 30000 });
  const endpoint = started.stdout.trim().split('\n')[0];
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 16);
  runtimeState = path.join(os.tmpdir(), `elpis-bridge-${process.getuid()}`, hash, 'state.json');
  const tui = path.join(os.homedir(), '.local/bin/elpis');
  const launch = (args = []) => tmux('new-session', '-d', '-s', 'permissions', '-x', '110', '-y', '36', ['env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`), quote(tui), '--remote', quote(endpoint), '--no-alt-screen', '-C', quote(work), ...args.map(quote)].join(' '));
  await launch();
  const screen = async () => (await tmux('capture-pane', '-pt', 'permissions')).stdout;
  const key = (...keys) => tmux('send-keys', '-t', 'permissions', ...keys);
  const type = async text => { await tmux('set-buffer', '-b', 'input', text); await tmux('paste-buffer', '-p', '-b', 'input', '-t', 'permissions'); };
  const waitForApproval = file => until(async () => {
    assert.equal(await fs.stat(file).then(() => true, () => false), false, 'Ask command ran before approval');
    return /Would you like to run|Do you want to run/.test(await screen());
  }, 'Ask shows an approval request');
  await until(async () => {
    const text = await screen();
    if (/Hooks need review|Lifecycle hooks from config/.test(text)) { await key('Escape'); return false; }
    return /Ask Elpis/.test(text);
  }, 'TUI opened');
  const command = async name => {
    const file = path.join(root, name);
    await type(`PERMISSION_FILE:${file}`);
    await until(async () => (await screen()).includes(name), 'typed command appears');
    await key('Enter');
    await until(async () => fs.stat(file).then(() => true, () => false), `TUI ${name}: command runs without approval`);
    await until(async () => { const text = await screen(); return /Ask Elpis/.test(text) && !/esc to interrupt/i.test(text); }, 'the TUI turn finishes');
    const text = await screen(); await fs.writeFile(path.join(output, `${name}.txt`), text);
    assert.doesNotMatch(text, /Would you like to run|Do you want to run/);
  };
  await command('default-full');
  // Change the same config keys the desktop Settings writer saves, while the TUI stays open.
  await fs.writeFile(configFile, config('on-request'));
  const askFile = path.join(root, 'default-ask');
  await type(`PERMISSION_FILE:${askFile}`); await until(async () => (await screen()).includes('default-ask'), 'typed Ask command appears'); await key('Enter');
  await waitForApproval(askFile);
  await fs.writeFile(path.join(output, 'default-ask.txt'), await screen());
  await assert.rejects(fs.stat(askFile)); await key('Escape');
  await fs.writeFile(configFile, config('never'));
  await command('default-full-again');
  await type('/permissions'); await key('Enter');
  await until(async () => /Full access|Full Access/.test(await screen()), 'the TUI permission menu opens');
  await fs.writeFile(path.join(output, 'permission-menu.txt'), await screen());
  await key('Up', 'Up', 'Enter');
  await until(async () => !(await screen()).includes('Update Model Permissions'), 'Ask is selected');
  const asks = async name => {
    const file = path.join(root, name);
    await type(`PERMISSION_FILE:${file}`); await until(async () => (await screen()).includes(name), 'the command is typed'); await key('Enter');
    await waitForApproval(file);
    await assert.rejects(fs.stat(file)); await fs.writeFile(path.join(output, `${name}.txt`), await screen()); await key('Escape');
    await until(async () => /Ask Elpis/.test(await screen()), 'the denied turn ends');
  };
  await fs.writeFile(configFile, config('never'));
  await asks('explicit-ask');
  const choices = path.join(home, 'permission-choices');
  let id;
  for (const name of await fs.readdir(choices)) {
    const choice = JSON.parse(await fs.readFile(path.join(choices, name), 'utf8'));
    if (!choice.automatic && choice.approvalPolicy === 'on-request') id = name.slice(0, -5);
  }
  assert.ok(id, 'the TUI menu saved a chat choice');
  await tmux('kill-session', '-t', 'permissions');
  await launch(['resume', id]);
  await until(async () => /Ask Elpis/.test(await screen()), 'the saved chat reopens');
  await asks('restart-explicit-ask');
});
