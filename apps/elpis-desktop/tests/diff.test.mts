import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../lib/diff.ts';

const diff = `diff --git a/keep.txt b/keep.txt
index 1111111..2222222 100644
--- a/keep.txt
+++ b/keep.txt
@@ -1,3 +1,4 @@ function head()
 one
-two
+TWO
 three
+four
@@ -20,2 +21,2 @@
 tail
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

test('a unified diff becomes lines with their old and new line numbers', () => {
  assert.deepEqual(parseDiff(diff).map(line => [line.kind, line.oldNo, line.newNo, line.text]), [
    ['hunk', null, null, '@@ -1,3 +1,4 @@ function head()'],
    ['ctx', 1, 1, 'one'], ['del', 2, null, 'two'], ['add', null, 2, 'TWO'], ['ctx', 3, 3, 'three'], ['add', null, 4, 'four'],
    ['hunk', null, null, '@@ -20,2 +21,2 @@'],
    ['ctx', 20, 21, 'tail'], ['del', 21, null, 'old'], ['note', null, null, '\\ No newline at end of file'], ['add', null, 22, 'new'], ['note', null, null, '\\ No newline at end of file'],
  ]);
});

test('the file header is dropped, a new file counts from 1, an empty diff has no lines', () => {
  const added = 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n';
  assert.deepEqual(parseDiff(added).filter(line => line.kind === 'add').map(line => [line.newNo, line.text]), [[1, 'a'], [2, 'b']]);
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('\n'), []);
});

test('a line that starts with --- or +++ inside a hunk is still a removed or added line', () => {
  const lines = parseDiff('@@ -1,2 +1,2 @@\n---- dashes\n++++ plus\n');
  assert.deepEqual(lines.slice(1).map(line => [line.kind, line.text]), [['del', '--- dashes'], ['add', '+++ plus']]);
});
