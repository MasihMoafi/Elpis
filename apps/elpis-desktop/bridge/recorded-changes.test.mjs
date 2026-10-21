import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
import { recordedChanges } from './recorded-changes.mjs';

const edit = (file, type, diff, status = 'completed') => ({ type: 'fileChange', status, changes: [{ path: file, kind: { type }, diff }] });

test('recorded edits: empty, repeated, deleted, binary and large files use the log only', () => {
  assert.deepEqual(recordedChanges('/notes', []).changes.files, []);
  const log = recordedChanges('/notes', [edit('/notes/a.txt', 'add', 'one\ntwo\n'), edit('/notes/a.txt', 'update', '@@ -2 +2 @@\n-two\n+three\n'),
    edit('/notes/a.txt', 'delete', 'one\nthree\n'), edit('/notes/b.bin', 'add', '\0binary'), edit('/notes/large.txt', 'add', 'x'.repeat(500_000)), edit('/notes/failed', 'add', 'no', 'failed')]);
  assert.equal(log.changes.files.length, 3);
  assert.deepEqual(log.changes.files[0], { path: 'a.txt', status: 'deleted', added: 3, removed: 3, binary: false });
  assert.match(log.file('a.txt').diff, /\+one\n\+two\n@@ -2 \+2 @@\n-two\n\+three\n@@ -1,2 \+0,0 @@\n-one\n-three\n/);
  assert.equal(log.file('b.bin').binary, true);
  assert.equal(log.file('b.bin').diff, '');
  assert.equal(log.file('large.txt').truncated, true);
  assert.ok(log.file('large.txt').diff.length <= 400_000);
  assert.throws(() => log.file('../secret'), /Choose a file/);
  assert.throws(() => log.file('unknown'), /no change/);
  const outside = recordedChanges('/notes', [edit('/other/outside.txt', 'add', 'recorded\n')]);
  assert.equal(outside.changes.files[0].path, '/other/outside.txt');
  assert.match(outside.file('/other/outside.txt').diff, /\+recorded/);
  assert.throws(() => outside.file('/other/unrecorded.txt'), /no change/);
});

test('recorded edits: many files are bounded and separate edits cannot run into each other', () => {
  const log = recordedChanges('/notes', [edit('./a.txt', 'update', '-before\n+after'), edit('/notes/a.txt', 'update', '-after\n+last'),
    ...Array.from({ length: 205 }, (_, i) => edit(`${i}.txt`, 'add', 'new\n'))]);
  assert.equal(log.changes.files.length, 200);
  assert.equal(log.changes.truncated, true);
  assert.match(log.file('a.txt').diff, /\+after\n@@ -1 \+1 @@\n-after\n\+last\n/);
});

// Opt in with a COPY of a real rollout and an installed executable. No provider calls or credentials.
test('real saved session: cold Changes, reload and server validation outside Git', {
  skip: !process.env.ELPIS_TEST_SESSION || !process.env.ELPIS_TEST_ENGINE, timeout: 45000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a25-recorded-'));
  const home = path.join(root, 'home'), folder = path.join(root, 'notes'), sessions = path.join(home, 'sessions/2026/10/17');
  await fs.mkdir(sessions, { recursive: true }); await fs.mkdir(folder);
  const original = await fs.readFile(process.env.ELPIS_TEST_SESSION, 'utf8');
  const rows = original.trim().split('\n').map(line => JSON.parse(line));
  const meta = rows.find(row => row.type === 'session_meta').payload;
  const completed = rows.filter(row => row.payload?.item?.type === 'FileChange' && row.payload.item.status === 'completed');
  assert.ok(completed.length > 1, 'use a real session containing completed fileChange items');
  const expected = [...new Set(completed.flatMap(row => Object.keys(row.payload.item.changes)))].map(name => path.relative(meta.cwd, name)).sort();
  const copy = original.split(meta.cwd).join(folder);
  await fs.writeFile(path.join(sessions, `rollout-2026-10-17T23-33-38-${meta.id}.jsonl`), copy);
  const env = { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), LANG: 'C.UTF-8' };
  const runtimes = [];
  const open = async () => {
    const child = spawn(process.env.ELPIS_TEST_ENGINE, ['app-server', '--listen', 'stdio://'], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const socket = new EventEmitter(); socket.send = raw => child.stdin.write(raw + '\n'); socket.close = () => child.stdin.end();
    const lines = createInterface({ input: child.stdout }); lines.on('line', line => socket.emit('message', line));
    child.on('exit', () => socket.emit('close'));
    const client = new DesktopClient(socket, { timeoutMs: 15000, archiveDirectory: path.join(home, 'archives'), rewindHome: path.join(home, 'rewind') });
    const stop = async () => {
      client.close();
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
      lines.close(); await fs.writeFile(path.join(root, `engine-${child.pid}.log`), stderr);
    };
    runtimes.push({ client, stop }); await client.initialize(); return client;
  };
  let app;
  t.after(async () => {
    await app?.close(); for (const runtime of runtimes) await runtime.stop();
  });
  const client = await open();
  app = await startDesktopServer({ client, staticDir: path.resolve('out'), elpisHome: home, trashFile: path.join(home, 'trash.json'), loveSpot: { directory: path.join(home, 'love-spot') } });
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const route = `/api/threads/${meta.id}/git`;
  const get = query => fetch(origin + route + query, { headers: { Cookie } });
  const result = await get('?view=changes'); assert.equal(result.status, 200);
  const list = await result.json();
  assert.equal(list.recorded, true);
  assert.deepEqual(list.files.map(file => file.path), expected, 'cold history must include every real recorded edit before the UI resumes the chat');
  const repeated = completed.flatMap(row => Object.keys(row.payload.item.changes)).find((name, i, all) => all.indexOf(name) !== i);
  assert.ok(repeated, 'the real session must contain repeated edits');
  const filePath = path.relative(meta.cwd, repeated);
  const first = await (await get(`?view=file&path=${encodeURIComponent(filePath)}`)).json();
  assert.ok(first.diff.length > 0);
  const recorded = completed.flatMap(row => Object.entries(row.payload.item.changes)).filter(([name]) => name === repeated);
  let offset = -1;
  for (const [, change] of recorded) {
    const sample = (change.content ?? change.unified_diff ?? '').trim().split('\n').find(line => line.length > 10);
    if (sample) { const at = first.diff.indexOf(sample, offset + 1); assert.ok(at > offset, 'several real edits appear in order'); offset = at; }
  }
  await fs.mkdir(path.dirname(path.join(folder, filePath)), { recursive: true });
  await fs.writeFile(path.join(folder, filePath), 'A later manual edit.');
  assert.deepEqual(await (await get(`?view=file&path=${encodeURIComponent(filePath)}`)).json(), first, 'manual changes do not replace recorded edits');
  for (const query of ['?view=bad', '?view=file', '?view=file&path=../secret', '?view=file&path=%00', '?view=changes&other=x', '?view=changes&view=file'])
    assert.equal((await get(query)).status, 400, query);
  assert.equal((await get('?view=file&path=unknown.txt')).status, 409);
  assert.equal((await fetch(origin + route + '?view=changes')).status, 401);
  await app.close(); app = null;
  await runtimes[0].stop();
  // A new bridge connection, as after reopening the app, must return the same history.
  const again = await open();
  assert.deepEqual((await again.git(meta.id, 'changes')).files, list.files);
  t.diagnostic(`Copied-session evidence: ${root}; ${completed.length} recorded edits, ${expected.length} files.`);
});
