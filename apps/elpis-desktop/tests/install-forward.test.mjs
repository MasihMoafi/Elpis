// An install must contain the installed commit (21 October: an install built from an older branch dropped ~50 fixes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertMovesForward, installationCommit } from '../scripts/install-desktop.mjs';

async function history(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-forward-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = message => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const base = commit('base');
  const installed = commit('installed fixes');
  const next = commit('next fix');
  git('checkout', '-q', base);
  const olderBranch = commit('fix made on an older branch');
  return { repo, installed, next, olderBranch };
}

test('an install that contains the installed commit moves forward', async t => {
  const { repo, installed, next } = await history(t);
  assert.doesNotThrow(() => assertMovesForward(repo, installed, next));
  assert.doesNotThrow(() => assertMovesForward(repo, installed, installed));
});

test('an install from a branch that lacks the installed commit is refused', async t => {
  const { repo, installed, olderBranch } = await history(t);
  assert.throws(() => assertMovesForward(repo, installed, olderBranch), /would drop installed fixes/);
  assert.throws(() => assertMovesForward(repo, null, installed), /records no source commit/);
});

test('the installed commit comes from the renderer record, else the folder suffix', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recorded = path.join(root, 'update-20261021-78b25b344');
  await fs.mkdir(path.join(recorded, 'app/out'), { recursive: true });
  await fs.writeFile(path.join(recorded, 'app/out/.commit'), `${'a'.repeat(40)}\n`);
  assert.equal(installationCommit(recorded), 'a'.repeat(40));
  const named = path.join(root, 'session-manager-finish-20261020-478059e83');
  await fs.mkdir(named);
  assert.equal(installationCommit(named), '478059e83');
  assert.equal(installationCommit(path.join(root, 'hand-made')), null);
});
