// Real TUI acceptance. No credentials, inference, or local build.
// ELPIS_TUI_BINARY=/path/to/CI/elpis-next node scripts/check-a32-config-tui.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.ELPIS_TUI_BINARY;
assert(binary && path.isAbsolute(binary), 'Set ELPIS_TUI_BINARY to the installed or CI executable');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a32-tui-'));
const output = process.env.A32_EVIDENCE_DIR ?? path.join(home, 'evidence');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(home, 'elpis'));
fs.mkdirSync(path.join(home, 'work'));
fs.writeFileSync(path.join(home, 'elpis/config.toml'), 'model = "a32-offline"\nmodel_provider = "a32-local"\n[model_providers.a32-local]\nname = "A32 offline"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
const socket = `a32-${process.pid}`;
const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const server = spawn('tmux', ['-L', socket, '-D'], { stdio: 'ignore' });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const key = (...keys) => tmux('send-keys', '-t', 'config', ...keys);
const screen = () => tmux('capture-pane', '-pt', 'config');
const capture = name => { const text = screen(); fs.writeFileSync(path.join(output, `${name}.txt`), text); return text; };
async function until(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate(screen())) return; await delay(100); }
  throw Error(`Timed out; last screen:\n${screen()}`);
}
async function type(text) { key('-l', text); await delay(350); }
async function command(text) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (screen().includes('Lifecycle hooks from config')) { key('Escape'); await delay(250); }
    if (screen().includes('Hooks need review')) { key('Down'); key('Down'); key('Enter'); await delay(400); }
    key('C-u'); await type(text); key('Enter'); await delay(700);
    if (screen().includes('Settings  /config')) return;
  }
  throw Error(`Config did not open; last screen:\n${screen()}`);
}
const failures = [];
const check = (name, passed) => { if (!passed) failures.push(name); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); };
try {
  await delay(250);
  tmux('new-session', '-d', '-s', 'config', '-x', '100', '-y', '32', '-c', path.join(home, 'work'));
  const env = { HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'elpis'), ELPIS_NO_CLAUDE: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state') };
  key('-l', `env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${quote(binary)} --no-alt-screen`);
  key('Enter');
  await delay(1500);
  for (let index = 0; index < 60; index++) {
    const text = screen();
    if (text.includes('Hooks need review')) { key('Down'); key('Down'); key('Enter'); }
    else if (text.includes('Lifecycle hooks from config')) key('Escape');
    else if (text.includes('Ask Elpis')) break;
    await delay(200);
  }
  await until(text => text.includes('Ask Elpis'));
  await command('/config models');
  const models = capture('models');
  check('default model and effort are editable catalog items', models.includes('Default model') && models.includes('Default reasoning effort'));
  await type('Account');
  const account = capture('account');
  check('fast typing filters to Account', account.includes('Search: Account_'));
  check('account sign-in is reachable', account.includes('│Account') && !account.includes('outside this terminal panel'));
  key('Escape'); await delay(200);
  for (const section of ['permissions', 'context', 'connections', 'app', 'advanced', 'unknown-section']) {
    await command(`/config ${section}`); capture(section);
    if (section === 'advanced') check('Open config file is in the catalog', screen().includes('Open config file'));
    key('Escape'); await delay(200);
  }
  await command('/config permissions'); await type('Web search');
  if (screen().includes('│Web search')) {
    key('Enter'); await delay(200); key('C-u'); await type('banana'); key('Enter'); await delay(250);
    check('invalid value is refused with a reason', capture('invalid').includes('Choose one of'));
    check('invalid value does not reach disk', !fs.readFileSync(path.join(home, 'elpis/config.toml'), 'utf8').includes('banana'));
    key('C-u'); await type('cached'); key('Enter'); await until(text => text.includes('saved and re-read'));
    check('valid default is saved', fs.readFileSync(path.join(home, 'elpis/config.toml'), 'utf8').includes('web_search = "cached"'));
    key('Escape'); await command('/config permissions'); await type('Web search');
    check('reopened panel sees saved value', capture('reopened').includes('Value: cached'));
  } else { check('Web search default editor is reachable', false); }
  tmux('resize-window', '-t', 'config', '-x', '44', '-y', '24'); key('Tab'); await delay(300); capture('narrow');
  console.log(`Evidence: ${output}`);
  assert.deepEqual(failures, [], 'Real TUI acceptance failures');
} finally {
  try { tmux('kill-server'); } catch {}
  server.kill();
}
