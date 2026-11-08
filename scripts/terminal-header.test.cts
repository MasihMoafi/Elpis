'use strict';
// Actual idle TUI: color motion with animations on, static header with them off.
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ProviderApi } from './lib/mock-provider.cts';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawn, execFileSync }: typeof import('node:child_process') = require('node:child_process');
const { Provider }: ProviderApi = require('./lib/mock-provider.cts');
const binaryArg = process.argv[2];
assert(binaryArg && path.isAbsolute(binaryArg), 'absolute runtime path required');
const binary = binaryArg;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-header-'));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function check(light: boolean, animated: boolean) {
  const directory = path.join(root, `${light ? 'light' : 'dark'}-${animated}`);
  const home = path.join(directory, 'home'), cwd = path.join(directory, 'project');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd);
  const provider = new Provider(), socket = path.join(directory, 'tmux');
  const tm = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = () => tm('capture-pane', '-p', '-e', '-t', 'test');
  let server: ChildProcessByStdio<null, Readable, Readable> | undefined, log = '';
  try {
    await provider.start();
    const catalog: { models: { slug: string }[] } = JSON.parse(fs.readFileSync(path.join(__dirname, '../codex-rs/models-manager/models.json'), 'utf8'));
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ models: catalog.models.filter(model => model.slug === 'gpt-5.5') }));
    fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Header fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nalternate_screen="always"\nfullscreen_transcript=true\nanimations=${animated}\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
    const vars = { CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home, ELPIS_SHARED_BRIDGE: '', ELPIS_BRIDGE_SOCKET: '', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const env: NodeJS.ProcessEnv = { ...process.env, ...vars }; delete env.NO_COLOR;
    server = spawn(binary, ['app-server', '--listen', 'ws://127.0.0.1:0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { log += data; });
    for (let attempt = 0; attempt < 100 && !/ws:\/\/127\.0\.0\.1:\d+/.test(log); attempt++) await pause(100);
    const address = log.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0]; assert(address, log);
    tm('new-session', '-d', '-s', 'test', '-x', '110', '-y', '38', 'bash --noprofile --norc');
    tm('set-option', '-p', '-t', 'test', 'window-style', light ? 'fg=#111111,bg=#ffffff' : 'fg=#eeeeee,bg=#111111');
    const command = ['env', '-u', 'NO_COLOR', ...Object.entries(vars).map(([key, value]) => key + '=' + value), binary, '--remote', address, '-C', cwd].map(quote).join(' ');
    tm('send-keys', '-t', 'test', '-l', command); tm('send-keys', '-t', 'test', 'Enter');
    for (let attempt = 0; attempt < 150; attempt++) {
      const screen = capture();
      if (screen.includes('Hooks need review')) tm('send-keys', '-t', 'test', 'Escape');
      if (screen.includes('Elpis') && screen.includes('MEMORY.md')) break;
      await pause(100);
    }
    const frames = [];
    for (let frame = 0; frame < 30; frame++) {
      frames.push(capture()); await pause(100);
    }
    fs.writeFileSync(path.join(directory, 'frames.json'), JSON.stringify(frames));
    const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');
    const headers = frames.map(screen => screen.split('\n').find(line => strip(line).includes('Elpis (v')));
    assert(headers.every((header): header is string => Boolean(header)), 'session header must remain visible');
    assert.equal(new Set(headers.map(strip)).size, 1, 'animation must preserve text and layout');
    const colors = new Set(headers).size;
    assert(animated ? colors > 1 : colors === 1, `${light ? 'light' : 'dark'} animated=${animated}: ${colors} header color frames`);
    assert.equal(provider.requests.length, 0, 'idle header must not invoke a model');
    return { light, animated, colorFrames: colors };
  } finally {
    try { tm('kill-server'); } catch {}
    provider.close();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      const running = server;
      await new Promise<void>(resolve => running.once('exit', () => resolve()));
    }
  }
}
(async () => {
  const checks = [];
  for (const light of [false, true]) for (const animated of [true, false]) checks.push(await check(light, animated));
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ binary, checks }, null, 2));
  console.log(JSON.stringify({ root, checks }));
})().catch(error => { console.error(root, error); process.exitCode = 1; });
