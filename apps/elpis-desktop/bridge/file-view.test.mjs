// The Files pane's side of the bridge: one folder's entries at a time (the tree), one file's text (the viewer), saving
// it back (in-place editing) and a search of the files' contents. Temporary folders only; nothing outside them is read.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { BridgeError } from './client.mjs';
import { listDirectory, readFile, writeFile, searchFiles } from './files.mjs';
import { startDesktopServer } from './server.mjs';

const tempRoot = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-file-view-'));
after(() => promisify(execFile)('gio', ['trash', tempRoot]));

async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'elpis-view-')));
  const put = async (file, content = 'x') => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); };
  await put('README.md', '# Parser\nA tiny parser.\n');
  await put('package.json', '{}\n');
  await put('src/app.ts', 'import { parse } from "./lib/parser";\nparse();\n');
  await put('src/lib/parser.ts', 'export function parse() {\n  return 1;\n}\n');
  await put('src/Zeta.ts', 'z');
  await put('docs/guide.md', 'Guide about the PARSER.\n');
  await put('.env', 'SECRET=1\n');
  await put('.git/config', '[core]\n');
  await put('node_modules/pkg/index.js', 'parser');
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
  await fs.writeFile(path.join(root, 'big.txt'), 'a'.repeat(600 * 1024));
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'linked.md'));
  const outside = await fs.mkdtemp(path.join(tempRoot, 'elpis-view-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  return { root, outside };
}
const cleanup = (t, ...dirs) => t.after(() => promisify(execFile)('gio', ['trash', ...dirs]));
const refused = (promise, status, message) => assert.rejects(promise, error => error instanceof BridgeError && error.status === status && message.test(error.message));

test('lists one folder: folders first, then files, each in name order; dot entries and generated folders stay out', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const top = (await listDirectory(root, '')).data;
  assert.deepEqual(top.map(entry => entry.name), ['docs', 'src', 'big.txt', 'blob.bin', 'escape.txt', 'linked.md', 'package.json', 'README.md']);
  assert.deepEqual(top.filter(entry => entry.dir).map(entry => entry.name), ['docs', 'src']);
  assert.deepEqual((await listDirectory(root, 'src')).data.map(entry => entry.name), ['lib', 'app.ts', 'Zeta.ts'], 'case does not decide the order');
  assert.deepEqual((await listDirectory(root, 'src/lib')).data, [{ name: 'parser.ts', dir: false }]);
});

test('a symlink inside the folder is listed and marked as a link; hidden entries come on request, but never .git', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const top = (await listDirectory(root, '')).data;
  assert.deepEqual(top.find(entry => entry.name === 'linked.md'), { name: 'linked.md', dir: false, link: true });
  const hidden = (await listDirectory(root, '', true)).data.map(entry => entry.name);
  assert.ok(hidden.includes('.env'));
  assert.ok(!hidden.includes('.git') && !hidden.includes('node_modules'));
});

test('refuses a folder outside the project, a file named as a folder and a missing folder', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  await refused(listDirectory(root, '../'), 400, /outside/i);
  await refused(listDirectory(root, outside), 400, /outside/i);
  await refused(listDirectory(root, 'README.md'), 400, /folder/i);
  await refused(listDirectory(root, 'nope'), 404, /folder/i);
  await refused(listDirectory('relative', ''), 400, /absolute/i);
});

test('reads a text file by a path inside the project, relative or absolute, with its size and modification time', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const info = await fs.stat(path.join(root, 'src/lib/parser.ts'));
  const expected = { path: 'src/lib/parser.ts', content: 'export function parse() {\n  return 1;\n}\n', size: info.size, mtimeMs: info.mtimeMs };
  assert.deepEqual(await readFile(root, 'src/lib/parser.ts'), expected);
  assert.deepEqual(await readFile(root, path.join(root, 'src/lib/parser.ts')), expected);
  assert.deepEqual(await readFile(root, './src/../src/lib/parser.ts'), expected);
});

test('says so for a binary file or one over 512 KB, instead of sending it; refuses what lies outside the project', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  assert.deepEqual(await readFile(root, 'blob.bin'), { path: 'blob.bin', binary: true, size: 5 });
  assert.deepEqual(await readFile(root, 'big.txt'), { path: 'big.txt', tooLarge: true, size: 600 * 1024 });
  await refused(readFile(root, '../etc/passwd'), 400, /outside/i);
  await refused(readFile(root, path.join(outside, 'secret.txt')), 400, /outside/i);
  await refused(readFile(root, 'escape.txt'), 400, /outside/i);
  await refused(readFile(root, 'src'), 400, /file/i);
  await refused(readFile(root, 'missing.ts'), 404, /No such file in .*: missing\.ts/);
  await refused(readFile(root, ''), 400, /path/i);
});

