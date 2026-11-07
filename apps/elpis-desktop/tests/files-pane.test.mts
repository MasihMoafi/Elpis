// lib/files-pane.ts: the Files tab's tree, its preview and kept tabs, a draft that survives a failed refresh, and an HTML
// file from a reply opening as a page in the built-in browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import './alias.mts';
import type { Listing } from '../lib/files-pane.ts';

let read = () => ({ content: 'saved text\n', size: 11, mtimeMs: 1 });
globalThis.fetch = async () => { try { return Response.json(read()); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); } };
const files = await import('../lib/files-pane.ts');
const cwd = '/repo', pane = () => files.paneIn(files.snapshot(), cwd), doc = (path: string) => files.snapshot().docs[files.docKey(cwd, path)];

test('the tree lists an opened folder under it, indented, and says when a folder is loading, unreadable or empty', () => {
  const p = { ...pane(), expanded: ['src', 'src/lib'] }, key = (dir: string) => files.dirKey(cwd, dir, false);
  const dirs: Record<string, Listing> = { [key('')]: { status: 'ready', entries: [{ name: 'src', dir: true }, { name: 'docs', dir: true }, { name: 'README.md', dir: false }] },
    [key('src')]: { status: 'ready', entries: [{ name: 'lib', dir: true }, { name: 'main.ts', dir: false, link: true }] },
    [key('src/lib')]: { status: 'error', message: 'denied' } };
  assert.deepEqual(files.treeRows(cwd, p, dirs).map(row => row.kind === 'entry' ? `${row.depth}:${row.path}${row.expanded ? '/' : ''}` : `${row.depth}:${row.text}`),
    ['0:src/', '1:src/lib/', '2:Couldn’t read this folder.', '1:src/main.ts', '0:docs', '0:README.md']);
  assert.deepEqual(files.treeRows(cwd, { ...p, expanded: ['docs'] }, { ...dirs, [key('docs')]: { status: 'ready', entries: [] } }).map(row => row.kind === 'note' ? row.text : row.path), ['src', 'docs', 'Folder is empty', 'README.md']);
  const root = dirs[key('')]; assert.ok(root);
  const note = files.treeRows(cwd, { ...p, expanded: ['docs'] }, { [key('')]: root }).find(row => row.kind === 'note');
  assert.ok(note && note.kind === 'note'); assert.equal(note.text, 'Loading…');
});

test('a click previews a file in a tab the next preview replaces; keeping or editing it keeps the tab', async () => {
  files.attach(cwd);
  await files.openFile(cwd, 'a.md', { preview: true });
  await files.openFile(cwd, 'b.md', { preview: true });
  assert.deepEqual(pane().open.map(file => file.path), ['b.md'], 'the preview tab is replaced');
  files.keep(cwd, 'b.md');
  await files.openFile(cwd, 'c.md', { preview: true });
  assert.deepEqual(pane().open.map(file => [file.path, file.preview]), [['b.md', false], ['c.md', true]]);
  files.edit(cwd, 'c.md', 'typed');
  const edited = pane().open.find(file => file.path === 'c.md'); assert.ok(edited);
  assert.equal(edited.preview, false, 'editing keeps the tab');
});

test('a failed refresh keeps the text typed while it was reading', async () => {
  await files.openFile(cwd, 'draft.md');
  files.edit(cwd, 'draft.md', 'my unsaved words');
  read = () => { throw new Error('read failed'); };
  await files.loadDoc(cwd, 'draft.md');
  const draft = doc('draft.md'); assert.ok(draft && draft.status === 'ready');
  assert.equal(draft.text, 'my unsaved words');
  assert.equal(files.isDirty(draft), true);
  read = () => ({ content: 'saved text\n', size: 11, mtimeMs: 1 });
});

test('an HTML file in a reply opens as a page in the built-in browser; with a line it opens as text', () => {
  const pages: string[] = []; const stop = files.onOpenPage(abs => pages.push(abs));
  assert.equal(files.openRef({ path: 'site/index.html' }), true);
  assert.deepEqual(pages, ['/repo/site/index.html']);
  files.openRef({ path: 'site/index.html', line: 3 });
  assert.equal(pages.length, 1); assert.equal(pane().active, 'site/index.html');
  stop();
});
