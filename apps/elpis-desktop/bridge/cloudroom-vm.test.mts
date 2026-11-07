// CloudRoom VM (1 Nov, Masih: "I asked if we can use cloud room's vms for our agents. that's it. I have a sub there.").
// A stand-in CloudRoom: its website redeems the sign-in (as cloudroom.dev's /api/desktop/redeem) and its core runs each
// vm/run command with bash in a private "VM home", so push, run and pull really move files. Never the real CloudRoom.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCloudroomVm, CloudroomError } from './cloudroom-vm.mts';
import { createWorkflowRuns } from './workflow-acp.mts';

const TEST_ROOT = path.join(os.homedir(), '.cache/elpis-tests'); fs.mkdirSync(TEST_ROOT, { recursive: true });
const FAKE_ACP = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const TOKEN = `core-${randomBytes(24).toString('hex')}`;
const SANDBOX = randomBytes(32).toString('hex');
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', email: 'masih@example.com' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The VM's agent CLIs. Claude: prompt on stdin, answer on stdout. Codex: `exec -o FILE -`, answer in FILE.
const CLAUDE = `#!/bin/sh
if [ "$1" = auth ]; then exit 1; fi
prompt=$(cat)
echo "$@" > "$HOME/claude-args"
case "$prompt" in *'"passed"'*) echo '{"passed":true,"summary":"Checked on the VM"}'; exit 0;; esac
case "$prompt" in *'[fail]'*) echo 'boom on the vm' >&2; exit 3;; *'[login]'*) echo 'Invalid API key · Please run /login' >&2; exit 1;; esac
mkdir -p src && echo "made on the VM" > src/vm.txt && echo "changed on the VM" > src/seed && rm -f src/gone
echo "Claude on the VM did it"
`;
const CODEX = `#!/bin/sh
if [ "$1" = login ]; then [ -n "$FAKE_CODEX_LOGIN" ]; exit $?; fi
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > /dev/null; echo "Codex on the VM did it" > "$out"
`;

