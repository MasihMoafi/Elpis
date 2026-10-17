import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { listFolders } from './folders.mjs';
import { startDesktopServer } from './server.mjs';

const dirs = [
  'src/lib/deep/deeper', 'src/components', 'src/.hidden/inner', 'docs', 'empty', 'Zed',
  '.git/objects', '.github', 'node_modules/pkg/lib', 'src/node_modules/pkg', 'target/debug', 'dist/js', 'build/x',
  'out/x', '.next/cache', '__pycache__/x', 'venv/bin', 'docs/venv/bin',
];
async function tree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-folders-'));
  for (const dir of dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'file'); await fs.writeFile(path.join(root, 'src/index.js'), 'file');
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'linked-docs'));
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'linked-file'));
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'src/linked-inner'));
  return root;
}
async function snapshot(root) {
  const rows = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name); const info = await fs.lstat(full);
      rows.push([path.relative(root, full), info.mtimeMs, info.size]);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root); return JSON.stringify(rows.sort());
}
const EXPECTED = ['Zed', 'docs', 'empty', 'src', 'src/components', 'src/lib'];

test('lists directories to depth 2, sorted, skipping dot, tool and generated directories and every symlink', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await listFolders(root), { data: EXPECTED });
});

test('lists nothing but directories and never writes', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshot(root);
  const { data } = await listFolders(root);
  assert.ok(data.every(row => !row.includes('\\') && !row.startsWith('/') && !row.endsWith('/')));
  assert.ok(!data.includes('README.md') && !data.includes('src/index.js') && !data.includes('linked-docs') && !data.includes('src/linked-inner'));
  assert.equal(await snapshot(root), before);
});

test('caps the list at 400 entries after sorting', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-folders-many-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 450; i++) await fs.mkdir(path.join(root, `d${String(i).padStart(3, '0')}`));
  const { data } = await listFolders(root);
  assert.equal(data.length, 400); assert.equal(data[0], 'd000'); assert.equal(data[399], 'd399');
});

test('accepts a project path that is itself a symlink to a directory without following links inside it', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alias = `${root}-alias`; await fs.symlink(root, alias); t.after(() => fs.unlink(alias));
  assert.deepEqual(await listFolders(alias), { data: EXPECTED });
});

test('refuses a missing, relative or non-directory cwd with a 400 BridgeError', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const refused = async (cwd, message) => assert.rejects(listFolders(cwd), error => error instanceof BridgeError && error.status === 400 && message.test(error.message));
  await refused(undefined, /cwd/i); await refused('', /cwd/i); await refused(42, /cwd/i);
  await refused('relative/path', /absolute/i); await refused('.', /absolute/i);
  await refused(path.join(root, 'nope'), /existing directory/i);
  await refused(path.join(root, 'README.md'), /existing directory/i);
  await refused(`${root}\0`, /existing directory|cwd/i);
});

test('GET /api/folders requires the session and answers { data } or a 400 message', async t => {
  const root = await tree(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) };
  const app = await startDesktopServer({ client, staticDir: root }); t.after(() => app.close());
  const url = new URL(app.url); const origin = url.origin; const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const query = cwd => `/api/folders?cwd=${encodeURIComponent(cwd)}`;
  assert.equal((await fetch(origin + query(root))).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } });
  const ok = await get(query(root));
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { data: EXPECTED });
  const bad = async (pathname, message) => { const response = await get(pathname); assert.equal(response.status, 400, pathname); assert.match((await response.json()).error, message); };
  await bad('/api/folders', /cwd/i);
  await bad('/api/folders?cwd=', /cwd/i);
  await bad(query('relative'), /absolute/i);
  await bad(query(path.join(root, 'README.md')), /existing directory/i);
  await bad(query(path.join(root, 'nope')), /existing directory/i);
  await bad(`${query(root)}&cwd=${encodeURIComponent(root)}`, /cwd/i);
  await bad(`${query(root)}&extra=1`, /cwd/i);
  const post = await fetch(origin + query(root), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' });
  assert.notEqual(post.status, 200);
});
