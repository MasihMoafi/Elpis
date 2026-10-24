// A chat in its own Git worktree, as in Claude's desktop app ("Start with worktree"): the bridge makes the worktree beside
// the repository (the agents canvas's place, `<repo>-elpis/`), starts the chat there on a new `elpis/` branch, names the
// branch on request, and on archive or delete removes the worktree only when it holds nothing uncommitted.
// Real throwaway repositories under the system temp folder; the engine is a scripted socket. No provider, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';
import { currentBranch, createChatWorktree, releaseChatWorktree, restoreChatWorktree } from './git.mjs';
import { startDesktopServer } from './server.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const write = (dir, name, text) => fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }).then(() => fs.writeFile(path.join(dir, name), text));
const exists = file => fs.access(file).then(() => true, () => false);
const hasBranch = (repo, branch) => { try { git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; } };

/** A parent folder holding `repo` (one commit on main: keep.txt and src/app.js) with an uncommitted edit, so the
 * worktree's sibling folder lands in the same throwaway parent. */
async function project(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-chat-wt-'))), repo = path.join(parent, 'repo');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.mkdir(repo); git(repo, 'init', '-q', '-b', 'main');
  await write(repo, 'keep.txt', 'one\n'); await write(repo, 'src/app.js', 'const a = 1;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first');
  await write(repo, 'keep.txt', 'one\nedited in the main checkout\n');
  return { parent, repo };
}

test('createChatWorktree makes a worktree beside the repository, on a new elpis/ branch from HEAD, and leaves the main checkout alone', async t => {
  const { parent, repo } = await project(t), before = git(repo, 'status', '--porcelain');
  const made = await createChatWorktree(repo), name = path.basename(made.root);
  assert.match(name, /^chat-[0-9a-f]{6}$/);
  assert.deepEqual(made, { root: path.join(parent, 'repo-elpis', 'chats', name), cwd: path.join(parent, 'repo-elpis', 'chats', name), branch: `elpis/${name}`, source: repo });
  assert.equal(git(made.root, 'branch', '--show-current'), made.branch);
  assert.equal(git(made.root, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'HEAD'), 'it starts from what is checked out');
  assert.equal(await fs.readFile(path.join(made.root, 'keep.txt'), 'utf8'), 'one\n', 'the main checkout\'s uncommitted edit stays there');
  assert.equal(git(repo, 'branch', '--show-current'), 'main'); assert.equal(git(repo, 'status', '--porcelain'), before);
  const other = await createChatWorktree(repo); assert.notEqual(other.root, made.root, 'each chat gets its own');
  const sub = await createChatWorktree(path.join(repo, 'src'));
  assert.equal(sub.cwd, path.join(sub.root, 'src'), 'a project in a sub-folder keeps its place in the repository');
});

test('createChatWorktree refuses a folder that is not a repository with a commit, and makes nothing', async t => {
  const { parent } = await project(t), unborn = path.join(parent, 'unborn'), plain = path.join(parent, 'plain');
  await fs.mkdir(unborn); git(unborn, 'init', '-q', '-b', 'main'); await fs.mkdir(plain);
  await assert.rejects(createChatWorktree(unborn), /Git repository with a commit/);
  await assert.rejects(createChatWorktree(plain), /Git repository with a commit/);
  await assert.rejects(createChatWorktree('relative/folder'), /folder/);
  assert.equal(await exists(path.join(parent, 'unborn-elpis')), false); assert.equal(await exists(path.join(parent, 'plain-elpis')), false);
});

test('releaseChatWorktree removes a worktree with nothing uncommitted and keeps its branch with the committed work', async t => {
  const { parent, repo } = await project(t), made = await createChatWorktree(repo);
  await write(made.root, 'feature.txt', 'done\n'); git(made.root, 'add', '.'); git(made.root, 'commit', '-q', '-m', 'feature');
  assert.deepEqual(await releaseChatWorktree(made.cwd), { removed: true, path: made.root, branch: made.branch });
  assert.equal(await exists(made.root), false);
  assert.equal(hasBranch(repo, made.branch), true, 'committed work stays on its branch');
  assert.equal(git(repo, 'show', `${made.branch}:feature.txt`), 'done');
  assert.equal(await exists(path.join(parent, 'repo-elpis')), false, 'the empty folders beside the repository go too');
});

test('releaseChatWorktree keeps a worktree with uncommitted work, says where and how many changes, and touches nothing', async t => {
  const { repo } = await project(t), made = await createChatWorktree(repo);
  await write(made.root, 'keep.txt', 'changed\n'); await write(made.root, 'notes/new.txt', 'draft\n');
  assert.deepEqual(await releaseChatWorktree(made.cwd), { kept: true, path: made.root, branch: made.branch, changes: 2 });
  assert.equal(await fs.readFile(path.join(made.root, 'notes/new.txt'), 'utf8'), 'draft\n');
  assert.equal(await fs.readFile(path.join(made.root, 'keep.txt'), 'utf8'), 'changed\n');
  assert.equal(git(made.root, 'branch', '--show-current'), made.branch);
});

