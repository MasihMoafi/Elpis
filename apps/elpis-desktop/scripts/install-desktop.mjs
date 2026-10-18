#!/usr/bin/env node
// install-desktop.mjs NAME [--release]: packages this commit as ~/.local/lib/elpis-desktop/versions/NAME-<commit> and
// points ~/.local/bin/elpis-app at it, with nothing uncommitted. A release also needs the full test gate's pass on exactly
// this commit; a local install does not (Masih: "Only full suite for releases; for local deployment prefer fastest builds").
// It reuses the installed Electron runtime, launches nothing, and prints the command that rolls back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { records, requirePass } from './gate-guards.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const name = process.argv[2], release = process.argv.includes('--release');
try {
  if (!/^[\w.-]+$/.test(name ?? '')) throw new Error('usage: node scripts/install-desktop.mjs NAME [--release]');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('There are uncommitted changes; commit them and run the full gate first.');
  const commit = git(['rev-parse', 'HEAD']);
  if (release) await requirePass(records, commit);
  const link = path.join(os.homedir(), '.local/bin/elpis-app');
  const previous = fs.readlinkSync(link);
  const electron = path.join(path.dirname(fs.realpathSync(link)), 'runtime/electron');
  const destination = path.join(os.homedir(), '.local/lib/elpis-desktop/versions', `${name}-${commit.slice(0, 9)}`);
  if (fs.existsSync(destination)) throw new Error(`${destination} already exists.`);
  execFileSync(process.execPath, ['desktop/package.mjs', '--source', '.', '--destination', destination,
    '--electron-dist', electron, '--ws-directory', 'node_modules/ws'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const staged = `${link}.new-${process.pid}`;
  fs.symlinkSync(path.join(destination, 'launch'), staged);
  fs.renameSync(staged, link);
  console.log(`Installed ${commit.slice(0, 9)} as ${destination}.\nRoll back: ln -sfn ${previous} ${link}`);
} catch (error) {
  console.error(`install-desktop: ${error.message}`);
  process.exitCode = 1;
}
