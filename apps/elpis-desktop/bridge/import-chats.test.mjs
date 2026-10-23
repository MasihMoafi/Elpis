import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createImportChats } from './import-chats.mjs';

// Masih, 23 Oct: "we should add the import chats options like cloudroom does."
const sessions = count => Array.from({ length: count }, (_, index) => ({ path: `/c/${index}.jsonl`, cwd: '/p', title: `Chat ${index}` }));
function fixture(count, extra = {}) {
  const calls = [];
  const client = { externalSessions: async () => sessions(count), importExternalSessions: async chats => { calls.push(chats); return { imported: chats.length, skipped: [] }; } };
  return { calls, imports: createImportChats({ client, codexHome: '/nonexistent-codex', elpisHome: '/nonexistent-elpis', ...extra }) };
}

test('both apps are always offered, each with how many chats it has (0 when none)', async () => {
  assert.deepEqual(await fixture(3).imports.list(), { days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats: 3 }, { id: 'codex', name: 'Codex', chats: 0 }] });
  assert.deepEqual((await fixture(0).imports.list()).sources.map(source => source.chats), [0, 0]);
});

test('one press imports at most 50 through the engine, and a second press at the same time is refused', async () => {
  const f = fixture(55);
  assert.deepEqual(await f.imports.run({ source: 'claude-code' }), { imported: 50, skipped: [] });
  assert.equal(f.calls[0].length, 50);
  await assert.rejects(f.imports.run({ source: 'cursor' }), /Choose Claude Code or Codex/);
  const second = fixture(1); const first = second.imports.run({ source: 'claude-code' });
  await assert.rejects(second.imports.run({ source: 'claude-code' }), /already running/); await first;
});

async function codexFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-import-codex-'));
  const codexHome = path.join(root, 'codex'), elpisHome = path.join(root, 'elpis'), day = path.join(codexHome, 'sessions/2026/10/22');
  await fs.mkdir(day, { recursive: true });
  const rollout = async (name, source, { id = name, bytes = 0, old = false } = {}) => {
    const file = path.join(day, `rollout-2026-10-22T10-00-00-${name}.jsonl`);
    await fs.writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { id, source, cwd: '/p' } })}\n{"type":"response_item"}\n${'x'.repeat(bytes)}`);
    if (old) { const then = new Date(Date.now() - 40 * 86_400_000); await fs.utimes(file, then, then); }
    return file;
  };
  const files = {
    cli: await rollout('cli', 'cli'), vscode: await rollout('vscode', 'vscode'), exec: await rollout('exec', 'exec'),
    guardian: await rollout('guardian', { subagent: { other: 'guardian' } }), old: await rollout('old', 'cli', { old: true }),
    huge: await rollout('huge', 'cli', { bytes: 2048 }), broken: path.join(day, 'rollout-2026-10-22T10-00-00-broken.jsonl'),
  };
  await fs.writeFile(files.broken, 'not json\n');
  const registered = [];
  const client = { externalSessions: async () => [], registerRollout: async file => { registered.push(file); if (file.endsWith('vscode.jsonl')) throw new Error('engine refused it'); } };
  const imports = createImportChats({ client, codexHome, elpisHome, largest: 1024 });
  return { root, elpisHome, files, registered, imports, copy: file => path.join(elpisHome, 'sessions', path.relative(path.join(codexHome, 'sessions'), file)) };
}

test('Codex offers only recent chat rollouts of a reasonable size: no exec runs, sub-agents, unreadable or oversized files', async () => {
  const f = await codexFixture();
  try { assert.deepEqual((await f.imports.list()).sources.find(source => source.id === 'codex'), { id: 'codex', name: 'Codex', chats: 2 }); }
  finally { await fs.rm(f.root, { recursive: true }); }
});

test('a Codex chat is copied under its own name and registered; the original is untouched, a refused copy is removed, and none comes in twice', async () => {
  const f = await codexFixture();
  try {
    const original = await fs.readFile(f.files.cli);
    const outcome = await f.imports.run({ source: 'codex' });
    assert.equal(outcome.imported, 1);
    assert.equal(outcome.skipped.length, 1); assert.match(outcome.skipped[0], /vscode\.jsonl: engine refused it/);
    assert.deepEqual(f.registered.sort(), [f.copy(f.files.cli), f.copy(f.files.vscode)].sort());
    assert.deepEqual(await fs.readFile(f.copy(f.files.cli)), original);
    assert.deepEqual(await fs.readFile(f.files.cli), original);
    await assert.rejects(fs.access(f.copy(f.files.vscode)), /ENOENT/);
    for (const name of ['exec', 'guardian', 'old', 'huge', 'broken']) await assert.rejects(fs.access(f.copy(f.files[name])), /ENOENT/, name);
    assert.deepEqual((await f.imports.list()).sources.find(source => source.id === 'codex'), { id: 'codex', name: 'Codex', chats: 1 }, 'only the refused one is offered again');
  } finally { await fs.rm(f.root, { recursive: true }); }
});
