import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';

const DIFF_LIMIT = 400_000;
const NOT_A_REPOSITORY = 'This chat\'s folder is not a Git repository.';
// Read-only Git, with the repository's own helpers switched off: its config may name programs to run.
// A file's name is read as a name: no glob, no pathspec magic.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', '--literal-pathspecs'];
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color'];

function run(cwd, args, { limit = 4_000_000, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => execFile('git', [...SAFE, ...args], { cwd, timeout: 15000, maxBuffer: limit, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } }, (error, stdout, stderr) => {
    if (!error || okCodes.includes(error.code)) return resolve(stdout);
    if (error.code === 'ENOENT') return reject(new BridgeError('Git is not installed on this computer.', 501));
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(String(stdout ?? ''));
    reject(new BridgeError(/not a git repository/i.test(stderr) ? NOT_A_REPOSITORY : `Git could not read this folder: ${String(stderr).trim().split('\n')[0].slice(0, 200)}`, 409));
  }));
}
const folder = cwd => {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new BridgeError('This chat has no folder to read.', 409);
  return cwd;
};

/** The terminal's /review presets that need Git: local branches, the current one, and recent commits. */
export async function reviewChoices(cwd) {
  folder(cwd);
  const [branches, current, log] = await Promise.all([
    run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    run(cwd, ['branch', '--show-current']),
    run(cwd, ['log', '-n', '100', '--format=%H%x1f%s']).catch(error => { if (/does not have any commits/i.test(error.message)) return ''; throw error; }),
  ]);
  return {
    branches: branches.split('\n').filter(Boolean), current: current.trim() || null,
    commits: log.split('\n').filter(Boolean).map(line => { const [sha, ...subject] = line.split('\x1f'); return { sha, subject: subject.join('\x1f') }; }),
  };
}

/** The terminal's /diff: tracked changes against HEAD plus every untracked file, as plain text. */
export async function workingDiff(cwd) {
  folder(cwd);
  const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => 'HEAD', () => null);
  const tracked = await run(cwd, ['diff', ...SAFE_DIFF, ...(head ? [head] : [])], { limit: DIFF_LIMIT * 2 });
  const names = (await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  let diff = tracked;
  for (const name of names.slice(0, 200)) {
    if (diff.length > DIFF_LIMIT) break;
    diff += await run(cwd, ['diff', ...SAFE_DIFF, '--no-index', '--', '/dev/null', name], { limit: DIFF_LIMIT * 2, okCodes: [0, 1] });
  }
  const truncated = diff.length > DIFF_LIMIT || names.length > 200;
  return { diff: diff.slice(0, DIFF_LIMIT), truncated };
}

const MAX_FILES = 200;
const NOT_CHANGED = 'Choose a file from the list of changes.';
/** One name from the list of changes: relative to the chat's folder, never leaving it. */
function changeName(file) {
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0') || file.startsWith('/') || file.split('/').includes('..')) throw new BridgeError(NOT_CHANGED, 400);
  return file;
}
/** The repository's top folder: names in the list of changes are relative to it, wherever in the repository the chat works. */
const repoRoot = async cwd => (await run(folder(cwd), ['rev-parse', '--show-toplevel'])).trim();
const hasHead = cwd => run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
function statusOf(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted';
  if (xy.includes('D')) return 'deleted';
  return xy[0] === 'A' ? 'added' : 'modified';
}
/** Git's `added removed name` rows (--numstat -z) as a map; a binary file reads `- -`. */
function counts(text) {
  const rows = new Map();
  for (const record of text.split('\0').filter(Boolean)) {
    const [added, removed, ...name] = record.split('\t');
    rows.set(name.join('\t'), added === '-' ? { added: 0, removed: 0, binary: true } : { added: Number(added), removed: Number(removed), binary: false });
  }
  return rows;
}
const SMALL = 1_000_000;
/** An untracked file's counts. Small plain files are counted here (a line per newline, and the last line even without one;
 * a NUL byte in the first 8000 bytes makes it binary, as in Git), since the list is read every second or two while a turn
 * runs. Anything else, a link or a big file, is left to Git, which compares it with an empty file. */
