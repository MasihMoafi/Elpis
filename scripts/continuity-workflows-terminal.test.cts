'use strict';
import type { ProviderApi } from './lib/mock-provider.cts';
type Thread = { id: string; cwd: string; rollout_path: string };

// Inherited review/worktree UI through the ordinary source launcher, real engine and Git.
// All inference is served on localhost. Requires Node with sqlite, tmux and bridge dependencies.
// Usage: node scripts/continuity-workflows-terminal.test.cjs /absolute/elpis [absolute/source/launcher]
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { DatabaseSync }: typeof import('node:sqlite') = require('node:sqlite');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const { Provider, message }: ProviderApi = require('./lib/mock-provider.cts');
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'provide an absolute engine path');
const launcher = process.argv[3] ?? path.resolve(__dirname, '../tools/elpis-claude/elpis-claude');
assert(path.isAbsolute(launcher), 'provide an absolute source launcher path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-wf-'));
const userHome = path.join(root, 'home'), home = path.join(userHome, '.elpis-next');
const cwd = path.join(userHome, 'source'), runtime = path.join(root, 'run');
for (const directory of [home, cwd, runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const socket = path.join(root, 'tmux.sock'), provider = new Provider(), checks: string[] = [];
const fixtureEnv = { PATH: process.env.PATH, HOME: userHome, ELPIS_HOME: home, CODEX_HOME: home,
  CODEX_AUTH_HOME: home, XDG_RUNTIME_DIR: runtime, TERM: 'xterm-256color', LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(userHome, '.gitconfig'),
  ELPIS_ENGINE_BIN: binary, ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1',
  ACP_ADAPTER: path.resolve(__dirname, 'permissions-bridge.test.cts'), PERMISSION_FIXTURE_ADAPTER: '1' };
const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (args: string[]) => ['env', '-i', ...Object.entries(fixtureEnv).map(([key, value]) => `${key}=${value}`), launcher, '--no-alt-screen', ...args].map(quote).join(' ');
const type = (text: string, target = 'test') => tmux('send-keys', '-t', target, '-l', text);
const key = (name: string, target = 'test') => tmux('send-keys', '-t', target, name);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const capture = (target = 'test') => tmux('capture-pane', '-p', '-t', target);
const pass = (label: string) => { checks.push(label); console.log(`PASS ${label}`); };
let original: Thread | undefined, forked: Thread | undefined, fresh: Thread | undefined, freshCheckout: string | undefined;
function threads() {
  const filename = fs.readdirSync(home).find(name => /^state_\d+\.sqlite$/.test(name));
  if (!filename) return [];
  const db = new DatabaseSync(path.join(home, filename), { readOnly: true });
  try { return db.prepare('SELECT id, cwd, rollout_path FROM threads').all() as Thread[]; }
  finally { db.close(); }
}
async function screenWhen(predicate: (screen: string) => unknown, label: string, target = 'test') {
  const deadline = Date.now() + 20000; let screen = '';
  while (Date.now() < deadline) {
    screen = capture(target);
    if (predicate(screen)) {
      fs.writeFileSync(path.join(root, `${label}.txt`), screen);
      fs.writeFileSync(path.join(root, `${label}.ansi`), tmux('capture-pane', '-p', '-e', '-t', target));
      return screen;
    }
    if (provider.error) throw provider.error;
    await pause(75);
  }
  fs.writeFileSync(path.join(root, `${label}.txt`), screen);
  throw Error(`Timed out: ${label}; evidence ${root}`);
}
async function submit(text: string, target = 'test') { type(text, target); await pause(200); key('Enter', target); }
async function ready(target = 'test') {
  await screenWhen(screen => {
    if (screen.includes('Hooks need review')) { key('Escape', target); return false; }
    return screen.includes('Elpis') && /gpt-5[.]5/i.test(screen) && !screen.includes('esc to interrupt');
  }, `${target}-startup`, target);
}
async function answer(prompt: string, marker: string, target = 'test') {
  const before = provider.requests.length;
  provider.actions.push(message(marker));
  await submit(prompt, target);
  await screenWhen(screen => provider.requests.length > before && screen.includes(marker) && !screen.includes('esc to interrupt'), marker, target);
  assert.equal(provider.requests.length, before + 1, 'one fixture request per ordinary turn');
  const request = provider.requests.at(-1); assert(request); return request.body;
}
const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
// A saved fork exists before the event loop attaches its widget. Wait for its native cwd confirmation, not only its DB row.
// The footer abbreviates home; the successful attachment notice shows the absolute path when the footer is truncated.
const showsDirectory = (screen: string, directory: string) => screen.includes(directory) || directory.startsWith(`${userHome}${path.sep}`) && screen.includes(`~${directory.slice(userHome.length)}`);
async function reviewMenu(label: string) {
  await submit('/review');
  return screenWhen(screen => ['Select a review preset', 'Review against a base branch', 'Review uncommitted changes', 'Review a commit', 'Custom review instructions'].every(text => screen.includes(text)), label);
}
async function worktreeMenu(label: string) {
  await submit('/worktree');
  return screenWhen(screen => ['Worktrees', 'Continue current conversation', 'Start new conversation', 'Browse worktrees'].every(text => screen.includes(text)), label);
}

(async () => {
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'COMMITTED_BASELINE\n');
  git('add', 'tracked.txt'); git('commit', '-m', 'Fixture baseline');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'UNCOMMITTED_SOURCE_MARKER\n');
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'UNTRACKED_SOURCE_MARKER\n');
  const initialHead = git('rev-parse', 'HEAD'), initialStatus = git('status', '--porcelain');
  assert.equal(git('remote'), '', 'fixture has no remotes');
  await provider.start();
  const model = require('../codex-rs/models-manager/models.json').models.find((model: { slug: string }) => model.slug === 'gpt-5.5');
  assert(model, 'fixture model must exist');
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}'); // Keep optional RTK onboarding out of this workflow fixture.
  const catalog = path.join(home, 'models.json');
  fs.writeFileSync(catalog, JSON.stringify({ models: [model] }));
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(catalog)}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\nworktrees=true\n[model_providers.fixture]\nname="Workflow fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\n[projects.${JSON.stringify(userHome)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  tmux('new-session', '-d', '-s', 'test', '-x', '110', '-y', '46', command(['-C', cwd]));
  await ready();
  await answer('SOURCE_CONVERSATION_TOKEN: retain this conversation when I choose a fork.', 'SOURCE_READY');
  original = threads().find(thread => thread.cwd === cwd);
  assert(original, 'source thread saved');
  const sourceThread = original;
  type('/rev');
  await screenWhen(screen => screen.includes('/review') && screen.includes('review my current changes'), 'review-discoverable');
  key('C-u');
  await reviewMenu('review-presets');
  key('Enter');
  await screenWhen(screen => screen.includes('Select a base branch') && screen.includes('main'), 'review-branches');
  key('Escape');
  await screenWhen(screen => screen.includes('Select a review preset'), 'review-parent-restored');
  key('Down'); key('Down'); key('Enter');
  await screenWhen(screen => screen.includes('Select a commit to review') && screen.includes('Fixture baseline'), 'review-commits');
  key('Escape');
  await screenWhen(screen => screen.includes('Select a review preset'), 'review-parent-after-commit');
  key('Down'); key('Enter');
  await screenWhen(screen => screen.includes('Custom review instructions') && screen.includes('Type instructions and press Enter'), 'review-custom');
  key('Escape'); key('Escape');
  pass('review is discoverable with all four inherited presets and native child pickers');
  await reviewMenu('review-run');
  const beforeReview = provider.requests.length;
  provider.actions.push(message(JSON.stringify({ findings: [], overall_correctness: 'patch is correct', overall_explanation: 'REVIEW_FIXTURE_COMPLETE', overall_confidence_score: 1 })));
  key('Down'); key('Enter');
  await screenWhen(screen => provider.requests.length > beforeReview && screen.includes('Code review finished') && !screen.includes('esc to interrupt'), 'review-completed');
  assert.equal(provider.requests.length, beforeReview + 1);
  const reviewRequest = provider.requests.at(-1); assert(reviewRequest);
  assert.match(JSON.stringify(reviewRequest.body), /review/i);
  pass('uncommitted review completes through the inherited provider review path');
  type('/work');
  await screenWhen(screen => screen.includes('/worktree') && screen.includes('start or continue a conversation'), 'worktree-discoverable');
  key('C-u');
  await worktreeMenu('worktree-presets');
  key('Enter'); // Continue current conversation.
  await screenWhen(screen => {
    forked = threads().find(thread => thread.id !== sourceThread.id && thread.cwd !== cwd && worktrees().includes(thread.cwd));
    return forked && showsDirectory(screen, forked.cwd) && !screen.includes('Continue current conversation') && !screen.includes('Creating worktree');
  }, 'fork-created');
  const savedFork = forked as Thread | undefined; assert(savedFork);
  assert.equal(worktrees().length, 2);
  assert(savedFork.cwd.startsWith(`${home}${path.sep}worktrees${path.sep}`), 'managed checkout stays in isolated home');
  const forkRequest = await answer('Confirm the fork is ready.', 'FORK_READY');
  assert(JSON.stringify(forkRequest).includes('SOURCE_CONVERSATION_TOKEN'), 'fork inherits the saved conversation');
  assert(JSON.stringify(forkRequest).includes(savedFork.cwd), 'fork request uses the new checkout');
  pass('worktree Continue creates a real checkout and preserves conversation in its new cwd');
  const beforeFresh = new Set(worktrees());
  await worktreeMenu('worktree-new'); key('Down'); key('Enter');
  await screenWhen(screen => {
    const checkouts = worktrees();
    freshCheckout = checkouts.find(directory => !beforeFresh.has(directory));
    return freshCheckout && checkouts.length === 3 && showsDirectory(screen, freshCheckout) && screen.includes('Ask Elpis to do anything') && !screen.includes('Start new conversation') && !screen.includes('Creating worktree');
  }, 'fresh-checkout-created');
  // Empty native threads materialize only on their first user message; check attachment before persistence.
  const freshRequest = await answer('NEW_CONVERSATION_ONLY: confirm this new checkout is ready.', 'FRESH_READY');
  await screenWhen(() => {
    fresh = threads().find(thread => thread.cwd === freshCheckout);
    return !!fresh;
  }, 'fresh-thread-persisted');
  assert(fresh, 'fresh thread is saved in a managed checkout');
  assert.equal(fresh.cwd, freshCheckout, 'the persisted thread belongs to the new checkout');
  assert.notEqual(fresh.cwd, savedFork.cwd);
  assert(JSON.stringify(freshRequest).includes(fresh.cwd), 'fresh request uses its own checkout');
  assert(!JSON.stringify(freshRequest).includes('SOURCE_CONVERSATION_TOKEN'), 'fresh conversation does not inherit source history');
  pass('worktree Start new creates a separate checkout with fresh conversation history');
  tmux('new-session', '-d', '-s', 'resumed', '-c', cwd, '-x', '110', '-y', '46', command(['resume', savedFork.id]));
  await screenWhen(screen => screen.includes('Working directory') && screen.includes('Use session directory'), 'resume-directory-picker', 'resumed');
  key('Enter', 'resumed'); // Native default: restore the saved session directory.
  await ready('resumed');
  // Replayed history can hide the cwd header; the next request verifies the exact saved cwd.
  await screenWhen(screen => screen.includes('FORK_READY') && screen.includes('Ask Elpis to do anything') && !screen.includes('esc to interrupt'), 'resumed-history-ready', 'resumed');
  const resumed = await answer('Confirm the resumed fork still has its context.', 'RESUME_READY', 'resumed');
  assert(JSON.stringify(resumed).includes('SOURCE_CONVERSATION_TOKEN'));
  assert(JSON.stringify(resumed).includes(savedFork.cwd), 'native directory choice restores the saved worktree cwd');
  assert.equal(threads().filter(thread => thread.cwd === savedFork.cwd).length, 1, 'resume reuses the original fork thread');
  assert.equal(worktrees().length, 3, 'resume does not create another worktree');
  pass('ordinary launcher resumes the saved worktree thread and its history');
  const beforeCli = new Set(worktrees());
  tmux('new-session', '-d', '-s', 'cli', '-c', cwd, '-x', '110', '-y', '46', command(['-C', cwd, '--worktree']));
  await ready('cli');
  let cliWorktree;
  await screenWhen(screen => {
    cliWorktree = worktrees().find(directory => !beforeCli.has(directory));
    return cliWorktree && showsDirectory(screen, cliWorktree);
  }, 'cli-checkout-attached', 'cli');
  const cliRequest = await answer('Confirm the command-line worktree is ready.', 'CLI_WORKTREE_READY', 'cli');
  const createdWorktree = cliWorktree as string | undefined;
  assert(createdWorktree && createdWorktree.startsWith(`${home}${path.sep}worktrees${path.sep}`));
  assert.equal(worktrees().length, 4, '--worktree creates one additional checkout');
  assert(JSON.stringify(cliRequest).includes(createdWorktree), 'command-line worktree uses the created checkout');
  assert(!JSON.stringify(cliRequest).includes('SOURCE_CONVERSATION_TOKEN'));
  pass('ordinary --worktree launch starts a fresh conversation in a real isolated checkout');
  assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'UNCOMMITTED_SOURCE_MARKER\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'untracked.txt'), 'utf8'), 'UNTRACKED_SOURCE_MARKER\n');
  assert.equal(git('status', '--porcelain'), initialStatus); assert.equal(git('rev-parse', 'HEAD'), initialHead);
  assert.equal(git('remote'), ''); assert(!provider.error, (provider.error as Error | undefined)?.message);
  pass('source checkout retains committed history and both uncommitted markers');
})().catch((error: Error) => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  try { tmux('kill-server'); } catch {}
  // Stop only the bridge whose PID and start token belong to this isolated home.
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.XDG_RUNTIME_DIR = runtime;
    const { runtimeDir, startToken } = await import('../tools/elpis-claude/shared-runtime.mjs');
    const stateFile = runtimeDir(home).state;
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (startToken(state.pid) === state.token) {
        process.kill(state.pid, 'SIGTERM');
        const deadline = Date.now() + 10000;
        while (startToken(state.pid) === state.token && Date.now() < deadline) await pause(50);
        assert.notEqual(startToken(state.pid), state.token, 'isolated bridge stopped');
      }
    }
  } finally {
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedRuntime;
    if (provider.server) provider.close();
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, original, forked, fresh, freshCheckout, requests: provider.requests, titleRequests: provider.titleRequests }, null, 2));
    console.log(`Evidence: ${root}`);
  }
});
