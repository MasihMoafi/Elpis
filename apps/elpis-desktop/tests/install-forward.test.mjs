// An install must contain the installed commit (21 October: an install built from an older branch dropped ~50 fixes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertApprovedLooks, assertMovesForward, installationCommit } from '../scripts/install-desktop.mjs';

// Keep fixtures in /tmp for boot cleanup: gio trash is unsupported on this mount.
async function history() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-forward-'));
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

const splashFiles = [
  'apps/elpis-desktop/components/startup-splash.tsx',
  'apps/elpis-desktop/components/startup-splash.css',
  'apps/elpis-desktop/tests/startup-splash.test.cjs',
];
const refusal = `The approved look "startup-splash" changed (${splashFiles.join(', ')}). Show Masih the light and dark frames first, then rerun with --shown=startup-splash.`;

async function lookHistory(changedFile) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-looks-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  const files = [...splashFiles, 'unrelated.txt'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), 'approved\n');
  }
  const commit = message => {
    git('add', '--', ...files);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const installed = commit('approved look');
  await fs.writeFile(path.join(repo, changedFile), 'changed\n');
  const next = commit('candidate');
  return { repo, installed, next };
}

test('(a) a changed look file is refused without --shown', async () => {
  for (const file of splashFiles.slice(0, 2)) {
    const { repo, installed, next } = await lookHistory(file);
    assert.throws(() => assertApprovedLooks(repo, installed, next), { message: refusal });
  }
});

test('(b) a changed look test alone is refused without --shown', async () => {
  const { repo, installed, next } = await lookHistory(splashFiles[2]);
  assert.throws(() => assertApprovedLooks(repo, installed, next), { message: refusal });
});

test('(c) unrelated changes and reinstalling the same commit pass quietly', async t => {
  const { repo, installed, next } = await lookHistory('unrelated.txt');
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  assert.doesNotThrow(() => assertApprovedLooks(repo, installed, next));
  assert.doesNotThrow(() => assertApprovedLooks(repo, installed, installed));
  assert.deepEqual(messages, []);
});

test('(d) --shown=startup-splash permits the changed look and names it', async t => {
  const { repo, installed, next } = await lookHistory(splashFiles[0]);
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  assert.doesNotThrow(() => assertApprovedLooks(repo, installed, next, ['--shown=startup-splash']));
  assert.deepEqual(messages, ['Shown to Masih: startup-splash.']);
});

test('(e) other --shown ids, partial matches and empty values do not unlock the look', async () => {
  const { repo, installed, next } = await lookHistory(splashFiles[0]);
  for (const flag of ['--shown=other', '--shown=other,another', '--shown=startup-splash-extra', '--shown=']) {
    assert.throws(() => assertApprovedLooks(repo, installed, next, [flag]), { message: refusal });
  }
});

test('--shown accepts comma lists and repeated flags for both source and test changes', async t => {
  t.mock.method(console, 'log', () => {});
  for (const file of splashFiles) {
    const { repo, installed, next } = await lookHistory(file);
    assert.doesNotThrow(() => assertApprovedLooks(repo, installed, next, ['--shown=other,startup-splash,another']));
    assert.doesNotThrow(() => assertApprovedLooks(repo, installed, next, ['--shown=other', '--shown=startup-splash']));
  }
});

test('approved look paths are checked from the desktop subdirectory', async () => {
  const { repo, installed, next } = await lookHistory(splashFiles[0]);
  assert.throws(() => assertApprovedLooks(path.join(repo, 'apps/elpis-desktop'), installed, next), { message: refusal });
});

test('a missing installed commit is refused just like the forward check', async () => {
  const { repo, next } = await lookHistory(splashFiles[0]);
  assert.throws(() => assertApprovedLooks(repo, null, next, ['--shown=startup-splash']), {
    message: 'The selected installation records no source commit, so this install could drop its fixes; integrate it first.',
  });
});

test('a failed git comparison is refused even with --shown', async () => {
  const { repo, installed } = await lookHistory(splashFiles[0]);
  assert.throws(() => assertApprovedLooks(repo, installed, 'missing-commit', ['--shown=startup-splash']));
});
