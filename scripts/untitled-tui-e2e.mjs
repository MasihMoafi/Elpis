// Run with Node 22+: ELPIS_UNTITLED_TUI=/path/to/CI/elpis-next node scripts/untitled-tui-e2e.mjs
// Uses the installed engine unless ELPIS_UNTITLED_ENGINE names a CI engine.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const installed = path.join(os.homedir(), '.local/bin/elpis');
const tui = process.env.ELPIS_UNTITLED_TUI || installed;
const engine = process.env.ELPIS_UNTITLED_ENGINE || installed;
const evidence = path.resolve(process.env.ELPIS_UNTITLED_EVIDENCE
  || path.join(os.homedir(), '.cache/elpis-tests/untitled', `e2e-${Date.now()}`));
fs.mkdirSync(evidence, { recursive: true });
const home = fs.mkdtempSync('/tmp/ut-e2e-');
const work = path.join(home, 'work');
const elpis = path.join(home, 'elpis');
const socket = path.join(home, 'tmux.sock');
for (const dir of [work, elpis, path.join(home, 'runtime')]) fs.mkdirSync(dir, { mode: 0o700 });
const env = { ...process.env, HOME: home, ELPIS_HOME: elpis, CODEX_HOME: elpis,
  XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`,
  XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`,
  XDG_RUNTIME_DIR: `${home}/runtime`, ELPIS_NO_CLAUDE: '1', TERM: 'xterm-256color' };
