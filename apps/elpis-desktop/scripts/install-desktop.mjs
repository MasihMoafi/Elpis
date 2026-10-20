#!/usr/bin/env node
// install-desktop.mjs NAME [--release] [--actions]: packages this commit as ~/.local/lib/elpis-desktop/versions/NAME-<commit> and
// points ~/.local/bin/elpis-app at it, with nothing uncommitted. A release also needs the full test gate's pass on exactly
// this commit; a local install does not (Masih: "Only full suite for releases; for local deployment prefer fastest builds").
// It links the installed Electron runtime rather than copying it, launches nothing, and prints the command that rolls back.
// With --actions the renderer is the one GitHub Actions built for this commit (.github/workflows/elpis-desktop.yml; push
// the commit to a build/* branch first), so nothing is built here (Masih, 20 October: "use github actions for all builds").
// The UI receipt must match both the downloaded renderer and its packaged copy before selecting the installation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { records, requirePass } from './gate-guards.mjs';
import { verifyRendererReceipt } from './renderer-artifact-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const name = process.argv[2], release = process.argv.includes('--release'), actions = process.argv.includes('--actions');
const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();

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
try {
  if (!/^[\w.-]+$/.test(name ?? '')) throw new Error('usage: node scripts/install-desktop.mjs NAME [--release] [--actions]');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('There are uncommitted changes; commit them and run the full gate first.');
  const commit = git(['rev-parse', 'HEAD']);
  if (release) await requirePass(records, commit);
  const link = path.join(os.homedir(), '.local/bin/elpis-app');
  const previous = fs.readlinkSync(link);
  const electron = path.join(path.dirname(fs.realpathSync(link)), 'runtime/electron');
  const destination = path.join(os.homedir(), '.local/lib/elpis-desktop/versions', `${name}-${commit.slice(0, 9)}`);
  if (fs.existsSync(destination)) throw new Error(`${destination} already exists.`);
  const renderer = actions ? ['--out-directory', await actionsRenderer(commit)] : [];
  execFileSync(process.execPath, ['desktop/package.mjs', '--source', '.', '--destination', destination, '--link-runtime',
    '--electron-dist', electron, '--ws-directory', 'node_modules/ws', ...renderer], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  if (actions) await verifyRendererReceipt({ root, out: path.join(destination, 'app/out'), commit });
  const staged = `${link}.new-${process.pid}`;
  fs.symlinkSync(path.join(destination, 'launch'), staged);
  fs.renameSync(staged, link);
  console.log(`Installed ${commit.slice(0, 9)} as ${destination}.\nRoll back: ln -sfn ${previous} ${link}`);
} catch (error) {
  console.error(`install-desktop: ${error.message}`);
  process.exitCode = 1;
}