test('releaseChatWorktree leaves alone every folder that is not a chat worktree Elpis made', async t => {
  const { parent, repo } = await project(t), lookalike = path.join(parent, 'other-elpis', 'chats', 'chat-abcdef');
  await write(lookalike, 'mine.txt', 'not a worktree\n');
  const linked = path.join(parent, 'hand-made'); git(repo, 'worktree', 'add', '-q', '-b', 'hand', linked);
  for (const folder of [repo, path.join(repo, 'src'), lookalike, linked, path.join(parent, 'missing')]) assert.equal(await releaseChatWorktree(folder), null, folder);
  assert.equal(await exists(path.join(lookalike, 'mine.txt')), true); assert.equal(await exists(linked), true);
  assert.equal(await fs.readFile(path.join(repo, 'keep.txt'), 'utf8'), 'one\nedited in the main checkout\n');
});

test('restoreChatWorktree puts a removed chat worktree back on its branch; otherwise it does nothing', async t => {
  const { repo } = await project(t), made = await createChatWorktree(path.join(repo, 'src'));
  await write(made.root, 'feature.txt', 'done\n'); git(made.root, 'add', '.'); git(made.root, 'commit', '-q', '-m', 'feature');
  assert.equal(await restoreChatWorktree(made.cwd), null, 'still there: nothing to restore');
  await releaseChatWorktree(made.cwd);
  assert.deepEqual(await restoreChatWorktree(made.cwd), { restored: true, path: made.root, branch: made.branch });
  assert.equal(git(made.root, 'branch', '--show-current'), made.branch);
  assert.equal(await fs.readFile(path.join(made.root, 'feature.txt'), 'utf8'), 'done\n');
  await releaseChatWorktree(made.cwd); git(repo, 'branch', '-q', '-D', made.branch);
  assert.equal(await restoreChatWorktree(made.cwd), null, 'no branch: nothing to restore');
  assert.equal(await exists(made.root), false);
});

test('currentBranch names the branch checked out in a folder, and null where there is none', async t => {
  const { parent, repo } = await project(t), made = await createChatWorktree(repo), plain = path.join(parent, 'plain');
  await fs.mkdir(plain);
  assert.deepEqual(await currentBranch(repo), { branch: 'main' });
  assert.deepEqual(await currentBranch(path.join(made.root)), { branch: made.branch });
  git(repo, 'checkout', '-q', '--detach');
  for (const folder of [repo, plain, path.join(parent, 'missing')]) assert.deepEqual(await currentBranch(folder), { branch: null }, folder);
});

const CHAT = '00000000-0000-0000-0000-0000000000c1', OTHER = '00000000-0000-0000-0000-0000000000c2';
/** The engine as a scripted socket: thread/start records the cwd it is given; `failStart` makes it refuse. */
function engine({ failStart = false } = {}) {
  const threads = new Map(), socket = new EventEmitter(); socket.sent = [];
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    const reply = value => queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...value })));
    const p = request.params;
    switch (request.method) {
      case 'initialize': return reply({ result: {} });
      case 'thread/start': {
        if (failStart) return reply({ error: { code: -32600, message: 'cannot start the chat' } });
        const thread = { id: CHAT, cwd: p.cwd, status: { type: 'idle' }, source: 'appServer' }; threads.set(CHAT, thread); return reply({ result: { thread } });
      }
      case 'thread/read': return reply({ result: { thread: structuredClone(threads.get(p.threadId)) } });
      case 'thread/list': return reply({ result: { data: [...threads.values()].filter(thread => !!thread.archived === !!p.archived && (!p.cwd || thread.cwd === p.cwd) && (!p.ancestorThreadId || thread.parentThreadId === p.ancestorThreadId)), nextCursor: null } });
      case 'thread/archive': threads.get(p.threadId).archived = true; return reply({ result: {} });
      case 'thread/unarchive': delete threads.get(p.threadId).archived; return reply({ result: { thread: structuredClone(threads.get(p.threadId)) } });
      case 'thread/delete': threads.delete(p.threadId); return reply({ result: {} });
      default: return reply({ error: { code: -32601, message: `Unexpected protocol method ${request.method}` } });
    }
  };
  socket.close = () => socket.emit('close');
  const client = new DesktopClient(socket);
  return { client, socket, threads, started: () => socket.sent.findLast(row => row.method === 'thread/start')?.params };
}