test('saves a file in place when it has not changed since it was read; keeps its mode; reports the new time', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  await fs.chmod(path.join(root, 'package.json'), 0o754);
  const before = await readFile(root, 'package.json');
  const saved = await writeFile(root, 'package.json', '{ "name": "x" }\n', before.mtimeMs);
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{ "name": "x" }\n');
  assert.equal((await fs.stat(path.join(root, 'package.json'))).mode & 0o777, 0o754);
  assert.equal(saved.path, 'package.json'); assert.equal(saved.size, 16);
  assert.equal(saved.mtimeMs, (await fs.stat(path.join(root, 'package.json'))).mtimeMs);
});

test('refuses to save over a file that changed on disk, a missing file, a file outside the project or inside .git, and a bad body', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const read = await readFile(root, 'README.md');
  await fs.writeFile(path.join(root, 'README.md'), 'changed elsewhere\n'); await fs.utimes(path.join(root, 'README.md'), new Date(), new Date(read.mtimeMs + 5000));
  await refused(writeFile(root, 'README.md', 'mine', read.mtimeMs), 409, /changed/i);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'changed elsewhere\n');
  await refused(writeFile(root, 'new.ts', 'x', 0), 404, /file/i);
  await refused(writeFile(root, path.join(outside, 'secret.txt'), 'x', 0), 400, /outside/i);
  await refused(writeFile(root, 'escape.txt', 'x', 0), 400, /outside/i);
  await refused(writeFile(root, '.git/config', 'x', 0), 400, /\.git/i);
  await refused(writeFile(root, 'src', 'x', 0), 400, /file/i);
  await refused(writeFile(root, 'package.json', 42, 0), 400, /text/i);
  await refused(writeFile(root, 'package.json', 'x', 'soon'), 400, /time/i);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
});

test('searches file contents, ignoring case: one row per matching line, in path then line order, skipping binary, large and generated files', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const found = await searchFiles(root, 'parser');
  assert.deepEqual(found.data, [
    { path: 'README.md', line: 1, text: '# Parser' },
    { path: 'README.md', line: 2, text: 'A tiny parser.' },
    { path: 'docs/guide.md', line: 1, text: 'Guide about the PARSER.' },
    { path: 'src/app.ts', line: 1, text: 'import { parse } from "./lib/parser";' },
  ]);
  assert.equal(found.truncated, false);
  assert.deepEqual((await searchFiles(root, 'zzz')).data, []);
  await refused(searchFiles(root, ''), 400, /search/i);
  await refused(searchFiles(root, 'x'.repeat(201)), 400, /search/i);
});

test('caps a search at 200 rows and says it was cut; cuts a long line', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'elpis-view-many-'))); cleanup(t, root);
  await fs.writeFile(path.join(root, 'a.txt'), Array.from({ length: 250 }, (_, i) => `hit ${i}`).join('\n'));
  await fs.writeFile(path.join(root, 'b.txt'), `hit ${'y'.repeat(500)}`);
  const found = await searchFiles(root, 'hit');
  assert.equal(found.data.length, 200); assert.equal(found.truncated, true);
  const long = (await searchFiles(root, 'yyy')).data[0];
  assert.ok(long.text.length <= 240, `the row keeps ${long.text.length} characters`);
});

