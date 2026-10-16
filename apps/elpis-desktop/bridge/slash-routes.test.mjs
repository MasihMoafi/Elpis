// The engine calls behind /compact, /review and /diff: fixture socket and a real throwaway Git repository, no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';

const CHAT = '00000000-0000-0000-0000-0000000000a1';
const AGENT = '00000000-0000-0000-0000-0000000000a2';

function fixture({ cwd } = {}) {
  const threads = new Map([
    [CHAT, { id: CHAT, cwd, source: 'cli', canAcceptDirectInput: true, status: { type: 'idle' } }],
    [AGENT, { id: AGENT, cwd, source: { subAgent: { thread_spawn: { agent_path: '/root/helper' } } }, canAcceptDirectInput: false, status: { type: 'idle' } }],
  ]);
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => socket.emit('close');
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result;
    switch (request.method) {
      case 'initialize': result = { userAgent: 'slash-test' }; break;
      case 'thread/read': result = { thread: structuredClone(threads.get(request.params.threadId)) }; break;
      case 'thread/resume': result = { thread: structuredClone(threads.get(request.params.threadId)) }; break;
      case 'thread/compact/start': result = {}; break;
      case 'review/start': result = { turn: { id: 'review-turn', status: 'inProgress', items: [] }, reviewThreadId: request.params.threadId }; break;
      default: throw new Error(`Unexpected protocol method ${request.method}`);
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket);
  const calls = method => socket.sent.filter(message => message.method === method);
  return { client, socket, threads, calls };
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-slash-git-'));
  git(dir, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'first commit');
  git(dir, 'switch', '-q', '-c', 'feature');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n'); git(dir, 'commit', '-q', '-am', 'second commit');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree-uncommitted\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'brand-new-untracked\n');
  return dir;
}

test('compact starts the engine compaction, with the guidance as typed, only on an idle chat the app may write to', async () => {
  const { client, calls, threads } = fixture(); await client.initialize();
  try {
    await client.compact(CHAT, {});
    assert.deepEqual(calls('thread/compact/start').at(-1).params, { threadId: CHAT });
    await client.compact(CHAT, { instructions: 'Keep the API names.' });
    assert.deepEqual(calls('thread/compact/start').at(-1).params, { threadId: CHAT, instructions: 'Keep the API names.' });
    const sent = calls('thread/compact/start').length;
    await assert.rejects(client.compact(CHAT, { instructions: '   ' }), /instructions/);
    await assert.rejects(client.compact(CHAT, { extra: 1 }), /Unsupported request fields/);
    await assert.rejects(client.compact('not-an-id', {}), /Invalid thread ID/);
    threads.get(CHAT).status = { type: 'active' };
    await assert.rejects(client.compact(CHAT, {}), /Wait for the current turn/);
    await assert.rejects(client.compact(AGENT, {}), /parent/);
    assert.equal(calls('thread/compact/start').length, sent, 'a refused compaction reaches the engine never');
  } finally { client.close(); }
});

test('review starts the engine review inline for each of the terminal\'s targets, and refuses anything else', async () => {
  const { client, calls, threads } = fixture(); await client.initialize();
  try {
    const started = await client.review(CHAT, { target: { type: 'uncommittedChanges' } });
    assert.deepEqual(calls('review/start').at(-1).params, { threadId: CHAT, target: { type: 'uncommittedChanges' }, delivery: 'inline' });
    assert.equal(started.turn.id, 'review-turn');
    await client.review(CHAT, { target: { type: 'baseBranch', branch: 'main' } });
    assert.deepEqual(calls('review/start').at(-1).params.target, { type: 'baseBranch', branch: 'main' });
    await client.review(CHAT, { target: { type: 'commit', sha: 'abc1234', title: 'Fix the cache' } });
    assert.deepEqual(calls('review/start').at(-1).params.target, { type: 'commit', sha: 'abc1234', title: 'Fix the cache' });
    await client.review(CHAT, { target: { type: 'custom', instructions: 'Look at error handling.' } });
    assert.deepEqual(calls('review/start').at(-1).params.target, { type: 'custom', instructions: 'Look at error handling.' });
    const sent = calls('review/start').length;
    for (const target of [{ type: 'detached' }, { type: 'baseBranch' }, { type: 'baseBranch', branch: '--output=x' }, { type: 'commit', sha: 'not a sha' }, { type: 'custom', instructions: ' ' }, { type: 'uncommittedChanges', extra: 1 }, null])
      await assert.rejects(client.review(CHAT, { target }), /target|branch|commit|instructions|fields/i, JSON.stringify(target));
    await assert.rejects(client.review(CHAT, { target: { type: 'uncommittedChanges' }, delivery: 'detached' }), /Unsupported request fields/);
    threads.get(CHAT).status = { type: 'active' };
    await assert.rejects(client.review(CHAT, { target: { type: 'uncommittedChanges' } }), /Wait for the current turn/);
    await assert.rejects(client.review(AGENT, { target: { type: 'uncommittedChanges' } }), /parent/);
    assert.equal(calls('review/start').length, sent, 'a refused review reaches the engine never');
  } finally { client.close(); }
});

