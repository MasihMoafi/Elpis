import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { listFiles } from './files.mjs';
import { startDesktopServer } from './server.mjs';

const files = [
  'README.md', 'package.json', '.env', '.gitignore',
  'src/index.js', 'src/lib/parser.js', 'src/lib/deep/er/est/too-deep.js', 'src/.hidden/secret.js',
  'docs/guide.md', '.git/config', 'node_modules/pkg/index.js', 'src/node_modules/pkg/index.js', 'target/debug/app', 'dist/app.js',
  'build/app.js', 'out/app.js', '.next/cache/x', '__pycache__/x.pyc', 'venv/bin/python',
];
async function tree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-files-'));
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'file'); }
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'linked-file'));
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'linked-docs'));
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'src/linked-inner'));
  return root;
}
async function snapshot(root) {
  const rows = [];
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), info = await fs.lstat(full);
      rows.push([path.relative(root, full), info.mtimeMs, info.size]);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root); return JSON.stringify(rows.sort());
}
// Shallow files first (a breadth-first walk), each level in name order: what the picker offers before anything is typed.
const EXPECTED = ['README.md', 'package.json', 'docs/guide.md', 'src/index.js', 'src/lib/parser.js'];

test('lists files shallow first, skipping dot entries, tool and generated directories, symlinks and anything deeper than four directories', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await listFiles(root), { data: EXPECTED });
});

test('lists only files as repository-relative paths and never writes', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshot(root);
  const { data } = await listFiles(root);
  assert.ok(data.every(row => !row.includes('\\') && !row.startsWith('/') && !row.endsWith('/')));
  assert.ok(!data.some(row => ['docs', 'src', 'src/lib', 'linked-file', 'linked-docs'].includes(row) || row.startsWith('linked-') || row.includes('.env')));
  assert.equal(await snapshot(root), before);
});

test('caps the list at 2000 files, keeping the shallow ones', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-files-many-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'a/b/c'), { recursive: true });
  for (let i = 0; i < 2100; i++) await fs.writeFile(path.join(root, 'a/b/c', `f${String(i).padStart(4, '0')}`), '');
  await fs.writeFile(path.join(root, 'top.txt'), '');
  const { data } = await listFiles(root);
  assert.equal(data.length, 2000); assert.equal(data[0], 'top.txt'); assert.equal(data[1], 'a/b/c/f0000');
});

test('accepts a project path that is itself a symlink without following links inside it', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alias = `${root}-alias`; await fs.symlink(root, alias); t.after(() => fs.unlink(alias));
  assert.deepEqual(await listFiles(alias), { data: EXPECTED });
});

test('refuses a missing, relative or non-directory cwd with a 400 BridgeError', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const refused = async (cwd, message) => assert.rejects(listFiles(cwd), error => error instanceof BridgeError && error.status === 400 && message.test(error.message));
  await refused(undefined, /cwd/i); await refused('', /cwd/i); await refused(42, /cwd/i);
  await refused('relative/path', /absolute/i);
  await refused(path.join(root, 'nope'), /existing directory/i);
  await refused(path.join(root, 'README.md'), /existing directory/i);
});

test('GET /api/files requires the session and answers { data } or a 400 message', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) };
  const app = await startDesktopServer({ client, staticDir: root }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const query = cwd => `/api/files?cwd=${encodeURIComponent(cwd)}`;
  assert.equal((await fetch(origin + query(root))).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } });
  const ok = await get(query(root));
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { data: EXPECTED });
  const bad = async (pathname, message) => { const response = await get(pathname); assert.equal(response.status, 400, pathname); assert.match((await response.json()).error, message); };
  await bad('/api/files', /cwd/i);
  await bad(query('relative'), /absolute/i);
  await bad(query(path.join(root, 'README.md')), /existing directory/i);
  await bad(`${query(root)}&cwd=${encodeURIComponent(root)}`, /cwd/i);
  await bad(`${query(root)}&extra=1`, /cwd/i);
  const post = await fetch(origin + query(root), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' });
  assert.notEqual(post.status, 200);
});
