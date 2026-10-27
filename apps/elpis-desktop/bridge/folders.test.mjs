import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { listFolders } from './folders.mjs';
import { startDesktopServer } from './server.mjs';
import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';

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

async function workspaceServer(t, root, profile, methods = {}) {
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}), ...methods };
  const app = await startDesktopServer({ client, staticDir: root, ...(profile ? { elpisHome: profile } : {}),
    trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'drawing'), screenshots: path.join(root, 'screenshots') } });
  t.after(async () => { await app.close(); removeTestTempDir(root); });
  const launch = new URL(app.url), origin = launch.origin;
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch.hash.slice(7) }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  return { origin, cookie,
    request: (headers = {}) => fetch(origin + '/api/workflows/workspace', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: '{}' }),
  };
}

test('POST /api/workflows/workspace requires session and origin; each profile keeps one private non-Git sandbox and its contents', async t => {
  const ambient = process.env.ELPIS_HOME;
  t.after(() => { if (ambient === undefined) delete process.env.ELPIS_HOME; else process.env.ELPIS_HOME = ambient; });
  for (const explicit of [true, false]) {
    const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-workspace-'));
    const ambientHome = path.join(root, 'ambient'), profile = explicit ? path.join(root, 'selected') : ambientHome;
    process.env.ELPIS_HOME = ambientHome;
    const app = await workspaceServer(t, root, explicit ? profile : undefined), cwd = path.join(profile, 'workflows', 'sandbox');
    const noSession = await app.request({ Cookie: '' });
    assert.equal(noSession.status, 401);
    const noOrigin = await app.request({ Origin: '' });
    assert.equal(noOrigin.status, 403);
    await assert.rejects(fs.stat(cwd), { code: 'ENOENT' }, 'refused requests never create the sandbox');
    const first = await app.request();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { cwd });
    const stat = await fs.stat(cwd);
    assert.ok(stat.isDirectory());
    assert.equal(stat.mode & 0o777, 0o700);
    await assert.rejects(fs.stat(path.join(cwd, '.git')), { code: 'ENOENT' }, 'a workflow sandbox does not initialize Git');
    const report = path.join(cwd, 'report.md');
    await fs.writeFile(report, 'Keep this report.');
    await fs.chmod(cwd, 0o755);
    const again = await app.request();
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { cwd });
    const reused = await fs.stat(cwd);
    assert.deepEqual([reused.dev, reused.ino], [stat.dev, stat.ino], 'reopening reuses the existing folder');
    assert.equal(reused.mode & 0o777, 0o700, 'an existing sandbox is private too');
    assert.equal(await fs.readFile(report, 'utf8'), 'Keep this report.');
    if (explicit) await assert.rejects(fs.stat(path.join(ambientHome, 'workflows', 'sandbox')), { code: 'ENOENT' }, 'the explicit profile wins over the ambient profile');
  }
});

test('POST /api/workflows/workspace reports a blocked path without replacing the existing file or returning a cwd', async t => {
  for (const blocked of ['workflows', 'workflows/sandbox']) {
    const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-workspace-blocked-')), profile = path.join(root, 'profile');
    const file = path.join(profile, blocked);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'Keep the blocking file.');
    const app = await workspaceServer(t, root, profile);
    const response = await app.request(), result = await response.json();
    assert.equal(response.status, 500);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.cwd, undefined);
    assert.equal(await fs.readFile(file, 'utf8'), 'Keep the blocking file.');
  }
});


test('POST /api/workflows/:UUID/resume authenticates and forwards the ACP run identity and model choice', async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-workflow-resume-')), calls = [];
  const id = '12345678-1234-4234-8234-123456789abc', threadId = 'abcdef01-1234-4234-8234-123456789abc';
  const result = { graphId: id, threadId, turnId: id };
  const app = await workspaceServer(t, root, path.join(root, 'profile'), {
    async resumeWorkflow(...args) { calls.push(args); return result; },
  });
  const route = `/api/workflows/${id}/resume`, body = { model: 'fixture-model', provider: 'fixture' };
  const post = (headers = {}, target = route) => fetch(app.origin + target, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', Cookie: app.cookie, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ Cookie: '' })).status, 401);
  assert.equal((await post({ Origin: '' })).status, 403);
  assert.equal((await post({}, `/api/workflows/wf_${id}/resume`)).status, 404, 'script-run IDs do not reach the ACP resume route');
  assert.deepEqual(calls, []);
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls, [[id, body]], 'the existing graph and requested model reach the resume owner unchanged');
});