test('git choices and diff come from the chat\'s own folder: branches, recent commits, tracked and untracked changes', async () => {
  const dir = await repository(), plain = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-slash-plain-'));
  const { client, threads } = fixture({ cwd: dir }); await client.initialize();
  try {
    const choices = await client.git(CHAT, 'review');
    assert.deepEqual(choices.branches, ['feature', 'main']); assert.equal(choices.current, 'feature');
    assert.deepEqual(choices.commits.map(commit => commit.subject), ['second commit', 'first commit']);
    assert.match(choices.commits[0].sha, /^[0-9a-f]{40}$/);
    const { diff, truncated } = await client.git(CHAT, 'diff');
    assert.equal(truncated, false);
    assert.match(diff, /\+three-uncommitted/, 'tracked change'); assert.match(diff, /b\.txt/); assert.match(diff, /\+brand-new-untracked/, 'untracked file');
    assert.doesNotMatch(diff, /\+two\n/, 'committed changes are not part of the working diff');
    await assert.rejects(client.git(CHAT, 'other'), /view/);
    threads.get(CHAT).cwd = plain;
    await assert.rejects(client.git(CHAT, 'review'), /not a Git repository/);
    await assert.rejects(client.git(CHAT, 'diff'), /not a Git repository/);
    delete threads.get(CHAT).cwd;
    await assert.rejects(client.git(CHAT, 'diff'), /folder/);
  } finally { client.close(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(plain, { recursive: true, force: true }); }
});

test('a huge working diff is cut at a fixed size and says so', async () => {
  const dir = await repository(); await fs.writeFile(path.join(dir, 'huge.txt'), 'x'.repeat(2_000_000) + '\n');
  const { client } = fixture({ cwd: dir }); await client.initialize();
  try {
    const { diff, truncated } = await client.git(CHAT, 'diff');
    assert.equal(truncated, true); assert.ok(diff.length <= 400_000 + 200, `kept ${diff.length} characters`);
  } finally { client.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('HTTP: compact, review and git are routed, POST-only or GET-only, behind the session cookie', async t => {
  const dir = await repository();
  const { client, calls } = fixture({ cwd: dir }); await client.initialize();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-slash-out-')); await fs.writeFile(path.join(out, 'index.html'), '<h1>Elpis</h1>');
  const app = await startDesktopServer({ client, staticDir: out }); t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(out, { recursive: true, force: true }); });
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = (pathname, data, cookie) => fetch(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  assert.equal((await post(`/api/threads/${CHAT}/compact`, {})).status, 401, 'no session, no compaction');
  const cookie = (await post('/api/session', { token })).headers.get('set-cookie').split(';')[0];
  const get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } });
  assert.equal((await post(`/api/threads/${CHAT}/compact`, { instructions: 'short' }, cookie)).status, 200);
  assert.deepEqual(calls('thread/compact/start').at(-1).params, { threadId: CHAT, instructions: 'short' });
  const review = await post(`/api/threads/${CHAT}/review`, { target: { type: 'uncommittedChanges' } }, cookie);
  assert.equal(review.status, 200); assert.equal((await review.json()).turn.id, 'review-turn');
  assert.equal((await post(`/api/threads/${CHAT}/review`, { target: { type: 'nope' } }, cookie)).status, 400);
  const choices = await (await get(`/api/threads/${CHAT}/git?view=review`)).json(); assert.equal(choices.current, 'feature');
  assert.match((await (await get(`/api/threads/${CHAT}/git?view=diff`)).json()).diff, /three-uncommitted/);
  assert.equal((await get(`/api/threads/${CHAT}/git?view=bad`)).status, 400);
  assert.equal((await get(`/api/threads/${CHAT}/git`)).status, 400);
  assert.equal((await get(`/api/threads/${CHAT}/compact`)).status, 405, 'compaction is never a GET');
  assert.equal((await post(`/api/threads/${CHAT}/git?view=diff`, {}, cookie)).status, 405, 'git is read-only over HTTP');
});
