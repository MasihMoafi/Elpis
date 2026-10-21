import path from 'node:path';
import { BridgeError } from './client.mjs';

const DIFF_LIMIT = 400_000, MAX_FILES = 200;
const STATUS = { add: 'added', delete: 'deleted', update: 'modified' };

/** One recorded change as unified-diff hunks: an update's diff already is one (a bare one gets a header); a created or
 * deleted file's diff is its whole text, so every line is added or removed. */
function hunks(kind, diff) {
  const text = typeof diff === 'string' ? diff.replace(/\n*Moved to: .*\s*$/, '') : '';
  if (kind === 'update') {
    const body = !text ? '' : /^@@ /m.test(text) ? text.slice(text.search(/^@@ /m)) : `@@ -1 +1 @@\n${text}`;
    return body && !body.endsWith('\n') ? `${body}\n` : body;
  }
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
      if (typeof change?.path !== 'string' || !change.path || change.path.includes('\0')) continue;
      const kind = ['add', 'delete'].includes(change.kind?.type) ? change.kind.type : 'update';
      const absolute = path.resolve(root, change.path), relative = path.relative(root, absolute);
      const name = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative.split(path.sep).join('/') : absolute;
      const file = files.get(name) ?? { path: name, status: STATUS[kind], diff: '', binary: false, truncated: false, added: 0, removed: 0 };
      file.status = kind === 'update' && file.status === 'added' ? 'added' : STATUS[kind];
      const binary = typeof change.diff === 'string' && (change.diff.includes('\0') || /^(?:Binary files .* differ|GIT binary patch)$/m.test(change.diff));
      file.binary ||= binary;
      const body = binary ? '' : hunks(kind, change.diff);
      for (const line of body.split('\n')) if (line.startsWith('+')) file.added++; else if (line.startsWith('-')) file.removed++;
      file.truncated ||= file.diff.length + body.length > DIFF_LIMIT;
      file.diff += body.slice(0, DIFF_LIMIT - file.diff.length);
      files.set(name, file);
    }
  }
  const counted = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const shown = counted.slice(0, MAX_FILES);
  return {
    changes: { root, recorded: true, files: shown.map(({ diff, truncated, ...file }) => file), truncated: counted.length > MAX_FILES },
    file(name) {
      if (typeof name !== 'string' || !name || name.length > 4096 || name.includes('\0') || name.split('/').includes('..')) throw new BridgeError('Choose a file from the list of changes.', 400);
      const found = counted.find(file => file.path === name);
      if (!found) throw new BridgeError('That file has no change this chat recorded.', 409);
      return { diff: found.binary ? '' : found.diff, truncated: found.truncated, binary: found.binary };
    },
    diff() {
      let diff = '', truncated = false;
      for (const file of counted) {
        const text = `--- a/${file.path}\n+++ b/${file.path}\n${file.binary ? 'Binary file; no text lines were recorded.\n' : file.diff}`;
        truncated ||= file.truncated || diff.length + text.length > DIFF_LIMIT;
        diff += text.slice(0, DIFF_LIMIT - diff.length);
      }
      return { diff, truncated };
    },
  };
}