fs.writeFileSync(path.join(elpis, 'config.toml'), `model = "gpt-5.4"
model_provider = "offline"
[model_providers.offline]
name = "Offline lifecycle check"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(work)}]
trust_level = "trusted"
`);
fs.writeFileSync(path.join(elpis, 'hooks.json'), '{"hooks":{}}\n');
const reserve = net.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const endpoint = `ws://127.0.0.1:${port}`;
const log = fs.openSync(path.join(evidence, 'engine.log'), 'w');
const child = spawn(engine, ['app-server', '--listen', endpoint], { env, cwd: work, stdio: ['ignore', log, log] });
const exited = new Promise(resolve => child.once('exit', resolve));
let ws;
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const capture = name => {
  const text = tmux('capture-pane', '-p', '-t', 'untitled');
  fs.writeFileSync(path.join(evidence, name), text);
  return text;
};
async function until(check, label) {
  for (let n = 0; n < 150; n++) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw Error(`Timed out: ${label}`);
}
try {
  ws = await until(async () => {
    const candidate = new WebSocket(endpoint);
    return new Promise(resolve => {
      candidate.onopen = () => resolve(candidate);
      candidate.onerror = () => { candidate.close(); resolve(null); };
    });
  }, 'real engine WebSocket');
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, response => { clearTimeout(timeout); resolve(response); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await request('initialize', { clientInfo: { name: 'untitled-e2e', version: '1' }, capabilities: { experimentalApi: true } });
  for (let n = 0; n < 3; n++) {
    const started = await request('thread/start', { cwd: work, model: 'gpt-5.4', modelProvider: 'offline' });
    assert.ok(started.result?.thread.id, JSON.stringify(started));
    const resume = await request('thread/resume', { threadId: started.result.thread.id });
    fs.appendFileSync(path.join(evidence, 'empty-resume.jsonl'), JSON.stringify(resume) + '\n');
    assert.match(resume.error?.message || '', /no rollout found for thread id/);
  }
  // A saved conversation, seeded in the same shape as app_test_support::create_fake_rollout.
  const id = randomUUID();
  const timestamp = new Date(Date.now() - 60000).toISOString();
  const date = timestamp.slice(0, 10);
  const dir = path.join(elpis, 'sessions', ...date.split('-'));
  fs.mkdirSync(dir, { recursive: true });
  const rollout = path.join(dir, `rollout-${date}T00-00-00-${id}.jsonl`);
  const title = 'Saved chat normal resume control';
  const records = [
    { type: 'session_meta', payload: { id, session_id: id, timestamp, cwd: work, originator: 'codex', cli_version: '0.0.0', source: 'cli', model_provider: 'offline' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: title, kind: 'plain' } },
  ];
  fs.writeFileSync(rollout, records.map(record => JSON.stringify({ timestamp, ...record })).join('\n') + '\n');
  const resumed = await request('thread/resume', { threadId: id, path: rollout, modelProvider: 'offline', model: 'gpt-5.4' });
  assert.equal(resumed.result?.thread.id, id, JSON.stringify(resumed));
  const command = ['env', ...Object.entries(env).filter(([key]) => ['HOME', 'ELPIS_HOME', 'CODEX_HOME', 'ELPIS_NO_CLAUDE', 'TERM'].includes(key) || key.startsWith('XDG_')).map(([key, value]) => `${key}=${value}`), tui, '--remote', endpoint, '-C', work, '--no-alt-screen', 'resume', id].map(quote).join(' ');
  tmux('new-session', '-d', '-s', 'untitled', '-x', '140', '-y', '42', command);
  await until(() => {
    const screen = capture('saved-chat.txt');
    if (screen.includes('Hooks need review')) tmux('send-keys', '-t', 'untitled', 'Escape');
    return screen.includes(title) && screen.includes('Ask Elpis to do anything');
  }, 'saved chat opens in installed/CI TUI');
  tmux('send-keys', '-t', 'untitled', '-l', '/agents');
  await pause(300); // Let the TUI distinguish typed input from a paste burst.
  tmux('send-keys', '-t', 'untitled', 'Enter');
  await until(() => capture('command-center.txt').includes('Agent command center'), 'command center opens');
  await pause(700);
  const screen = capture('command-center.txt');
  assert.ok(screen.includes(title), 'Saved chat must remain listed');
  assert.equal(screen.split('\n').filter(line => /● Untitled task.*Ready/.test(line)).length, 0,
    'Command center lists empty peer threads that cannot be opened');
  tmux('send-keys', '-t', 'untitled', 'Home', 'Enter');
  await until(() => {
    const screen = capture('reopened-chat.txt');
    return screen.includes(title) && screen.includes('Ask Elpis to do anything')
      && !screen.includes('Agent command center');
  }, 'saved chat reopens from command center');
  // Repeated fresh launches share the engine, but may retain only their own blank.
  const freshCommand = command.slice(0, command.lastIndexOf(` ${quote('resume')}`));
  for (let launch = 0; launch < 2; launch++) {
    tmux('kill-session', '-t', 'untitled');
    tmux('new-session', '-d', '-s', 'untitled', '-x', '140', '-y', '42', freshCommand);
    await until(() => capture(`fresh-${launch}.txt`).includes('Ask Elpis to do anything'), 'fresh TUI opens');
    tmux('send-keys', '-t', 'untitled', '-l', '/agents');
    await pause(300);
    tmux('send-keys', '-t', 'untitled', 'Enter');
    await until(() => capture(`fresh-center-${launch}.txt`).includes('Agent command center'), 'fresh overview opens');
    await pause(700);
    const fresh = capture(`fresh-center-${launch}.txt`);
    assert.ok(fresh.includes(title));
    assert.ok(fresh.split('\n').filter(line => /● Untitled task.*Ready/.test(line)).length <= 1,
      'Fresh launches must not accumulate peer startup drafts');
    tmux('send-keys', '-t', 'untitled', 'End', 'Enter');
    await until(() => {
      const reopened = capture(`fresh-reopened-${launch}.txt`);
      return reopened.includes(title) && reopened.includes('Ask Elpis to do anything')
        && !reopened.includes('Agent command center');
    }, 'saved chat opens from another active conversation');
  }
  console.log(`PASS: saved chat opens and reopens; repeated launches omit peer drafts. Evidence: ${evidence}`);
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'failure.txt'), `${error.stack}\n`);
  console.error(`Evidence: ${evidence}`);
  throw error;
} finally {
  try { tmux('kill-server'); } catch {}
  ws?.close();
  child.kill('SIGTERM');
  await Promise.race([exited, pause(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  fs.closeSync(log);
  try {
    execFileSync('gio', ['trash', home], { stdio: 'pipe' });
  } catch {
    // Sandbox /tmp can be an internal mount that GIO cannot trash directly.
    const parked = path.join(evidence, 'closed-home');
    execFileSync('mv', ['--', home, parked]);
    execFileSync('gio', ['trash', parked], {
      env: { ...process.env, XDG_DATA_HOME: path.join(path.dirname(evidence), 'trash-data') },
      stdio: 'pipe',
    });
  }
}
