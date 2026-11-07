import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSessions, sessionSettings } from './matilda-sessions.mts';

test('discovers sessions from all runtimes without claiming unknown processes are closed', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'matilda-sessions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const elpisHome = path.join(home, '.elpis-next'), claudeHome = path.join(home, '.claude');
  const dirs = [path.join(elpisHome, 'sessions/2026/11/07'), path.join(home, '.codex/sessions/2026/11/07'), path.join(claudeHome, 'projects/project'), path.join(claudeHome, 'sessions')];
  await Promise.all(dirs.map(dir => fs.mkdir(dir, { recursive: true })));
  const uuid = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const files = [path.join(dirs[0]!, `rollout-2026-${uuid[0]}.jsonl`), path.join(dirs[1]!, `rollout-2026-${uuid[1]}.jsonl`), path.join(dirs[2]!, `${uuid[2]}.jsonl`)];
  for (const [i, file] of files.entries()) {
    const lines = i < 2 ? [{ type: 'session_meta', payload: { id: uuid[i], cwd: '/project', originator: i ? 'codex_cli_rs' : 'elpis-desktop', source: 'cli' } }, { type: 'event_msg', payload: { type: 'user_message', message: 'First prompt' } }] : [{ type: 'user', cwd: '/project', entrypoint: 'cli', message: { content: 'First prompt' } }];
    await fs.writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  }
  await fs.writeFile(path.join(elpisHome, 'session_index.jsonl'), JSON.stringify({ id: uuid[0], thread_name: 'Named' }) + '\n');
  await fs.writeFile(path.join(claudeHome, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: uuid[2], pid: process.pid }));
  const handles = await Promise.all(files.slice(0, 2).map(file => fs.open(file, 'r')));
  t.after(() => Promise.all(handles.map(handle => handle.close())));
  const options = { home, elpisHome, claudeHome, settings: { runtimes: ['elpis', 'codex', 'claude'] as const, idleMs: 60_000 } };
  const list = () => listSessions({ ...options, settings: { ...options.settings, runtimes: [...options.settings.runtimes] } });
  const rows = await list();
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.state, 'live'); assert.equal(row.cwd, '/project'); assert.equal(row.subject, 'First prompt'); }
  assert.equal(rows.find(row => row.runtime === 'elpis')?.name, 'Named');
  for (const file of files) await fs.utimes(file, new Date(0), new Date(0));
  assert.ok((await list()).every(row => row.state === 'idle'));
  await Promise.all(handles.map(handle => handle.close()));
  await fs.writeFile(path.join(claudeHome, 'sessions', `${process.pid}.json`), '{broken');
  const unknown = await list();
  assert.equal(unknown.find(row => row.runtime === 'claude')?.state, 'unreachable');
  for (const row of unknown.filter(row => row.runtime !== 'claude')) assert.ok(['closed', 'unreachable'].includes(row.state));
  assert.deepEqual(await sessionSettings(elpisHome), { runtimes: ['elpis', 'codex', 'claude', 'gemini'], idleMs: 600_000 });
  await fs.mkdir(path.join(elpisHome, 'matilda'), { recursive: true });
  await fs.writeFile(path.join(elpisHome, 'matilda/settings.json'), JSON.stringify({ runtimes: ['claude'], idleMs: 42 }));
  assert.deepEqual(await sessionSettings(elpisHome), { runtimes: ['claude'], idleMs: 42 });
});

test('closed, unreadable and uncertain sessions retain distinct evidence for each runtime', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'matilda-status-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const elpisHome = path.join(home, '.elpis-next'), claudeHome = path.join(home, '.claude');
  const dirs = [path.join(elpisHome, 'sessions/2026/11/07'), path.join(home, '.codex/sessions/2026/11/07'), path.join(claudeHome, 'projects/project')];
  await Promise.all(dirs.map(dir => fs.mkdir(dir, { recursive: true })));
  for (const [index, dir] of dirs.entries()) {
    const id = `closed-${index}`;
    const contents = index === 2 ? { type: 'user', cwd: '/project', entrypoint: 'cli', message: { content: 'hello' } } : { type: 'session_meta', payload: { id, cwd: '/project', originator: 'cli' } };
    await fs.writeFile(path.join(dir, index === 2 ? `${id}.jsonl` : `rollout-${id}.jsonl`), JSON.stringify(contents) + '\n');
    const hidden = path.join(dir, index === 2 ? 'unreadable.jsonl' : 'rollout-unreadable.jsonl');
    await fs.writeFile(hidden, '{}\n'); await fs.chmod(hidden, 0);
  }
  const originalReaddir = fs.readdir.bind(fs);
  let processEvidenceComplete = true;
  t.mock.method(fs, 'readdir', (async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === '/proc') return processEvidenceComplete ? [] : ['12345'];
    if (args[0] === '/proc/12345/fd') throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return originalReaddir(...args);
  }) as typeof fs.readdir);
  for (processEvidenceComplete of [true, false]) {
    const rows = await listSessions({ home, elpisHome, claudeHome, settings: { runtimes: ['elpis', 'codex', 'claude'], idleMs: 1 } });
    for (const runtime of ['elpis', 'codex', 'claude']) {
      const unreadable = rows.find(row => row.runtime === runtime && row.evidence === 'Transcript cannot be read.');
      assert.equal(unreadable?.state, 'unreachable');
      const readable = rows.find(row => row.runtime === runtime && row.id.startsWith('closed-'));
      assert.ok(readable);
      const uncertain = runtime !== 'claude' && !processEvidenceComplete;
      assert.equal(readable.state, uncertain ? 'unreachable' : 'closed');
      assert.equal(readable.evidence, uncertain ? 'Process evidence is incomplete.' : 'No live process evidence found.');
    }
  }
});
