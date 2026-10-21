import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;

/** Git lists the main checkout first, even when called from a disposable linked worktree. Never retain that worktree. */
export async function durableSourceCheckout(candidate, revision) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  if (revision !== undefined && !/^[0-9a-f]{40}$/.test(revision)) return null;
  try {
    const root = (await git(candidate, 'rev-parse', '--show-toplevel')).trim();
    const commit = (await git(root, 'rev-parse', '--verify', `${revision ?? 'HEAD'}^{commit}`)).trim();
    const identity = JSON.parse(await git(root, 'show', `${commit}:apps/elpis-desktop/package.json`));
    if (identity?.name !== 'elpis-desktop') return null;
    const main = (await git(root, 'worktree', 'list', '--porcelain', '-z')).split('\0')[0];
    if (!main.startsWith('worktree ')) return null;
    const durable = await fs.realpath(main.slice('worktree '.length));
    return { path: durable, commit };
  } catch { return null; }
}
