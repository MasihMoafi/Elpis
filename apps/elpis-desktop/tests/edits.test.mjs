// What a turn's edits are, read from the engine's fileChange items: the lines each change shows and the +N −M it counts.
// An update's diff is Git's unified diff; a created or deleted file's "diff" is the file's whole text (codex-rs
// app-server-protocol item_builders.rs), so every line of it is added or removed. Counts, as in Claude's rows, are of
// completed edits only, and the same file edited twice is one file with the sums.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeLines, fileEdits, lineCounts, shortPath, turnEdits } from '../lib/diff.ts';

const UPDATE = '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n';
const change = (path, kind, diff, extra = {}) => ({ path, kind: { type: kind, ...extra }, diff });
const edit = (id, status, ...changes) => ({ id, type: 'fileChange', status, changes });

test('a created file is all added lines and a deleted file all removed lines, numbered from 1', () => {
  assert.deepEqual(changeLines('add', 'a\nb\n').map(line => [line.kind, line.newNo, line.oldNo, line.text]), [['add', 1, null, 'a'], ['add', 2, null, 'b']]);
  assert.deepEqual(changeLines('delete', 'x\ny').map(line => [line.kind, line.oldNo, line.newNo, line.text]), [['del', 1, null, 'x'], ['del', 2, null, 'y']]);
  assert.deepEqual(changeLines('add', ''), [], 'an empty file has no lines');
  assert.deepEqual(changeLines('add', 'a\n\nb\n').map(line => line.text), ['a', '', 'b'], 'a blank line in the middle is a line');
});

test('an update is read as the unified diff it is; a diff with no hunk header is read as one hunk; "Moved to" is a note, not a line', () => {
  const lines = changeLines('update', UPDATE);
  assert.deepEqual(lineCounts(lines), { added: 2, removed: 1 });
  assert.deepEqual(lineCounts(changeLines('update', '- a\n+ b\n+ c')), { added: 2, removed: 1 }, 'no @@ line: still +2 −1');
  assert.equal(changeLines('update', '- a\n+ b').some(line => line.kind === 'hunk'), false, 'the made-up header is not shown');
  const moved = changeLines('update', `${UPDATE}\nMoved to: /w/new.ts`);
  assert.deepEqual(lineCounts(moved), { added: 2, removed: 1 }, 'the trailer is not a context line');
  assert.deepEqual(moved.at(-1), { kind: 'note', text: 'Moved to /w/new.ts', oldNo: null, newNo: null });
});

test('a path is its file name and the folders above it, shortened from the left', () => {
  assert.deepEqual(shortPath('/tmp/parity-fixture/src/lib/parser.ts'), { name: 'parser.ts', hint: '…/src/lib' });
  assert.deepEqual(shortPath('src/lib/parser.ts'), { name: 'parser.ts', hint: 'src/lib' });
  assert.deepEqual(shortPath('src/app.ts'), { name: 'app.ts', hint: 'src' });
  assert.deepEqual(shortPath('README.md'), { name: 'README.md', hint: '' });
  assert.deepEqual(shortPath('C:\\work\\src\\app.ts'), { name: 'app.ts', hint: '…/work/src' });
});

test('one item gives a row per change, each with its verb, kind and counts', () => {
  const rows = fileEdits(edit('e', 'completed', change('src/app.ts', 'update', UPDATE), change('notes/new.md', 'add', 'hello\nworld\n'), change('notes/old.md', 'delete', 'bye\n')));
  assert.deepEqual(rows.map(row => [row.path, row.kind, row.added, row.removed, row.status]), [
    ['src/app.ts', 'update', 2, 1, 'completed'], ['notes/new.md', 'add', 2, 0, 'completed'], ['notes/old.md', 'delete', 0, 1, 'completed'],
  ]);
  assert.deepEqual(fileEdits({ id: 'x', type: 'fileChange', status: 'completed' }), [], 'an item with no readable list has no rows');
});

test('a turn counts completed edits only, and a file edited twice is one file with the sums', () => {
  const items = [
    edit('1', 'completed', change('/w/src/app.ts', 'update', UPDATE)),
    edit('2', 'failed', change('/w/src/broken.ts', 'update', UPDATE)),
    edit('3', 'completed', change('/w/src/app.ts', 'update', '@@ -1 +1 @@\n-a\n+b\n'), change('/w/notes/new.md', 'add', 'x\ny\nz\n')),
    { id: 'c', type: 'commandExecution', command: 'ls' },
  ];
  const turn = turnEdits(items);
  assert.deepEqual(turn.files.map(file => [file.path, file.added, file.removed]), [['/w/src/app.ts', 3, 2], ['/w/notes/new.md', 3, 0]], 'the same file twice is one row');
  assert.deepEqual([turn.added, turn.removed], [6, 2]);
  assert.equal(turn.files[0].lines.filter(line => line.kind === 'hunk').length, 2, 'both edits are in the file\'s lines');
  assert.deepEqual(turnEdits([edit('f', 'failed', change('a.ts', 'update', UPDATE))]), { files: [], added: 0, removed: 0 });
});
