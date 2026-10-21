import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { CHAT_WORKTREE } from '../lib/chat-worktree.ts';

const DIFF_LIMIT = 400_000;
export const NOT_A_REPOSITORY = 'This chat\'s folder is not a Git repository.';
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

/** Whether `cwd` is inside a Git repository that has a commit: what Elpis's worktree isolation needs, since each agent's worktree branches from HEAD. */
export async function isRepository(cwd) {
  folder(cwd);
  return repoRoot(cwd).then(hasHead, () => false);
}

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
  const cwd = await repoRoot(chatFolder);
  changeName(file);
  const entry = (await statusEntries(cwd, file)).find(item => item.path === file);
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

/** The branch checked out in a folder, for the chat's branch chip; null outside a repository, on a detached HEAD, or
 * when the folder is gone. */
export async function currentBranch(cwd) {
  folder(cwd);
  return { branch: await run(cwd, ['branch', '--show-current']).then(text => text.trim() || null, () => null) };
}

// A chat's own worktree, as in Claude's desktop app ("Start with worktree"). It sits where the agents canvas puts its
// worktrees, beside the repository in `<repo>-elpis/` (codex-rs core/src/tools/handlers/work_graph_worktrees.rs), as
// `chats/chat-<6 hex>`, on the new branch `elpis/chat-<6 hex>` from what is checked out. The path alone says which
// repository and branch it belongs to, so a removed one can be put back.
const NO_COMMIT = 'A worktree needs a Git repository with a commit.';
/** Where a chat worktree's folder says it belongs: { root, source, branch }, or null for any other folder. */
function chatPlace(cwd) {
  const match = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.normalize(cwd).replace(/\/+$/, '').match(CHAT_WORKTREE) : null;
  if (!match) return null;
  const [, parent, repository, name] = match;
  return { root: path.join(parent, `${repository}-elpis`, 'chats', name), source: path.join(parent, repository), branch: `elpis/${name}` };
}
/** Whether a chat's folder is named like a chat worktree; a cheap check before any Git runs. */
export const isChatWorktreePath = cwd => chatPlace(cwd) !== null;
const isFolder = file => fs.stat(file).then(info => info.isDirectory(), () => false);
const branchExists = (cwd, branch) => run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
const absoluteGitPath = (cwd, which) => run(cwd, ['rev-parse', '--path-format=absolute', which]).then(text => text.trim(), () => null);
/** The empty `chats/` and `<repo>-elpis/` folders a removed worktree leaves; rmdir refuses any other. */
async function removeEmptyParents(root) {
  for (const dir of [path.dirname(root), path.dirname(path.dirname(root))]) await fs.rmdir(dir).catch(() => {});
}
/** The chat worktree a folder lies in, only when Git agrees: a linked worktree of the repository its name points to. */
async function chatWorktreeOf(cwd) {
  const place = chatPlace(cwd);
  if (!place || await fs.realpath(place.root).catch(() => null) !== place.root) return null;
  const [top, common, own, sourceCommon] = await Promise.all([
    run(place.root, ['rev-parse', '--show-toplevel']).then(text => text.trim(), () => null),
    absoluteGitPath(place.root, '--git-common-dir'), absoluteGitPath(place.root, '--git-dir'), absoluteGitPath(place.source, '--git-common-dir'),
  ]);
  return top === place.root && common && common === sourceCommon && own !== common ? place : null;
}

/** Makes a new chat's worktree for the project in `projectFolder`. The chat's folder keeps the project's place inside
 * the repository. The main checkout, its branch and its uncommitted work are not touched. */
export async function createChatWorktree(projectFolder) {
  folder(projectFolder);
  const source = await repoRoot(projectFolder).then(root => fs.realpath(root), error => { throw error.status === 501 ? error : new BridgeError(NO_COMMIT, 409); });
  if (!await hasHead(source)) throw new BridgeError(NO_COMMIT, 409);
  const relative = path.relative(source, await fs.realpath(projectFolder)), home = path.join(path.dirname(source), `${path.basename(source)}-elpis`, 'chats');
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `chat-${randomBytes(3).toString('hex')}`, root = path.join(home, name), branch = `elpis/${name}`;
    if (await fs.lstat(root).then(() => true, () => false) || await branchExists(source, branch)) continue;
    try {
      await fs.mkdir(home, { recursive: true });
      await run(source, ['worktree', 'add', '-q', '--no-track', '-b', branch, root, 'HEAD']);
    } catch (error) { await removeEmptyParents(root); throw new BridgeError(`Could not create the worktree: ${error.message.replace(/^Git could not read this folder: /, '')}`, 409); }
    const made = { root, cwd: path.join(root, relative), branch, source };
    if (!await isFolder(made.cwd)) { await undoChatWorktree(made); throw new BridgeError('The project\'s folder is not in the repository\'s last commit, so a worktree cannot hold it.', 409); }
    return made;
  }
  throw new BridgeError('Could not find a free name for the worktree. Try again.', 409);
}

/** Takes back a worktree made a moment ago for a chat that did not start: nothing in it is anyone's work yet. */
export async function undoChatWorktree({ root, branch, source }) {
  await run(source, ['worktree', 'remove', '--force', root]).catch(() => {});
  await run(source, ['branch', '-q', '-D', branch]).catch(() => {});
  await removeEmptyParents(root);
}

/** After its chat is archived or deleted: a chat worktree with nothing uncommitted is removed and its branch kept, so
 * committed work stays on it (Claude: "Committed work stays on its branch."). One with uncommitted changes is kept, and
 * the answer says where. Null, and nothing touched, for any folder that is not a chat worktree. */
export async function releaseChatWorktree(cwd) {
  const place = await chatWorktreeOf(cwd);
  if (!place) return null;
  const { root, source } = place, branch = (await run(root, ['branch', '--show-current']).catch(() => '')).trim() || place.branch;
  const changes = await statusEntries(root).then(entries => entries.length, () => null);
  if (changes !== 0) return { kept: true, path: root, branch, changes: changes ?? 0 };
  // Without --force: Git itself refuses a worktree that is not clean.
  if (!await run(source, ['worktree', 'remove', root]).then(() => true, () => false)) return { kept: true, path: root, branch, changes: 0 };
  await removeEmptyParents(root);
  return { removed: true, path: root, branch };
}

/** When an archived chat comes back: its removed worktree is put back on its branch. Null when the folder is still there,
 * the branch is gone, or the folder is not a chat worktree's. */
export async function restoreChatWorktree(cwd) {
  const place = chatPlace(cwd);
  if (!place || await fs.lstat(place.root).then(() => true, () => false)) return null;
  if (await fs.realpath(place.source).catch(() => null) !== place.source || (await run(place.source, ['rev-parse', '--show-toplevel']).catch(() => '')).trim() !== place.source) return null;
  if (!await branchExists(place.source, place.branch)) return null;
  try {
    await fs.mkdir(path.dirname(place.root), { recursive: true });
    await run(place.source, ['worktree', 'add', '-q', place.root, place.branch]);
  } catch { await removeEmptyParents(place.root); return null; }
  return { restored: true, path: place.root, branch: place.branch };
}
