// The review surface's Git reads and its one write (bridge/git.mjs): a real throwaway repository, no engine, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, discardFile, fileDiff, isRepository } from './git.mjs';
import { startDesktopServer } from './server.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
const write = (dir, name, text) => fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }).then(() => fs.writeFile(path.join(dir, name), text));
const read = (dir, name) => fs.readFile(path.join(dir, name), 'utf8');
const exists = (dir, name) => fs.access(path.join(dir, name)).then(() => true, () => false);

/** A repository with one commit holding keep.txt, gone.txt and src/app.js, then the working tree edited in every way a chat does. */
async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-changes-'));
  git(dir, 'init', '-q', '-b', 'main');
  await write(dir, 'keep.txt', 'one\ntwo\nthree\n'); await write(dir, 'gone.txt', 'a\nb\n'); await write(dir, 'src/app.js', 'const a = 1;\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
  await write(dir, 'keep.txt', 'one\nTWO\nthree\nfour\n');         // modified: +2 -1
  await fs.rm(path.join(dir, 'gone.txt'));                          // deleted: -2
  await write(dir, 'src/new.js', 'x\ny\nz\n');                      // untracked: +3
  await write(dir, 'staged.txt', 's1\ns2\n'); git(dir, 'add', 'staged.txt'); // added to the index: +2
  await fs.writeFile(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 3, 0, 255])); // untracked binary
  return dir;
}

