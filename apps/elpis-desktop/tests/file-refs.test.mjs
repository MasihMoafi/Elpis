import test from 'node:test';
import assert from 'node:assert/strict';
import { findPaths, parseCodeRef, parseHref, resolveRef } from '../lib/file-refs.ts';
import { rankFiles } from '../lib/mentions.ts';

// The path forms Claude's desktop app links (its transcript's file refs): an inline code span that is a path with a
// folder and an extension, optionally with :line, :line-endLine or :line:column; a Markdown link to a path, a
// file:/// address or a path#L5-L20; and an absolute path written in plain text.

test('inline code is a file ref when it is a path with a folder and an extension; :line, :line-end and :line:column set the lines', () => {
  assert.deepEqual(parseCodeRef('src/lib/parser.ts'), { path: 'src/lib/parser.ts' });
  assert.deepEqual(parseCodeRef('src/lib/parser.ts:12'), { path: 'src/lib/parser.ts', line: 12 });
  assert.deepEqual(parseCodeRef('src/lib/parser.ts:12-20'), { path: 'src/lib/parser.ts', line: 12, endLine: 20 });
  assert.deepEqual(parseCodeRef('src/lib/parser.ts:20-12'), { path: 'src/lib/parser.ts', line: 12, endLine: 20 }, 'a backwards range is turned round');
  assert.deepEqual(parseCodeRef('src/lib/parser.ts:12:5'), { path: 'src/lib/parser.ts', line: 12 }, 'the column is dropped');
  assert.deepEqual(parseCodeRef('/tmp/work/src/app.ts:3'), { path: '/tmp/work/src/app.ts', line: 3 });
  assert.deepEqual(parseCodeRef('./README.md'), { path: './README.md' });
  assert.deepEqual(parseCodeRef('src/(app)/[id]/page.tsx'), { path: 'src/(app)/[id]/page.tsx' }, 'route folders keep their brackets');
  assert.deepEqual(parseCodeRef('src/lib/parser.ts:0'), { path: 'src/lib/parser.ts' }, 'line 0 is no line');
});

test('inline code that is not a path stays code', () => {
  for (const text of ['parser.ts', 'lexer.ts:4', 'src/lib', 'npm run build', 'a b/c.ts', 'https://example.com/a/b.html', 'git commit -m "x/y.z"', 'foo()', '', '/']) {
    assert.equal(parseCodeRef(text), null, text);
  }
});

test('a Markdown link target is a file ref when it is a path, a file:/// address or a path#L5-L20', () => {
  assert.deepEqual(parseHref('/tmp/work/notes.md:12'), { path: '/tmp/work/notes.md', line: 12 });
  assert.deepEqual(parseHref('src/a.ts'), { path: 'src/a.ts' });
  assert.deepEqual(parseHref('src/a.ts#L7'), { path: 'src/a.ts', line: 7 });
  assert.deepEqual(parseHref('src/a.ts#L5-L20'), { path: 'src/a.ts', line: 5, endLine: 20 });
  assert.deepEqual(parseHref('src/a.ts#L5-20'), { path: 'src/a.ts', line: 5, endLine: 20 });
  assert.deepEqual(parseHref('file:///tmp/work/a%20b.ts#L5-L20'), { path: '/tmp/work/a b.ts', line: 5, endLine: 20 });
  assert.deepEqual(parseHref('file:///tmp/work/a.ts'), { path: '/tmp/work/a.ts' });
  for (const href of ['https://example.com/a.html', 'http://x.y', 'mailto:a@b.c', '#heading', '//host/path.ts', '', 'javascript:alert(1)']) {
    assert.equal(parseHref(href), null, href);
  }
});

test('an absolute path written in plain text is found with its :line and :line:column, without the sentence around it', () => {
  const found = text => findPaths(text).map(part => typeof part === 'string' ? part : `[${part.text}]`);
  assert.deepEqual(found('See /tmp/work/src/app.ts:3:5, then stop.'), ['See ', '[/tmp/work/src/app.ts:3:5]', ', then stop.']);
  assert.deepEqual(found('Edited /tmp/work/README.md.'), ['Edited ', '[/tmp/work/README.md]', '.']);
  assert.deepEqual(found('(see /tmp/work/a.ts)'), ['(see ', '[/tmp/work/a.ts]', ')']);
  assert.deepEqual(found('at https://example.com/a/b.html now'), ['at https://example.com/a/b.html now'], 'a web address is not a file');
  assert.deepEqual(found('the a/b.ts file'), ['the a/b.ts file'], 'a relative path in plain text is left alone');
  assert.deepEqual(found('nothing here'), ['nothing here']);
  const [, ref] = findPaths('/tmp/x/y.ts:9 ok').map(part => typeof part === 'string' ? null : part);
  assert.equal(ref, null);
  assert.deepEqual(findPaths('/tmp/x/y.ts:9 ok')[0].ref, { path: '/tmp/x/y.ts', line: 9 });
});

test('a ref is inside the chat folder, or outside it, with its absolute and relative path', () => {
  const cwd = '/tmp/work';
  assert.deepEqual(resolveRef({ path: 'src/a.ts', line: 3 }, cwd), { abs: '/tmp/work/src/a.ts', rel: 'src/a.ts', inside: true, line: 3 });
  assert.deepEqual(resolveRef({ path: './src/../src/a.ts' }, cwd), { abs: '/tmp/work/src/a.ts', rel: 'src/a.ts', inside: true });
  assert.deepEqual(resolveRef({ path: '/tmp/work/docs/g.md', line: 2, endLine: 4 }, cwd), { abs: '/tmp/work/docs/g.md', rel: 'docs/g.md', inside: true, line: 2, endLine: 4 });
  assert.equal(resolveRef({ path: '/tmp/work-other/a.ts' }, cwd).inside, false, 'a folder that only shares the start of the name is outside');
  assert.equal(resolveRef({ path: '../other/a.ts' }, cwd).inside, false);
  assert.deepEqual(resolveRef({ path: '/etc/hosts.conf' }, cwd), { abs: '/etc/hosts.conf', rel: '/etc/hosts.conf', inside: false });
  assert.equal(resolveRef({ path: 'src/a.ts' }, '').inside, false, 'with no folder a relative path is nowhere');
});

test('fuzzy find ranks by where the query sits, then by letters in order, and keeps every file when nothing is typed', () => {
  const files = ['docs/app-guide.md', 'src/lib/app.ts', 'src/application.ts', 'app.config.js', 'src/other.ts', 'src/lib/parser.ts'];
  assert.deepEqual(rankFiles(files, ''), files);
  assert.deepEqual(rankFiles(files, 'app'), ['app.config.js', 'src/lib/app.ts', 'docs/app-guide.md', 'src/application.ts']);
  assert.deepEqual(rankFiles(files, 'LIB/').slice(0, 2), ['src/lib/app.ts', 'src/lib/parser.ts'], 'case is ignored');
  assert.deepEqual(rankFiles(files, 'lpar'), ['src/lib/parser.ts'], 'letters in order across the path');
  assert.deepEqual(rankFiles(files, 'zzz'), []);
});