async function newFileCounts(cwd, name) {
  const file = path.join(cwd, name), info = await fs.lstat(file).catch(() => null);
  if (info?.isFile() && info.size <= SMALL) {
    const bytes = await fs.readFile(file).catch(() => null);
    if (bytes) {
      if (bytes.subarray(0, 8000).includes(0)) return { added: 0, removed: 0, binary: true };
      let lines = 0; for (const byte of bytes) if (byte === 10) lines++;
      return { added: lines + (bytes.length && bytes.at(-1) !== 10 ? 1 : 0), removed: 0, binary: false };
    }
  }
  const [added, removed] = (await run(cwd, ['diff', ...SAFE_DIFF, '--numstat', '--no-index', '--', '/dev/null', name], { okCodes: [0, 1] }).catch(() => '')).split('\t');
  return added === '-' ? { added: 0, removed: 0, binary: true } : { added: Number(added) || 0, removed: Number(removed) || 0, binary: false };
}
/** The working tree's changed files, from Git's own status: [{ path, status, added, removed, binary }], by name. */
async function statusEntries(cwd, file) {
  const text = await run(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', ...(file === undefined ? [] : ['--', file])]);
  return text.split('\0').filter(Boolean).map(record => ({ xy: record.slice(0, 2), path: record.slice(3) }));
}

/** The review surface's file list: every changed file against HEAD, untracked files included, with its status and
 * how many lines it adds and removes. Read-only; at most 200 files, then `truncated`. */
export async function changedFiles(chatFolder) {
  const cwd = await repoRoot(chatFolder), head = await hasHead(cwd);
  const [entries, tracked] = await Promise.all([
    statusEntries(cwd),
    run(cwd, ['diff', ...SAFE_DIFF, '--numstat', '-z', '--no-renames', ...(head ? ['HEAD'] : ['--cached'])], { limit: DIFF_LIMIT * 2 }).then(counts),
  ]);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const shown = entries.slice(0, MAX_FILES), files = [];
  for (let at = 0; at < shown.length; at += 8) {
    files.push(...await Promise.all(shown.slice(at, at + 8).map(async ({ xy, path: name }) => {
      const status = statusOf(xy);
      const own = status === 'untracked' ? await newFileCounts(cwd, name) : tracked.get(name);
      return { path: name, status, added: own?.added ?? 0, removed: own?.removed ?? 0, binary: own?.binary ?? false };
    })));
  }
  return { root: cwd, files, truncated: entries.length > MAX_FILES };
}

/** The entry for one name in the list of changes, or an error: nothing else is read or touched. */
async function entryOf(chatFolder, file) {
  changeName(file);
  const cwd = await repoRoot(chatFolder), entry = (await statusEntries(cwd, file)).find(item => item.path === file);
  if (!entry) throw new BridgeError(NOT_CHANGED, 409);
  return { ...entry, cwd };
}

/** One changed file's diff against HEAD (an untracked file as all added lines), as plain text. */
export async function fileDiff(chatFolder, file) {
  const entry = await entryOf(chatFolder, file), { cwd } = entry, status = statusOf(entry.xy), head = await hasHead(cwd);
  const diff = status === 'untracked'
    ? await run(cwd, ['diff', ...SAFE_DIFF, '--no-index', '--', '/dev/null', file], { limit: DIFF_LIMIT * 2, okCodes: [0, 1] })
    : await run(cwd, ['diff', ...SAFE_DIFF, '--no-renames', ...(head ? ['HEAD'] : ['--cached']), '--', file], { limit: DIFF_LIMIT * 2 });
  return { diff: diff.slice(0, DIFF_LIMIT), truncated: diff.length > DIFF_LIMIT, binary: /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff) };
}

/** Throws one changed file away: a committed file goes back to HEAD, a new one is removed. It cannot be undone, so the
 * window asks first. Only a name in the list of changes is accepted. */
export async function discardFile(chatFolder, file) {
  const entry = await entryOf(chatFolder, file), { cwd } = entry;
  if (statusOf(entry.xy) === 'untracked') await run(cwd, ['clean', '-f', '-q', '--', file]);
  else if ((await run(cwd, ['ls-tree', '--name-only', '-z', 'HEAD', '--', file]).catch(() => '')).split('\0').includes(file)) await run(cwd, ['checkout', 'HEAD', '--', file]);
  else await run(cwd, ['rm', '-f', '-q', '--', file]);
  return { discarded: file };
}