test('a new chat asked to work in a worktree starts there, and says its branch', async t => {
  const { repo } = await project(t), { client, started } = engine(); t.after(() => client.close()); await client.initialize();
  const result = await client.createThread({ cwd: repo, worktree: true });
  const name = path.basename(started().cwd);
  assert.match(started().cwd, /\/repo-elpis\/chats\/chat-[0-9a-f]{6}$/);
  assert.equal(result.thread.cwd, started().cwd);
  assert.deepEqual(result.worktree, { path: started().cwd, branch: `elpis/${name}` });
  assert.equal(git(started().cwd, 'branch', '--show-current'), `elpis/${name}`);
  assert.deepEqual(await client.git(CHAT, 'branch'), { branch: `elpis/${name}` });
  await assert.rejects(client.createThread({ worktree: true }), /folder/, 'a worktree needs the project\'s folder');
  await assert.rejects(client.createThread({ cwd: repo, worktree: 'yes' }), /worktree/);
  await client.createThread({ cwd: repo });
  assert.equal(started().cwd, repo, 'without the option the chat works in the folder itself');
});

test('when the engine refuses the chat, the worktree and branch just made are taken back', async t => {
  const { parent, repo } = await project(t), { client } = engine({ failStart: true }); t.after(() => client.close()); await client.initialize();
  await assert.rejects(client.createThread({ cwd: repo, worktree: true }), /cannot start the chat/);
  assert.equal(await exists(path.join(parent, 'repo-elpis')), false);
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/elpis'), '');
});

test('archiving a worktree chat removes a clean worktree, keeps one with uncommitted work, and unarchiving puts it back', async t => {
  const { repo } = await project(t), { client, threads } = engine(); t.after(() => client.close()); await client.initialize();
  const { worktree } = await client.createThread({ cwd: repo, worktree: true });
  await write(worktree.path, 'draft.txt', 'unsaved\n');
  assert.deepEqual(await client.archiveThread(CHAT, {}), { archived: true, worktree: { kept: true, path: worktree.path, branch: worktree.branch, changes: 1 } });
  assert.equal(await exists(path.join(worktree.path, 'draft.txt')), true);
  await client.unarchiveThread(CHAT, {});
  await fs.rm(path.join(worktree.path, 'draft.txt'));
  assert.deepEqual(await client.archiveThread(CHAT, {}), { archived: true, worktree: { removed: true, path: worktree.path, branch: worktree.branch } });
  assert.equal(await exists(worktree.path), false);
  const restored = await client.unarchiveThread(CHAT, {});
  assert.deepEqual(restored.worktree, { restored: true, path: worktree.path, branch: worktree.branch });
  assert.equal(git(worktree.path, 'branch', '--show-current'), worktree.branch);
  // Another open chat in the same worktree (a fork) keeps it in use: nothing is removed.
  threads.set(OTHER, { id: OTHER, cwd: worktree.path, status: { type: 'idle' } });
  assert.deepEqual(await client.archiveThread(CHAT, {}), { archived: true });
  assert.equal(await exists(worktree.path), true);
});

test('deleting a worktree chat never removes uncommitted work, and an ordinary chat\'s folder is never touched', async t => {
  const { repo } = await project(t), { client } = engine(); t.after(() => client.close()); await client.initialize();
  const { worktree } = await client.createThread({ cwd: repo, worktree: true });
  await write(worktree.path, 'keep.txt', 'changed in the chat\n');
  const deleted = await client.deleteThread(CHAT, {});
  assert.deepEqual(deleted.worktree, { kept: true, path: worktree.path, branch: worktree.branch, changes: 1 });
  assert.equal(await fs.readFile(path.join(worktree.path, 'keep.txt'), 'utf8'), 'changed in the chat\n');
  await client.createThread({ cwd: repo });
  assert.deepEqual(await client.deleteThread(CHAT, {}), { deleted: true, alsoDeleted: [] });
  assert.equal(await fs.readFile(path.join(repo, 'keep.txt'), 'utf8'), 'one\nedited in the main checkout\n');
});

test('the window reaches it: POST /api/threads takes worktree, GET /api/threads/:id/git?view=branch names the branch', async t => {
  const { repo } = await project(t), { client } = engine(); await client.initialize();
  const app = await startDesktopServer({ client, staticDir: repo }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const headers = { Cookie: auth.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', Origin: origin };
  const created = await fetch(origin + '/api/threads', { method: 'POST', headers, body: JSON.stringify({ cwd: repo, worktree: true }) });
  assert.equal(created.status, 201); const { worktree } = await created.json();
  const branch = await fetch(`${origin}/api/threads/${CHAT}/git?view=branch`, { headers });
  assert.equal(branch.status, 200); assert.deepEqual(await branch.json(), { branch: worktree.branch });
});
