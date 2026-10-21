#!/usr/bin/env node
// install-desktop.mjs NAME [--release] [--actions]: packages this commit as ~/.local/lib/elpis-desktop/versions/NAME-<commit> and
// points ~/.local/bin/elpis-app at it, with nothing uncommitted. A release also needs the full test gate's pass on exactly
// this commit; a local install does not (Masih: "Only full suite for releases; for local deployment prefer fastest builds").
// It links the installed Electron runtime rather than copying it, launches nothing, and prints the command that rolls back.
// With --actions the renderer is the one GitHub Actions built for this commit (.github/workflows/elpis-desktop.yml; push
// the commit to a build/* branch first), so nothing is built here (Masih, 20 October: "use github actions for all builds").
// The UI receipt must match both the downloaded renderer and its packaged copy before selecting the installation.
// An install only moves forward: the commit must contain the selected installation's commit (21 October: an install
// built from an older branch dropped about fifty installed fixes). --rollback skips that check when Masih asks for one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { records, requirePass } from './gate-guards.mjs';
import { assertSourceCommit, verifyPackagedSources, verifyRendererReceipt } from './renderer-artifact-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const name = process.argv[2], release = process.argv.includes('--release'), actions = process.argv.includes('--actions'), rollback = process.argv.includes('--rollback');
const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();

/** The commit an installation was built from: the renderer's recorded commit, else the NAME-<commit> suffix of its folder. */
export function installationCommit(version) {
  try { const recorded = fs.readFileSync(path.join(version, 'app/out/.commit'), 'utf8').trim(); if (/^[0-9a-f]{40}$/.test(recorded)) return recorded; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path.basename(version).match(/-([0-9a-f]{9,40})$/)?.[1] ?? null;
}

/** Refuses a commit that lacks the selected installation's commit, so installing never drops installed fixes. */
export function assertMovesForward(cwd, installed, commit) {
  if (!installed) throw new Error('The selected installation records no source commit, so this install could drop its fixes; integrate it first.');
  try { execFileSync('git', ['merge-base', '--is-ancestor', installed, commit], { cwd, stdio: 'ignore' }); }
  catch { throw new Error(`${commit.slice(0, 9)} does not contain the installed ${installed.slice(0, 9)}; installing it would drop installed fixes. Integrate onto the installed line first.`); }
}

/** Downloads the renderer GitHub Actions built for `commit` into a new temporary folder and returns that folder. */
async function actionsRenderer(commit) {
  const [run] = JSON.parse(gh(['run', 'list', '--workflow', 'elpis-desktop.yml', '--commit', commit, '--status', 'success', '--json', 'databaseId', '--limit', '1']));
  if (!run) throw new Error(`GitHub Actions has no successful build of ${commit.slice(0, 9)}: push it to a build/* branch and wait for "Elpis desktop".`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-renderer-'));
  gh(['run', 'download', String(run.databaseId), '--name', 'renderer', '--dir', folder]);
  const built = fs.readFileSync(path.join(folder, '.commit'), 'utf8').trim();
  if (built !== commit) throw new Error(`The Actions renderer is from ${built.slice(0, 9)}, not ${commit.slice(0, 9)}.`);
  await verifyRendererReceipt({ root, out: folder, commit });
  return folder;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) try {
  if (!/^[\w.-]+$/.test(name ?? '')) throw new Error('usage: node scripts/install-desktop.mjs NAME [--release] [--actions] [--rollback]');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('There are uncommitted changes; commit them and run the full gate first.');
  const commit = git(['rev-parse', 'HEAD']);
  if (release) await requirePass(records, commit);
  const link = path.join(os.homedir(), '.local/bin/elpis-app');
  const previous = fs.readlinkSync(link);
  if (!rollback) assertMovesForward(root, installationCommit(path.dirname(fs.realpathSync(link))), commit);
  const electron = path.join(path.dirname(fs.realpathSync(link)), 'runtime/electron');
  const destination = path.join(os.homedir(), '.local/lib/elpis-desktop/versions', `${name}-${commit.slice(0, 9)}`);
  if (fs.existsSync(destination)) throw new Error(`${destination} already exists.`);
  const renderer = actions ? ['--out-directory', await actionsRenderer(commit)] : [];
  assertSourceCommit(root, commit);
  execFileSync(process.execPath, ['desktop/package.mjs', '--source', '.', '--destination', destination, '--link-runtime',
    '--electron-dist', electron, '--ws-directory', 'node_modules/ws', ...renderer], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  if (actions) await verifyRendererReceipt({ root, out: path.join(destination, 'app/out'), commit });
  await verifyPackagedSources({ root, destination, commit });
  const staged = `${link}.new-${process.pid}`;
  fs.symlinkSync(path.join(destination, 'launch'), staged);
  assertSourceCommit(root, commit);
  fs.renameSync(staged, link);
  console.log(`Installed ${commit.slice(0, 9)} as ${destination}.\nRoll back: ln -sfn ${previous} ${link}`);
} catch (error) {
  console.error(`install-desktop: ${error.message}`);
  process.exitCode = 1;
}
