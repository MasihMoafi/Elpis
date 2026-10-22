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
// Approved looks also need their light and dark frames shown to Masih before installing changes: --shown=ID[,ID].
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { records, requirePass } from './gate-guards.mjs';
import { assertSourceCommit, verifyPackagedSources, verifyRendererReceipt } from './renderer-artifact-gate.mjs';
import { durableSourceCheckout } from '../bridge/improve-source.mjs';
import { smokeLaunch } from './smoke-launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const approvedLooks = JSON.parse(fs.readFileSync(new URL('../approved-looks.json', import.meta.url), 'utf8'));
const missingCommit = 'The selected installation records no source commit, so this install could drop its fixes; integrate it first.';
const name = process.argv[2], release = process.argv.includes('--release'), actions = process.argv.includes('--actions'), rollback = process.argv.includes('--rollback');
const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();

/** Local installation metadata, derived from Git rather than the disposable checkout used to build/install. */
export async function recordSourceCheckout(cwd, destination) {
  const source = await durableSourceCheckout(cwd);
  if (!source) throw new Error('Cannot locate the durable Elpis source checkout for this installation.');
  fs.writeFileSync(path.join(destination, 'source.json'), JSON.stringify(source), { mode: 0o600, flag: 'wx' });
}

/** The commit an installation was built from: the renderer's recorded commit, else the NAME-<commit> suffix of its folder. */
export function installationCommit(version) {
  try { const recorded = fs.readFileSync(path.join(version, 'app/out/.commit'), 'utf8').trim(); if (/^[0-9a-f]{40}$/.test(recorded)) return recorded; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path.basename(version).match(/-([0-9a-f]{9,40})$/)?.[1] ?? null;
}

/** Refuses a commit that lacks the selected installation's commit, so installing never drops installed fixes. */
export function assertMovesForward(cwd, installed, commit) {
  if (!installed) throw new Error(missingCommit);
  try { execFileSync('git', ['merge-base', '--is-ancestor', installed, commit], { cwd, stdio: 'ignore' }); }
  catch { throw new Error(`${commit.slice(0, 9)} does not contain the installed ${installed.slice(0, 9)}; installing it would drop installed fixes. Integrate onto the installed line first.`); }
}

/** Refuses changes to an approved look until Masih has seen its light and dark frames. */
export function assertApprovedLooks(cwd, installed, commit, args = []) {
  if (!installed) throw new Error(missingCommit);
  const shown = new Set(args.filter(arg => arg.startsWith('--shown=')).flatMap(arg => arg.slice('--shown='.length).split(',')));
  const accepted = [];
  for (const { id, files } of approvedLooks) {
    try {
      // The installer runs inside apps/elpis-desktop; registered paths are relative to the repository root.
      execFileSync('git', ['diff', '--quiet', installed, commit, '--', ...files.map(file => `:(top,literal)${file}`)], { cwd, stdio: 'ignore' });
    } catch (error) {
      if (error.status !== 1) throw error;
      if (!shown.has(id)) throw new Error(`The approved look "${id}" changed (${files.join(', ')}). Show Masih the light and dark frames first, then rerun with --shown=${id}.`);
      accepted.push(id);
    }
  }
  if (accepted.length) console.log(`Shown to Masih: ${accepted.join(', ')}.`);
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
  if (!/^[\w.-]+$/.test(name ?? '')) throw new Error('usage: node scripts/install-desktop.mjs NAME [--release] [--actions] [--rollback] [--shown=ID[,ID]]');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('There are uncommitted changes; commit them and run the full gate first.');
  const commit = git(['rev-parse', 'HEAD']);
  if (release) await requirePass(records, commit);
  const link = path.join(os.homedir(), '.local/bin/elpis-app');
  const previous = fs.readlinkSync(link);
  if (!rollback) {
    const installed = installationCommit(path.dirname(fs.realpathSync(link)));
    assertMovesForward(root, installed, commit);
    assertApprovedLooks(root, installed, commit, process.argv.slice(3));
  }
  const electron = path.join(path.dirname(fs.realpathSync(link)), 'runtime/electron');
  const destination = path.join(os.homedir(), '.local/lib/elpis-desktop/versions', `${name}-${commit.slice(0, 9)}`);
  if (fs.existsSync(destination)) throw new Error(`${destination} already exists.`);
  const renderer = actions ? ['--out-directory', await actionsRenderer(commit)] : [];
  // The package list is checked against what the entry points import before anything is installed (22 Oct: an unlisted module kept Elpis from opening).
  if (fs.existsSync(path.join(root, 'desktop/package.test.mjs'))) execFileSync(process.execPath, ['--test', 'desktop/package.test.mjs'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  assertSourceCommit(root, commit);
  execFileSync(process.execPath, ['desktop/package.mjs', '--source', '.', '--destination', destination, '--link-runtime',
    '--electron-dist', electron, '--ws-directory', 'node_modules/ws', ...renderer], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  if (actions) await verifyRendererReceipt({ root, out: path.join(destination, 'app/out'), commit });
  await verifyPackagedSources({ root, destination, commit });
  await recordSourceCheckout(root, destination);
  // The package must open, with its own launcher, before `elpis-app` points at it (22 Oct: two installs shipped one Elpis could not open).
  try { await smokeLaunch(destination); }
  catch (error) { execFileSync('gio', ['trash', destination]); throw new Error(`The new package does not open, so nothing was switched.\n${error.message}`); }
  const staged = `${link}.new-${process.pid}`;
  fs.symlinkSync(path.join(destination, 'launch'), staged);
  assertSourceCommit(root, commit);
  fs.renameSync(staged, link);
  console.log(`Installed ${commit.slice(0, 9)} as ${destination}.\nRoll back: ln -sfn ${previous} ${link}`);
} catch (error) {
  console.error(`install-desktop: ${error.message}`);
  process.exitCode = 1;
}