test('changedFiles lists every changed file with its status and line counts', async () => {
  const dir = await repository();
  try {
    const { files, truncated } = await changedFiles(dir);
    assert.equal(truncated, false);
    assert.deepEqual(files.map(({ path: name, status, added, removed, binary }) => [name, status, added, removed, binary]), [
      ['gone.txt', 'deleted', 0, 2, false],
      ['keep.txt', 'modified', 2, 1, false],
      ['pic.bin', 'untracked', 0, 0, true],
      ['src/new.js', 'untracked', 3, 0, false],
      ['staged.txt', 'added', 2, 0, false],
    ]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('changedFiles works before the first commit, and says when the folder is not a repository', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-unborn-')), plain = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-plain-'));
  try {
    git(dir, 'init', '-q', '-b', 'main'); await write(dir, 'first.txt', 'hello\n');
    assert.deepEqual((await changedFiles(dir)).files.map(file => [file.path, file.status, file.added]), [['first.txt', 'untracked', 1]]);
    await assert.rejects(changedFiles(plain), /not a Git repository/);
    await assert.rejects(changedFiles('relative/folder'), /folder/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(plain, { recursive: true, force: true }); }
});

test('fileDiff gives one file\'s diff, for tracked, deleted and untracked files alike', async () => {
  const dir = await repository();
  try {
    assert.match((await fileDiff(dir, 'keep.txt')).diff, /^@@ .*\n one\n-two\n\+TWO\n three\n\+four\n$/ms);
    assert.match((await fileDiff(dir, 'gone.txt')).diff, /-a\n-b\n/);
    assert.match((await fileDiff(dir, 'src/new.js')).diff, /\+x\n\+y\n\+z\n/);
    assert.match((await fileDiff(dir, 'staged.txt')).diff, /\+s1\n\+s2\n/);
    const binary = await fileDiff(dir, 'pic.bin'); assert.equal(binary.binary, true);
    assert.doesNotMatch((await fileDiff(dir, 'keep.txt')).diff, /new\.js|gone\.txt/, 'only the named file');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('fileDiff and discardFile only take a changed file inside the folder', async () => {
  const dir = await repository(); await write(dir, 'untouched.txt', 'x');
  git(dir, 'add', 'untouched.txt'); git(dir, 'commit', '-q', '-m', 'second');
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`); await fs.writeFile(outside, 'keep me');
  try {
    for (const name of ['../outside.txt', `../${path.basename(outside)}`, '/etc/passwd', '', 'src/../../x', '-rf', 'untouched.txt', 'missing.txt', '*']) {
      await assert.rejects(fileDiff(dir, name), /change|file/i, `diff of ${JSON.stringify(name)}`);
      await assert.rejects(discardFile(dir, name), /change|file/i, `discard of ${JSON.stringify(name)}`);
    }
    await assert.rejects(discardFile(dir, undefined), /file/i);
    assert.equal(await read(path.dirname(outside), path.basename(outside)), 'keep me');
    assert.equal(await read(dir, 'untouched.txt'), 'x'); assert.equal(await read(dir, 'keep.txt'), 'one\nTWO\nthree\nfour\n', 'nothing else was touched');
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(outside, { force: true }); }
});

test('discardFile puts back what was committed and removes what is new, one file at a time', async () => {
  const dir = await repository();
  try {
    await discardFile(dir, 'keep.txt'); assert.equal(await read(dir, 'keep.txt'), 'one\ntwo\nthree\n');
    await discardFile(dir, 'gone.txt'); assert.equal(await read(dir, 'gone.txt'), 'a\nb\n');
    await discardFile(dir, 'src/new.js'); assert.equal(await exists(dir, 'src/new.js'), false);
    await discardFile(dir, 'staged.txt'); assert.equal(await exists(dir, 'staged.txt'), false);
    assert.deepEqual((await changedFiles(dir)).files.map(file => file.path), ['pic.bin'], 'the file left alone is still listed');
    assert.equal(await exists(dir, 'pic.bin'), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a file named like a Git option or a glob is read literally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-literal-'));
  try {
    git(dir, 'init', '-q', '-b', 'main'); await write(dir, 'base.txt', 'b\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
    await write(dir, '--force', 'dash\n'); await write(dir, 'a*.txt', 'star\n'); await write(dir, 'abc.txt', 'other\n');
    assert.match((await fileDiff(dir, 'a*.txt')).diff, /\+star/); assert.doesNotMatch((await fileDiff(dir, 'a*.txt')).diff, /other/);
    await discardFile(dir, 'a*.txt'); assert.equal(await exists(dir, 'a*.txt'), false); assert.equal(await exists(dir, 'abc.txt'), true, 'the glob did not reach abc.txt');
    await discardFile(dir, '--force'); assert.equal(await exists(dir, '--force'), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a chat working in a sub-folder sees the whole repository\'s changes by root-relative name', async () => {
  const dir = await repository(), sub = path.join(dir, 'src');
  try {
    const { files, root } = await changedFiles(sub);
    assert.equal(await fs.realpath(root), await fs.realpath(dir), 'the list names the repository root, for opening a file\'s folder');
    assert.deepEqual(files.map(file => file.path), ['gone.txt', 'keep.txt', 'pic.bin', 'src/new.js', 'staged.txt']);
    assert.match((await fileDiff(sub, 'keep.txt')).diff, /\+TWO/);
    await discardFile(sub, 'keep.txt'); assert.equal(await read(dir, 'keep.txt'), 'one\ntwo\nthree\n');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('untracked files count their lines like Git: a last line without a newline counts, an empty file adds nothing, a link is Git\'s', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-counts-'));
  try {
    git(dir, 'init', '-q', '-b', 'main'); await write(dir, 'base.txt', 'b\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
    await write(dir, 'no-newline.txt', 'a\nb'); await write(dir, 'empty.txt', ''); await write(dir, 'blank-lines.txt', '\n\n\n'); await fs.symlink('base.txt', path.join(dir, 'link.txt'));
    await write(dir, 'big.txt', 'line\n'.repeat(300_000));
    const found = Object.fromEntries((await changedFiles(dir)).files.map(file => [file.path, [file.added, file.removed, file.binary]]));
    assert.deepEqual(found, { 'big.txt': [300000, 0, false], 'blank-lines.txt': [3, 0, false], 'empty.txt': [0, 0, false], 'link.txt': [1, 0, false], 'no-newline.txt': [2, 0, false] });
    const gitCount = name => { try { return git(dir, 'diff', '--no-index', '--numstat', '--', '/dev/null', name); } catch (error) { return String(error.stdout); } };  // exit 1: the files differ
    for (const name of Object.keys(found)) assert.equal(gitCount(name).split('\t')[0] || '0', String(found[name][0]), `${name}: the same count as Git's`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('isRepository says whether worktree isolation can run in a folder: inside a repository that has a commit', async () => {
  const dir = await repository(), unborn = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-unborn-')), plain = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-plain-'));
  try {
    git(unborn, 'init', '-q', '-b', 'main');
    assert.equal(await isRepository(dir), true);
    assert.equal(await isRepository(path.join(dir, 'src')), true, 'a sub-folder of the repository');
    assert.equal(await isRepository(unborn), false, 'no commit yet: the engine needs one to branch from');
    assert.equal(await isRepository(plain), false);
    await assert.rejects(isRepository('relative/folder'), /folder/);
  } finally { for (const folder of [dir, unborn, plain]) await fs.rm(folder, { recursive: true, force: true }); }
});

test('GET /api/repository answers { repository } for a project folder, and a 400 for anything else', async t => {
  const dir = await repository(), plain = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-git-plain-'));
  t.after(async () => { for (const folder of [dir, plain]) await fs.rm(folder, { recursive: true, force: true }); });
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) };
  const app = await startDesktopServer({ client, staticDir: plain }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const query = cwd => `/api/repository?cwd=${encodeURIComponent(cwd)}`;
  assert.equal((await fetch(origin + query(dir))).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0], get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } });
  for (const [folder, repository] of [[dir, true], [plain, false]]) { const answer = await get(query(folder)); assert.equal(answer.status, 200); assert.deepEqual(await answer.json(), { repository }); }
  for (const pathname of ['/api/repository', '/api/repository?cwd=', query('relative'), query(path.join(plain, 'nope')), `${query(dir)}&cwd=${encodeURIComponent(dir)}`, `${query(dir)}&extra=1`]) assert.equal((await get(pathname)).status, 400, pathname);
});
