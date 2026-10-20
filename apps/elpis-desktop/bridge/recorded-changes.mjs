import path from 'node:path';
import { BridgeError } from './client.mjs';

const DIFF_LIMIT = 400_000, MAX_FILES = 200;
const STATUS = { add: 'added', delete: 'deleted', update: 'modified' };

/** One recorded change as unified-diff hunks: an update's diff already is one (a bare one gets a header); a created or
 * deleted file's diff is its whole text, so every line is added or removed. */
function hunks(kind, diff) {
  const text = typeof diff === 'string' ? diff.replace(/\n*Moved to: .*\s*$/, '') : '';
  if (kind === 'update') return !text ? '' : /^@@ /m.test(text) ? text.slice(text.search(/^@@ /m)) : `@@ -1 +1 @@\n${text}`;
  const rows = text.split('\n'); if (rows.at(-1) === '') rows.pop();
  if (!rows.length) return '';
  return `${kind === 'add' ? `@@ -0,0 +1,${rows.length} @@` : `@@ -1,${rows.length} +0,0 @@`}\n${rows.map(row => `${kind === 'add' ? '+' : '-'}${row}`).join('\n')}\n`;
}

/** The Changes tab outside Git, the way Zed reviews an agent's edits from its action log: every completed file change
 * the chat recorded, a file changed more than once as one file whose diff is its edits in order. Paths inside `root`
 * are shown relative to it. `items` are the chat's items, oldest first. */
export function recordedChanges(root, items) {
  const files = new Map();
  for (const item of items) {
    if (item?.type !== 'fileChange' || item.status !== 'completed' || !Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      if (typeof change?.path !== 'string') continue;
      const kind = ['add', 'delete'].includes(change.kind?.type) ? change.kind.type : 'update';
      const relative = path.isAbsolute(change.path) ? path.relative(root, change.path) : change.path;
      const name = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : change.path;
      const file = files.get(name) ?? { path: name, status: STATUS[kind], diff: '' };
      if (kind === 'delete') file.status = file.status === 'added' ? 'added' : 'deleted';
      file.diff += hunks(kind, change.diff);
      files.set(name, file);
    }
  }
  const counted = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => {
    let added = 0, removed = 0;
    for (const line of file.diff.split('\n')) if (line.startsWith('+')) added++; else if (line.startsWith('-')) removed++;
    return { ...file, added, removed };
  });
  const shown = counted.slice(0, MAX_FILES);
  return {
    changes: { root, recorded: true, files: shown.map(({ diff, ...file }) => ({ ...file, binary: false })), truncated: counted.length > MAX_FILES },
    file(name) {
      const found = counted.find(file => file.path === name);
      if (!found) throw new BridgeError('That file has no change this chat recorded.', 409);
      return { diff: found.diff.slice(0, DIFF_LIMIT), truncated: found.diff.length > DIFF_LIMIT, binary: false };
    },
    diff() {
      const text = counted.map(file => `--- a/${file.path}\n+++ b/${file.path}\n${file.diff}`).join('');
      return { diff: text.slice(0, DIFF_LIMIT), truncated: text.length > DIFF_LIMIT };
    },
  };
}
