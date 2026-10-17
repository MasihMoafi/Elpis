import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RewindSnapshots } from './rewind-snapshots.mjs';

async function fixture(t) {
  const root = await fs.mkdir(path.resolve('../../.tmp/rewind'), { recursive: true }).then(() => fs.mkdtemp(path.resolve('../../.tmp/rewind/repo-')));
  const cwd = path.join(root, 'work'), home = path.join(root, 'state'); await fs.mkdir(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(cwd, 'file.txt'), 'committed\n');
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored\n');
  git('add', 'file.txt', '.gitignore'); git('commit', '-qm', 'baseline');
  const store = new RewindSnapshots(home);
  return { root, cwd, home, git, store, write: (name, value) => fs.writeFile(path.join(cwd, name), value), read: name => fs.readFile(path.join(cwd, name), 'utf8') };
}

test('per-turn Git snapshots preserve dirty/staged inputs and survive a bridge restart without touching HEAD or index', async t => {
  const f = await fixture(t); await f.write('file.txt', 'staged\n'); f.git('add', 'file.txt'); await f.write('file.txt', 'before turn\n');
  const head = f.git('rev-parse', 'HEAD'), index = f.git('show', ':file.txt');
  await f.store.capture('chat', 'turn', f.cwd); await f.write('file.txt', 'after turn\n'); await f.write('new.txt', 'new\n');
  const restarted = new RewindSnapshots(f.home), preview = await restarted.preview('chat', 'turn', f.cwd);
  assert.equal(preview.available, true); assert.equal(preview.files.length, 2); assert.match(preview.diff, /before turn/);
  await restarted.restore('chat', 'turn', f.cwd, preview.version);
  assert.equal(await f.read('file.txt'), 'before turn\n'); await assert.rejects(f.read('new.txt'), { code: 'ENOENT' });
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('show', ':file.txt'), index);
});

test('snapshots cover additions, deletions, binary bytes, executable bits, Unicode names and pre-existing untracked files', async t => {
  const f = await fixture(t); await f.write('پیش.txt', 'keep\n'); await f.write('binary', Buffer.from([0, 1, 255])); await fs.chmod(path.join(f.cwd, 'file.txt'), 0o755);
  await f.store.capture('chat', 'turn', f.cwd); await fs.unlink(path.join(f.cwd, 'file.txt')); await f.write('پیش.txt', 'changed\n'); await f.write('binary', Buffer.from([0, 9])); await f.write('ignored', 'secret');
  const preview = await f.store.preview('chat', 'turn', f.cwd); await f.store.restore('chat', 'turn', f.cwd, preview.version);
  assert.equal(await f.read('پیش.txt'), 'keep\n'); assert.deepEqual(await fs.readFile(path.join(f.cwd, 'binary')), Buffer.from([0, 1, 255]));
  assert.equal((await fs.stat(path.join(f.cwd, 'file.txt'))).mode & 0o111, 0o111); assert.equal(await f.read('ignored'), 'secret');
});

test('a stale preview refuses restore, and missing checkpoints offer conversation only', async t => {
  const f = await fixture(t); assert.equal((await f.store.preview('chat', 'old', f.cwd)).available, false);
  await f.store.capture('chat', 'turn', f.cwd); await f.write('file.txt', 'after\n');
  const preview = await f.store.preview('chat', 'turn', f.cwd); await f.write('file.txt', 'manual edit\n');
  await assert.rejects(f.store.restore('chat', 'turn', f.cwd, preview.version), /changed|preview/i); assert.equal(await f.read('file.txt'), 'manual edit\n');
});

test('restoring never follows a parent symlink out of the workspace', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.cwd, 'dir')); await f.write('dir/a', 'before\n');
  await f.store.capture('chat', 'turn', f.cwd); await fs.rename(path.join(f.cwd, 'dir'), path.join(f.root, 'outside')); await fs.symlink(path.join(f.root, 'outside'), path.join(f.cwd, 'dir'));
  const preview = await f.store.preview('chat', 'turn', f.cwd);
  assert.equal(preview.available, false); assert.match(preview.reason, /link|unsafe|folder/i);
  assert.equal(await fs.readFile(path.join(f.root, 'outside/a'), 'utf8'), 'before\n');
});

test('checkpoints never execute the project’s filters and retain literal unusual file names', async t => {
  const f = await fixture(t);
  f.git('config', 'filter.refuse.clean', 'exit 91'); await f.write('.gitattributes', '*.txt filter=refuse\n');
  await f.write('name\twith\nlines.txt', 'before\n'); await f.store.capture('chat', 'turn', f.cwd); await f.write('name\twith\nlines.txt', 'after\n');
  const preview = await f.store.preview('chat', 'turn', f.cwd); assert.deepEqual(preview.files, ['name\twith\nlines.txt']);
  await f.store.restore('chat', 'turn', f.cwd, preview.version); assert.equal(await f.read('name\twith\nlines.txt'), 'before\n');
});

test('a checkpoint path that is now ignored still participates in the preview and stale-file check', async t => {
  const f = await fixture(t); await f.write('ignored', 'before turn\n'); f.git('add', '-f', 'ignored'); f.git('commit', '-qm', 'tracked earlier');
  await f.store.capture('chat', 'turn', f.cwd); f.git('rm', '--cached', 'ignored'); f.git('commit', '-qm', 'ignore it now');
  await f.write('ignored', 'after turn\n'); const preview = await f.store.preview('chat', 'turn', f.cwd);
  assert.match(preview.diff, /after turn/); await f.write('ignored', 'new edit\n');
  await assert.rejects(f.store.restore('chat', 'turn', f.cwd, preview.version), /changed|preview/i); assert.equal(await f.read('ignored'), 'new edit\n');
});
