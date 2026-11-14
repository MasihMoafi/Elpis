// An install must contain the installed commit (21 October: an install built from an older branch dropped ~50 fixes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertMovesForward, assertRendererCommit, installationCommit, recordSourceCheckout } from '../scripts/install-desktop.mts';

test('installation records the durable Elpis checkout, never the throwaway worktree', async () => {
  const { repo } = await history();
  await fs.mkdir(path.join(repo, 'apps/elpis-desktop'), { recursive: true });
  await fs.writeFile(path.join(repo, 'apps/elpis-desktop/package.json'), JSON.stringify({ name: 'elpis-desktop' }));
  execFileSync('git', ['-C', repo, 'add', 'apps/elpis-desktop/package.json']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'desktop source']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const checkout = `${repo}-installer`;
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', checkout], { stdio: 'ignore' });
  const installed = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-source-record-'));
  await recordSourceCheckout(checkout, installed);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed, 'source.json'), 'utf8')), { path: repo, commit });
  const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-non-source-'));
  await assert.rejects(recordSourceCheckout(unrelated, installed), /durable Elpis source checkout/);
});

// Keep fixtures in /tmp for boot cleanup: gio trash is unsupported on this mount.
async function history() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-forward-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = (message: string) => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const base = commit('base');
  const installed = commit('installed fixes');
  const next = commit('next fix');
  git('checkout', '-q', base);
  const olderBranch = commit('fix made on an older branch');
  return { repo, installed, next, olderBranch };
}

test('an install that contains the installed commit moves forward', async () => {
  const { repo, installed, next } = await history();
  assert.doesNotThrow(() => assertMovesForward(repo, installed, next));
  assert.doesNotThrow(() => assertMovesForward(repo, installed, installed));
});

test('an install from a branch that lacks the installed commit is refused', async () => {
  const { repo, installed, olderBranch } = await history();
  assert.throws(() => assertMovesForward(repo, installed, olderBranch), /would drop installed fixes/);
  assert.throws(() => assertMovesForward(repo, null, installed), /records no source commit/);
});

test('the installed commit comes from the renderer record, else the folder suffix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-version-'));
  const recorded = path.join(root, 'update-20261021-78b25b344');
  await fs.mkdir(path.join(recorded, 'app/out'), { recursive: true });
  await fs.writeFile(path.join(recorded, 'app/out/.commit'), `${'a'.repeat(40)}\n`);
  assert.equal(installationCommit(recorded), 'a'.repeat(40));
  const named = path.join(root, 'session-manager-finish-20261020-478059e83');
  await fs.mkdir(named);
  assert.equal(installationCommit(named), '478059e83');
  assert.equal(installationCommit(path.join(root, 'hand-made')), null);
});

// 28 Oct: three local installs packaged the renderer of an older build: out/ was not rebuilt after a checkout.
test('a local install refuses a renderer built from another commit, or with no record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-renderer-commit-')), commit = 'b'.repeat(40);
  assert.throws(() => assertRendererCommit(root, commit), /an unrecorded commit/);
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'out/.commit'), `${'a'.repeat(40)}\n`);
  assert.throws(() => assertRendererCommit(root, commit), /built from aaaaaaaaa, not bbbbbbbbb/);
  await fs.writeFile(path.join(root, 'out/.commit'), `${commit}\n`);
  assertRendererCommit(root, commit);
});

// The install takes GitHub's build: a later successful re-run of the same commit counts, an earlier failure does not.
test('the installer picks the newest successful run of exactly this commit', async () => {
  const { pickRun } = await import('../scripts/actions-build.mts');
  const commit = 'd'.repeat(40), other = 'e'.repeat(40);
  const run = (databaseId: number, status: string, conclusion: string | null, createdAt: string, headSha = commit) =>
    ({ databaseId, status, conclusion, createdAt, headSha });
  const otherSuccess = run(3, 'completed', 'success', '2026-11-14T03', other);
  assert.equal(pickRun([run(1, 'completed', 'failure', '2026-11-14T01'), run(2, 'completed', 'success', '2026-11-14T02'), otherSuccess], commit).databaseId, 2);
  assert.throws(() => pickRun([run(1, 'completed', 'cancelled', '2026-11-14T01'), run(4, 'queued', null, '2026-11-14T04')], commit), /run 4 .* still running/);
  assert.throws(() => pickRun([otherSuccess], commit), /no "Elpis desktop" run/);
});
