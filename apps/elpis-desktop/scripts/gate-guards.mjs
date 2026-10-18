// Rules the test gate and the desktop install enforce, so a mistake is stopped by code rather than remembered.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const records = path.join(os.homedir(), '.local/state/elpis-gate');

/** The lock holders on this machine, from lslocks. */
export function systemLocks() {
  try {
    return execFileSync('lslocks', ['--noheadings', '--raw', '--output', 'PID,PATH'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(line => { const [pid, ...rest] = line.split(' '); return { pid: Number(pid), path: rest.join(' ') }; });
  } catch { return []; }
}

export function parentOf(pid) {
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0; } catch { return 0; }
}

/** The pid of an ancestor of `pid` that holds `lock`, or null. The UI tier takes that lock for each file, so a gate
 * started under `flock <lock>` would wait on its own parent for ever (it happened on 18 October). */
export function heldByAncestor(lock, pid = process.pid, locks = systemLocks(), parent = parentOf) {
  const holders = new Set(locks.filter(entry => entry.path === lock).map(entry => entry.pid));
  for (let at = parent(pid), steps = 0; at > 1 && steps < 64; at = parent(at), steps++) if (holders.has(at)) return at;
  return null;
}

/** Why the UI tier cannot start, or null: without Playwright every browser file fails at once with the same error. */
export function missingPlaywright(env = process.env, resolve = createRequire(import.meta.url).resolve) {
  if (env.ELPIS_PLAYWRIGHT_PACKAGE) return null;
  try { resolve('playwright'); return null; } catch {
    return 'Playwright is not installed here. Set ELPIS_PLAYWRIGHT_PACKAGE to a Playwright package directory (see TESTING.md).';
  }
}

/** The pass record of a gate run, or null unless it ran every ordinary tier on a clean tree with no failure. */
export function passRecord({ start, commit, clean, selected, tiers, files }) {
  const ordinary = tiers.filter(tier => tier !== 'opt-in');
  if (!start?.clean || start.commit !== commit || !clean || !commit || !ordinary.every(tier => selected.includes(tier)) || !files.length || files.some(file => file.code !== 0)) return null;
  return { commit, files: files.length, at: new Date().toISOString() };
}

/** Resolves to the pass record of `commit`; rejects when the full gate has not passed on exactly that commit. */
export async function requirePass(dir, commit) {
  try { return JSON.parse(await fs.readFile(path.join(dir, `${commit}.json`), 'utf8')); } catch {
    throw new Error(`The full test gate has not passed on ${commit}. Commit everything, run \`npm test\` (all tiers) on it, then install.`);
  }
}