test('the routes need the session and answer the same as the functions, with a 4xx message for a bad request', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) };
  const app = await startDesktopServer({ client, staticDir: root, elpisHome: path.join(tempRoot, 'home'), loveSpot: { directory: path.join(tempRoot, 'love-spot'), screenshots: path.join(tempRoot, 'screenshots') } }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const q = (route, params) => `${route}?${new URLSearchParams(params)}`;
  assert.equal((await fetch(origin + q('/api/file', { cwd: root, path: 'README.md' }))).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } });
  const post = (pathname, body) => fetch(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  const dir = await get(q('/api/files/dir', { cwd: root, dir: 'src' }));
  assert.equal(dir.status, 200); assert.deepEqual((await dir.json()).data.map(entry => entry.name), ['lib', 'app.ts', 'Zeta.ts']);
  assert.deepEqual((await (await get(q('/api/files/dir', { cwd: root, dir: '', hidden: '1' }))).json()).data.some(entry => entry.name === '.env'), true);
  const file = await get(q('/api/file', { cwd: root, path: 'src/lib/parser.ts' }));
  const body = await file.json(); assert.equal(file.status, 200); assert.match(body.content, /return 1/);
  const saved = await post('/api/file', { cwd: root, path: 'src/lib/parser.ts', content: 'export {}\n', mtimeMs: body.mtimeMs });
  assert.equal(saved.status, 200); assert.equal(await fs.readFile(path.join(root, 'src/lib/parser.ts'), 'utf8'), 'export {}\n');
  const stale = await post('/api/file', { cwd: root, path: 'src/lib/parser.ts', content: 'again', mtimeMs: body.mtimeMs });
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /changed/i);
  assert.equal((await post('/api/file', { cwd: root, path: 'src/lib/parser.ts', content: 'x', mtimeMs: 1, extra: true })).status, 400);
  const search = await get(q('/api/files/search', { cwd: root, q: 'guide' }));
  assert.equal(search.status, 200); assert.equal((await search.json()).data[0].path, 'docs/guide.md');
  for (const [route, params] of [['/api/file', { cwd: root }], ['/api/file', { cwd: root, path: '../x' }], ['/api/files/dir', { cwd: root, dir: '../' }], ['/api/files/search', { cwd: root }], ['/api/files/search', { cwd: 'relative', q: 'x' }]]) {
    const response = await get(q(route, params)); assert.equal(response.status, 400, `${route} ${JSON.stringify(params)}`);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await get(q('/api/file', { cwd: root, path: 'nope.ts' }))).status, 404);
});

test('a PDF is described as a document, including one larger than the text editor limit', async t => {
  const root = await fs.mkdtemp(path.join(tempRoot, 'elpis-pdf-view-')); cleanup(t, root);
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600 * 1024, 32)]);
  await fs.writeFile(path.join(root, 'report.pdf'), bytes);
  const file = await readFile(root, 'report.pdf');
  assert.equal(file.preview, 'pdf', 'PDF bytes must not enter the source editor or its 512 KB limit');
  assert.equal(file.content, undefined);
  assert.equal(file.size, bytes.length);
});

test('preview assets require the app session and canonical project path and serve only validated documents or images', async t => {
  const { root, outside } = await project(); cleanup(t, root, outside);
  const pdf = Buffer.from('%PDF-1.4\nprivate document bytes\n%%EOF\n');
  await fs.writeFile(path.join(root, 'report.pdf'), pdf);
  const named = 'گزارش "alpha" (draft)\'s*!.pdf';
  await fs.writeFile(path.join(root, 'docs', named), pdf);
  await fs.writeFile(path.join(root, 'fake.pdf'), '<script>window.executed=true</script>');
  await fs.writeFile(path.join(root, 'fake.png'), '<html>not an image</html>');
  await fs.writeFile(path.join(root, 'oversized.pdf'), '%PDF-1.4\n');
  await fs.truncate(path.join(root, 'oversized.pdf'), 31 * 1024 * 1024);
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) };
  const app = await startDesktopServer({ client, staticDir: root, elpisHome: path.join(tempRoot, 'home'), loveSpot: { directory: path.join(tempRoot, 'love-spot'), screenshots: path.join(tempRoot, 'screenshots') } }); t.after(() => app.close());
  const launch = new URL(app.url), origin = launch.origin;
  const asset = (target, extra = {}) => `${origin}/api/file/asset?${new URLSearchParams({ cwd: root, path: target, ...extra })}`;
  assert.equal((await fetch(asset('report.pdf'))).status, 401);
  const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get('token') }) });
  const headers = { Cookie: auth.headers.get('set-cookie').split(';')[0] };
  const response = await fetch(asset('report.pdf'), { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  const titled = await fetch(asset(`docs/${named}`), { headers });
  assert.equal(titled.status, 200);
  const disposition = titled.headers.get('content-disposition');
  t.diagnostic(`Document filename header: ${disposition}`);
  assert.match(disposition, /^inline; filename\*=UTF-8''[\x21-\x7e]+$/);
  const encoded = disposition.slice("inline; filename*=UTF-8''".length);
  assert.equal(decodeURIComponent(encoded), named, 'only the actual basename, including Unicode and quotes, reaches the viewer');
  assert.doesNotMatch(encoded, /["'()*]/, 'RFC5987 punctuation is encoded rather than inserted into headers');
  assert.equal(response.headers.get('content-disposition'), "inline; filename*=UTF-8''report.pdf");
  for (const target of ['README.md', 'fake.pdf', 'fake.png', 'escape.txt', '../secret.txt']) {
    assert.equal((await fetch(asset(target), { headers })).status, 400, target);
  }
  assert.equal((await fetch(asset('oversized.pdf'), { headers })).status, 413);
  assert.equal((await fetch(asset('report.pdf', { extra: '1' }), { headers })).status, 400);
  assert.equal((await fetch(asset('report.pdf'), { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
});