/** `asleep`: how many vm/run requests answer 503 first. `bins`: which CLIs the VM has. */
async function fakeCloudroom(t: TestContext, { asleep = 0, bins = ['claude', 'codex'], codexLogin = false, sandboxOnly = false, maxOutput = 16 * 1024 * 1024 } = {}) {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'cloudroom-test-'));
  const vmHome = path.join(root, 'vm'), elpisHome = path.join(root, 'elpis');
  fs.mkdirSync(path.join(vmHome, '.local/bin'), { recursive: true }); fs.mkdirSync(elpisHome);
  for (const name of bins) fs.writeFileSync(path.join(vmHome, '.local/bin', name), name === 'claude' ? CLAUDE : CODEX, { mode: 0o755 });
  const seen: { redeems: { verifier: string; code: string }[]; runs: { command: string; cwd?: string; stdin?: string }[]; wakes: { thread: string; action: string }[]; sleeping: number; auth: (string | string[] | undefined)[][]; signOuts: number; pendingChallenge?: { challenge: string | null; code: string } } = { redeems: [], runs: [], wakes: [], sleeping: asleep, auth: [], signOuts: 0 };
  const body = (request: http.IncomingMessage) => new Promise<string>(resolve => { const chunks: Buffer[] = []; request.on('data', c => chunks.push(c)); request.on('end', () => resolve(Buffer.concat(chunks).toString())); });
  const coreServer = http.createServer((request, response) => { void (async () => {
    const raw = await body(request);
    if (request.url !== '/v1/vm/run' || request.method !== 'POST') { response.writeHead(404); return response.end('{}'); }
    seen.auth.push([request.headers.authorization, request.headers['x-cloudroom-token']]);
    if (request.headers.authorization !== `Bearer ${TOKEN}` || request.headers['x-cloudroom-token'] !== TOKEN) { response.writeHead(401); return response.end(JSON.stringify({ error: `bad token ${request.headers.authorization}` })); }
    if (seen.sleeping > 0) { seen.sleeping--; response.writeHead(503); return response.end('waking'); }
    const input = JSON.parse(raw); seen.runs.push(input);
    // PATH without the host's own CLIs: only the VM's ~/.local/bin ones exist.
    const child = spawn('bash', ['-c', input.command], { cwd: path.join(vmHome, input.cwd ?? ''), env: { HOME: vmHome, PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: 'vm-login', ...(codexLogin ? { FAKE_CODEX_LOGIN: '1' } : {}) } });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', c => out.push(c)); child.stderr.on('data', c => err.push(c));
    child.stdin.end(Buffer.from(input.stdin ?? '', 'hex'));
    child.on('close', code => {
      const stdout = Buffer.concat(out);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code, stdout: stdout.subarray(0, maxOutput).toString('hex'), stderr: Buffer.concat(err).toString('hex'), truncated: stdout.length > maxOutput }));
    });
  })(); });
  const website = http.createServer((request, response) => { void (async () => {
    const raw = await body(request), json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/api/desktop/redeem') {
      const input = JSON.parse(raw); seen.redeems.push(input);
      const pending = seen.pendingChallenge;
      if (!pending || createHash('sha256').update(input.verifier).digest('hex') !== pending.challenge || input.code !== pending.code) return json(401, { error: 'no' });
      return json(200, { account: ACCOUNT, ...(sandboxOnly ? {} : { connection: { url: core, token: TOKEN } }), sandboxes: { token: SANDBOX } });
    }
    if (request.url === '/api/desktop/sandboxes') {
      if (request.headers.authorization !== `Basic ${Buffer.from(`${ACCOUNT.id}:${SANDBOX}`).toString('base64')}`) return json(401, {});
      const input = JSON.parse(raw); seen.wakes.push(input);
      return seen.wakes.length < 2 ? json(200, { thread: input.thread, state: 'asleep', generation: 0, issue: null }) : json(200, { thread: input.thread, state: 'awake', generation: 1, issue: null, origin: core, token: TOKEN });
    }
    if (request.url === '/api/desktop/sign-out') { seen.signOuts++; return json(200, {}); }
    json(404, {});
  })(); });
  const listen = (server: http.Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)));
  const core = await listen(coreServer); const site = await listen(website);
  // Everything this process prints is kept, to prove no token reaches a log.
  const printed: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, write: process.stderr.write.bind(process.stderr), out: process.stdout.write.bind(process.stdout) };
  for (const name of ['log', 'error', 'warn'] as const) console[name] = (...args) => { printed.push(args.join(' ')); };
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { printed.push(String(chunk)); return (originals.write as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { printed.push(String(chunk)); return (originals.out as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  const vm = createCloudroomVm({ home: elpisHome, website: site, wakeWaitMs: 3000, retryMs: 20, pollMs: 20, pieceBytes: 64 * 1024, maxTransferBytes: 4 * 1024 * 1024, tmpDir: path.join(root, 'tmp') });
  t.after(async () => {
    Object.assign(console, { log: originals.log, error: originals.error, warn: originals.warn }); process.stderr.write = originals.write; process.stdout.write = originals.out;
    vm.close(); coreServer.closeAllConnections(); website.closeAllConnections(); coreServer.close(); website.close();
    execFileSync('gio', ['trash', root]);
  });
  /** What his browser does: open the page CloudRoom would show, which returns to Elpis's callback with a code. */
  async function browserSignIn(started: { url: string }) {
    const url = new URL(started.url), callback = url.searchParams.get('callback'), code = randomBytes(32).toString('hex');
    seen.pendingChallenge = { challenge: url.searchParams.get('challenge'), code };
    const answer = await fetch(`${callback}?${new URLSearchParams({ state: url.searchParams.get('state')!, code })}`);
    return { status: answer.status, page: await answer.text(), url };
  }
  const signedIn = async () => { const back = await browserSignIn(await vm.signIn()); assert.equal(back.status, 200, back.page); };
  return { root, vmHome, elpisHome, vm, seen, printed, site, browserSignIn, signedIn };
}
/** Every file under `dir` but these test folders, as text: where a token must never be. */
const everything = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(name => path.join(dir, name as string)).filter(file => fs.statSync(file).isFile()).map(file => fs.readFileSync(file, 'latin1')).join('\n');

test('sign-in opens CloudRoom, redeems the code with its verifier and keeps the token private and out of every log', async t => {
  const f = await fakeCloudroom(t);
  assert.equal((await f.vm.status()).signedIn, false);
  const started = await f.vm.signIn();
  const url = new URL(started.url);
  assert.equal(`${url.origin}${url.pathname}`, `${f.site}/desktop`);
  assert.match(url.searchParams.get('callback')!, /^http:\/\/127\.0\.0\.1:\d+\/cloudroom\/return$/);
  assert.match(url.searchParams.get('state')!, /^[a-f0-9]{64}$/);
  assert.equal((await f.vm.status()).signingIn, true);
  // A callback with the wrong state is refused and redeems nothing.
  const wrong = await fetch(`${url.searchParams.get('callback')}?state=${'0'.repeat(64)}&code=${'1'.repeat(64)}`);
  assert.equal(wrong.status, 400); assert.equal(f.seen.redeems.length, 0);
  const back = await f.browserSignIn(started);
  assert.equal(back.status, 200); assert.match(back.page, /Signed in as masih@example\.com/);
  assert.equal(f.seen.redeems.length, 1);
  assert.equal(createHash('sha256').update(f.seen.redeems[0]!.verifier).digest('hex'), url.searchParams.get('challenge'));
  const status = await f.vm.status();
  assert.deepEqual({ signedIn: status.signedIn, email: status.email, kind: status.kind, signingIn: status.signingIn }, { signedIn: true, email: 'masih@example.com', kind: 'vm', signingIn: false });
  assert.equal(JSON.stringify(status).includes(TOKEN), false, 'status never carries the token');
  const file = path.join(f.elpisHome, 'cloudroom.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only, as provider keys');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).connection.token, TOKEN);
  // The one-use callback is gone.
  await assert.rejects(fetch(url.searchParams.get('callback')!));
  // A VM error that echoes the token is redacted before it leaves the module.
  await assert.rejects(f.vm.pull(`~/${TOKEN}`, path.join(f.root, 'nowhere')), error => (error as CloudroomError).code === 'vm_error' && !(error as CloudroomError).message.includes(TOKEN) && (error as CloudroomError).message.includes('…'));
  assert.equal((await f.vm.run('echo hi')).stdout.toString(), 'hi\n');
  assert.deepEqual(f.seen.auth.at(-1), [`Bearer ${TOKEN}`, TOKEN]);
  await f.vm.signOut();
  assert.equal(fs.existsSync(file), false);
  assert.equal((await f.vm.status()).signedIn, false);
  await assert.rejects(f.vm.run('true'), error => (error as CloudroomError).code === 'not_signed_in' && /Sign in to CloudRoom/.test((error as CloudroomError).message));
  await pause(50); assert.equal(f.seen.signOuts, 1, 'the website is told to forget the sandbox token');
  const logs = f.printed.join('\n') + everything(path.join(f.elpisHome));
  for (const secret of [TOKEN, SANDBOX]) assert.equal(logs.includes(secret), false, 'no token in any log or Elpis file after sign-out');
});

test('push, run and pull round-trip a folder in pieces under the per-transfer limit', async t => {
  const f = await fakeCloudroom(t); await f.signedIn();
  const local = path.join(f.root, 'local'); fs.mkdirSync(path.join(local, 'sub'), { recursive: true });
  const big = randomBytes(300 * 1024); // incompressible: about five 64 KiB pieces
  fs.writeFileSync(path.join(local, 'big.bin'), big); fs.writeFileSync(path.join(local, 'sub/a.txt'), 'hello');
  const sent = await f.vm.push(local, '~/work');
  assert.ok(sent.pieces >= 4, `pushed in ${sent.pieces} pieces`);
  const largest = Math.max(...f.seen.runs.map(run => run.stdin!.length / 2));
  assert.ok(largest <= 64 * 1024, 'no request carries more than one piece');
  assert.deepEqual(fs.readFileSync(path.join(f.vmHome, 'work/big.bin')), big);
  const ran = await f.vm.run('cat sub/a.txt && echo " world" >> sub/a.txt', { cwd: 'work' });
  assert.equal(ran.code, 0); assert.equal(ran.stdout.toString(), 'hello');
  assert.equal((await f.vm.run('cat', { stdin: 'piped' })).stdout.toString(), 'piped');
  const back = path.join(f.root, 'back');
  const got = await f.vm.pull('~/work', back);
  assert.ok(got.pieces >= 4, `pulled in ${got.pieces} pieces`);
  assert.deepEqual(fs.readFileSync(path.join(back, 'work/big.bin')), big);
  assert.equal(fs.readFileSync(path.join(back, 'work/sub/a.txt'), 'utf8'), 'hello world\n');
  assert.equal(fs.readdirSync(path.join(f.vmHome, '.cache/elpis')).length, 0, 'temporary archives are removed on the VM');
});

test('errors: not signed in, VM asleep then waking, still asleep, CLI missing or signed out, transfer too big', async t => {
  const f = await fakeCloudroom(t, { asleep: 2, bins: ['claude'], maxOutput: 32 * 1024 });
  await assert.rejects(f.vm.push(f.root, '~/x'), error => (error as CloudroomError).code === 'not_signed_in');
  await assert.rejects(f.vm.runAgent({ localDir: f.root, key: 'k', provider: 'claude', prompt: 'x' }), error => (error as CloudroomError).code === 'not_signed_in');
  await f.signedIn();
  // Waking: two 503s, then it answers.
  assert.equal((await f.vm.run('echo up')).stdout.toString(), 'up\n');
  f.seen.sleeping = 1000;
  await assert.rejects(f.vm.run('true'), error => (error as CloudroomError).code === 'vm_asleep' && /asleep or still waking/.test((error as CloudroomError).message) && (error as CloudroomError).status === 503);
  const asleepStatus = await f.vm.status({ check: true });
  assert.ok('vm' in asleepStatus);
  assert.equal(asleepStatus.vm.state, 'asleep');
  f.seen.sleeping = 0;
  const status = await f.vm.status({ check: true });
  assert.ok('vm' in status);
  assert.deepEqual(status.vm, { state: 'awake', claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } });
  const local = path.join(f.root, 'proj'); fs.mkdirSync(local); fs.writeFileSync(path.join(local, 'a'), 'a');
  await assert.rejects(f.vm.runAgent({ localDir: local, key: 'codex', provider: 'openai', model: 'gpt-5.5', prompt: 'x' }), error => (error as CloudroomError).code === 'cli_missing' && /Codex is not installed/.test((error as CloudroomError).message));
  await assert.rejects(f.vm.runAgent({ localDir: local, key: 'agy', provider: 'agy', model: 'agy/gemini', prompt: 'x' }), error => (error as CloudroomError).code === 'cli_missing');
  await assert.rejects(f.vm.runAgent({ localDir: local, key: 'login', provider: 'claude', prompt: '[login]' }), error => (error as CloudroomError).code === 'cli_signed_out');
  await assert.rejects(f.vm.runAgent({ localDir: local, key: 'fail', provider: 'claude', prompt: '[fail]' }), error => (error as CloudroomError).code === 'agent_failed' && /boom on the vm/.test((error as CloudroomError).message));
  fs.writeFileSync(path.join(local, 'huge.bin'), randomBytes(5 * 1024 * 1024));
  const before = f.seen.runs.length;
  await assert.rejects(f.vm.push(local, '~/huge'), error => (error as CloudroomError).code === 'too_big' && (error as CloudroomError).status === 413 && /too big/.test((error as CloudroomError).message));
  assert.ok(f.seen.runs.slice(before).every(run => !run.stdin), 'nothing was sent once it was known to be too big');
  // A reply the core cut short (its 16 MiB cap; here 32 KiB) is too big as well.
  fs.writeFileSync(path.join(f.vmHome, 'noise.bin'), randomBytes(50 * 1024));
  await assert.rejects(f.vm.pull('~/noise.bin', path.join(f.root, 'noise')), error => (error as CloudroomError).code === 'too_big');
  // A token CloudRoom no longer accepts.
  const saved = JSON.parse(fs.readFileSync(path.join(f.elpisHome, 'cloudroom.json'), 'utf8')); saved.connection.token = 'x'.repeat(40);
  fs.writeFileSync(path.join(f.elpisHome, 'cloudroom.json'), JSON.stringify(saved), { mode: 0o600 });
  await assert.rejects(f.vm.run('true'), error => (error as CloudroomError).code === 'not_signed_in' && /Sign in again/.test((error as CloudroomError).message));
  assert.equal(f.printed.join('\n').includes(TOKEN), false);
});

