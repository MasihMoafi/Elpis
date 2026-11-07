#!/usr/bin/env node
// prune-versions.mts VERSIONS [--keep PATH]... [--named-in FILE]...: after a successful install, moves old install
// folders to the trash (1 Nov: 74 desktop versions, 2.4 GB, and six engine bundles of 459 MB had piled up).
// Kept: the newest five, every version a --keep path lies in (the current and rollback installs), every version a
// --named-in file names (the live launcher's pinned frontend) and every version a running process uses.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const within = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep);

/** The versions among `dirs` that a running process executes, names in its arguments, or works in. */
function inUse(dirs: string[]) {
  const used = new Set<string>();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return used; }
  for (const pid of pids) {
    const refs = [];
    for (const link of ['exe', 'cwd']) { try { refs.push(fs.readlinkSync(`/proc/${pid}/${link}`)); } catch {} }
    try { refs.push(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch {}
    for (const dir of dirs) if (refs.some(ref => ref === dir || ref.includes(dir + path.sep))) used.add(dir);
  }
  return used;
}

/** Trashes all but the versions kept (see the header) and returns the folders it trashed. */
export function pruneVersions(root: string, { newest = 5, keep = [], namedIn = [], trash = dir => execFileSync('gio', ['trash', dir]) }: { newest?: number; keep?: string[]; namedIn?: string[]; trash?: (dir: string) => unknown } = {}) {
  const base = fs.realpathSync(root);
  const born = (dir: string) => { const stat = fs.statSync(dir); return stat.birthtimeMs || stat.mtimeMs; };
  const dirs = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(base, entry.name))
    .sort((a, b) => born(b) - born(a));
  const pins = keep.filter(Boolean).flatMap(file => { try { return [path.resolve(file), fs.realpathSync(file)]; } catch { return [path.resolve(file)]; } });
  const texts = namedIn.flatMap(file => { try { return [fs.readFileSync(file, 'utf8')]; } catch { return []; } });
  const kept = new Set(dirs.slice(0, newest));
  for (const dir of dirs) {
    if (pins.some(pin => within(pin, dir)) || texts.some(text => text.includes(dir + path.sep))) kept.add(dir);
  }
  const rest = dirs.filter(dir => !kept.has(dir));
  const used = inUse(rest);
  const trashed = [];
  for (const dir of rest) if (!used.has(dir)) { trash(dir); trashed.push(dir); }
  return trashed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, ...args] = process.argv.slice(2);
  if (root === undefined) throw new TypeError("Missing versions directory");
  const keep = [], namedIn = [];
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === '--keep' && value !== undefined) keep.push(value);
    else if (args[i] === '--named-in' && value !== undefined) namedIn.push(value);
    else { console.error('usage: prune-versions.mts VERSIONS [--keep PATH]... [--named-in FILE]...'); process.exit(2); }
  }
  const trashed = pruneVersions(root, { keep, namedIn });
  if (trashed.length) console.log(`Moved ${trashed.length} old version${trashed.length === 1 ? '' : 's'} to the trash.`);
}