test('a sandbox-only account wakes its Elpis thread’s sandbox on the website before running', async t => {
  const f = await fakeCloudroom(t, { sandboxOnly: true });
  await f.signedIn();
  assert.equal((await f.vm.status()).kind, 'sandbox');
  assert.equal((await f.vm.run('echo woke')).stdout.toString(), 'woke\n');
  assert.equal(f.seen.wakes.length, 2, 'asleep, then awake');
  assert.match(f.seen.wakes[0]!.thread, /^thr_[2-9a-km-z]{10}$/); assert.equal(f.seen.wakes[0]!.action, 'wake');
});

test('a workflow agent runs on the VM: worktree pushed, Claude Code run there, changes and deletions pulled back; the Mother merges here', { timeout: 30000 }, async t => {
  const f = await fakeCloudroom(t, { codexLogin: true }); await f.signedIn();
  const cwd = path.join(f.root, 'project'); fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@elpis.local', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); fs.writeFileSync(path.join(cwd, 'src/seed'), 'base'); fs.writeFileSync(path.join(cwd, 'src/gone'), 'old'); git('add', 'src'); git('commit', '-qm', 'base');
  const local: string[] = [];
  const runs = createWorkflowRuns({ stateDir: path.join(f.root, 'state'), timeoutMs: 20000, cloudroom: /** @type {NonNullable<NonNullable<Parameters<typeof createWorkflowRuns>[0]>['cloudroom']>} */ (/** @type {unknown} */ (f.vm)),
    // Only the Mother may start an ACP agent on this computer; any other local agent fails the test.
    nodeSpec: node => { local.push(node.name); return { name: node.name, command: process.execPath, args: [FAKE_ACP], env: { FAKE_ACP_NAME: node.name, FAKE_ACP_EFFORTS: 'low,high', FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Reviewed the VM work here' }) } }; } });
  t.after(() => runs.close());
  const tasks = [
    { id: 'writer', title: 'Writer', kind: 'implement', instruction: 'Write on the VM', dependsOn: [], writeScopes: ['src'], acceptanceCriteria: ['src/vm.txt exists'], model: 'claude/sonnet', provider: 'claude' },
    { id: 'writer-check', title: 'Check: Writer', kind: 'verify', instruction: 'Check it', dependsOn: ['writer'], writeScopes: [], acceptanceCriteria: ['src/vm.txt exists'], model: 'claude/sonnet', provider: 'claude' },
    { id: 'reader', title: 'Reader', kind: 'explore', instruction: 'Look', dependsOn: [], writeScopes: [], acceptanceCriteria: ['An answer'], model: 'gpt-5.5', provider: 'openai' },
  ];
  const started = await runs.start({ rootThreadId: 'root', name: 'VM team', tasks, maxConcurrency: 2, isolation: 'worktree', autoMerge: true, runsOn: 'cloudroom' }, { cwd, model: 'm', modelProvider: 'openai' });
  let record;
  for (let n = 0; n < 1000; n++) { record = (await runs.list()).find(run => run.id === started.graphId); if (record && record.status !== 'running') break; await pause(20); }
  assert.ok(record);
  assert.equal(record.status, 'succeeded', record.error ?? JSON.stringify(record.tasks.map(task => [task.id, task.failureReason])));
  assert.deepEqual(local, ['Mother agent'], 'every child ran on the VM; only the Mother ran here');
  const writer = record.tasks.find(task => task.id === 'writer');
  assert.ok(writer); assert.ok(writer.result); assert.ok(writer.routing); assert.ok(writer.routing.attempts[0]);
  assert.match(writer.result.summary, /Claude on the VM did it/);
  assert.equal(writer.routing.attempts[0].runsOn, 'cloudroom');
  const reader = record.tasks.find(task => task.id === 'reader');
  assert.ok(reader); assert.ok(reader.result);
  assert.match(reader.result.summary, /Codex on the VM did it/);
  assert.equal(fs.readFileSync(path.join(f.vmHome, 'claude-args'), 'utf8').trim(), '-p --dangerously-skip-permissions --output-format text --model sonnet');
  // The changes reached the project through the local review and merge.
  assert.ok(record.review);
  assert.equal(record.review.status, 'merged');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/vm.txt'), 'utf8'), 'made on the VM\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/seed'), 'utf8'), 'changed on the VM\n');
  assert.equal(fs.existsSync(path.join(cwd, 'src/gone')), false, 'a file the agent deleted on the VM is deleted here');
  assert.equal(fs.existsSync(path.join(f.vmHome, 'elpis-runs')) && fs.readdirSync(path.join(f.vmHome, 'elpis-runs')).length, 0, 'the VM copies are removed');
  assert.equal(f.printed.join('\n').includes(TOKEN), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'state', `${record.id}.json`), 'utf8').includes(TOKEN), false, 'the run record holds no token');
});

test('a VM run refuses to start when CloudRoom is not signed in', async t => {
  const f = await fakeCloudroom(t);
  const runs = createWorkflowRuns({ stateDir: path.join(f.root, 'state'), cloudroom: /** @type {NonNullable<NonNullable<Parameters<typeof createWorkflowRuns>[0]>['cloudroom']>} */ (/** @type {unknown} */ (f.vm)) });
  t.after(() => runs.close());
  const cwd = path.join(f.root, 'p'); fs.mkdirSync(cwd);
  await assert.rejects(runs.start({ rootThreadId: 'root', name: 'x', tasks: [{ id: 'a', title: 'a', kind: 'explore', instruction: 'x', dependsOn: [], writeScopes: [], acceptanceCriteria: ['x'] }], runsOn: 'cloudroom' }, { cwd }),
    error => (error as CloudroomError).code === 'not_signed_in');
  assert.deepEqual(await runs.list(), []);
});
