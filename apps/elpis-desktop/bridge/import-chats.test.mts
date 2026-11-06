import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createImportChats } from './import-chats.mts';

// Masih, 23 Oct: "we should add the import chats options like cloudroom does."
const sessions = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `/c/${index}.jsonl`, cwd: '/p', title: `Chat ${index}` }));
function fixture(count: number, extra = {}) {
  const calls: unknown[][] = [];
  const client = { externalSessions: async () => sessions(count), importExternalSessions: async (chats: unknown[]) => { calls.push(chats); return { imported: chats.length, skipped: [] }; } };
  return { calls, imports: createImportChats({ client, codexHome: '/nonexistent-codex', elpisHome: '/nonexistent-elpis', ...extra }) };
}

test('both apps are always offered, each with how many chats it has (0 when none)', async () => {
  assert.deepEqual(await fixture(3).imports.list(), { days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats: 3 }, { id: 'codex', name: 'Codex', chats: 0 }] });
  assert.deepEqual((await fixture(0).imports.list()).sources.map(source => source.chats), [0, 0]);
});

test('one press imports at most 50 through the engine, and a second press at the same time is refused', async () => {
  const f = fixture(55);
  assert.deepEqual(await f.imports.run({ source: 'claude-code' }), { imported: 50, skipped: [] });
  assert.equal(f.calls[0]!.length, 50);
  await assert.rejects(f.imports.run({ source: 'cursor' }), /Choose Claude Code or Codex/);
  const second = fixture(1); const first = second.imports.run({ source: 'claude-code' });
  await assert.rejects(second.imports.run({ source: 'claude-code' }), /already running/); await first;
});

async function codexFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-import-codex-'));
  const codexHome = path.join(root, 'codex'), elpisHome = path.join(root, 'elpis'), day = path.join(codexHome, 'sessions/2026/10/22');
  await fs.mkdir(day, { recursive: true });
  const rollout = async (name: string, source: unknown, { id = name, bytes = 0, old = false } = {}) => {
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
  const registered: string[] = [];
  const client = { externalSessions: async () => [], registerRollout: async (file: string) => { registered.push(file); if (file.endsWith('vscode.jsonl')) throw new Error('engine refused it'); } };
  const imports = createImportChats({ client, codexHome, elpisHome, largest: 1024 });
  return { root, elpisHome, files, registered, imports, copy: (file: string) => path.join(elpisHome, 'sessions', path.relative(path.join(codexHome, 'sessions'), file)) };
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
    assert.equal(outcome.skipped.length, 1); assert.match(String(outcome.skipped[0]), /vscode\.jsonl: engine refused it/);
    assert.deepEqual(f.registered.sort(), [f.copy(f.files.cli), f.copy(f.files.vscode)].sort());
    assert.deepEqual(await fs.readFile(f.copy(f.files.cli)), original);
    assert.deepEqual(await fs.readFile(f.files.cli), original);
    await assert.rejects(fs.access(f.copy(f.files.vscode)), /ENOENT/);
    for (const name of ['exec', 'guardian', 'old', 'huge', 'broken'] as const) await assert.rejects(fs.access(f.copy(f.files[name])), /ENOENT/, name);
    assert.deepEqual((await f.imports.list()).sources.find(source => source.id === 'codex'), { id: 'codex', name: 'Codex', chats: 1 }, 'only the refused one is offered again');
  } finally { await fs.rm(f.root, { recursive: true }); }
});

// A267, 25 Oct: "Imported 0 chats from Codex. 2 skipped: rollout-…08-55-47-01a1716d-…_01a17185-….jsonl: Elpis rejected the operation
// (-32603)". Codex 0.164 continues a chat in a second file (rollout-…-<id>_<segment>.jsonl, "paginated" history that starts from the first
// file), and the engine registers a continuation only once its first file is there (-32603 "invalid paginated history lineage: missing
// source rollout"). The fake engine below keeps that rule.
const ID = '01a1716d-8d9c-7fd2-ac47-11955fb2d94b', SEGMENT = '01a17185-aafd-74d2-af29-b92c2b43dcd4';
async function continuedChat({ refuse = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-import-continued-'));
  const codexHome = path.join(root, 'codex'), elpisHome = path.join(root, 'elpis'), from = path.join(codexHome, 'sessions');
  const write = async (relative: string, payload: object, modified: Date) => {
    const file = path.join(from, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { id: ID, source: 'vscode', cwd: '/p', history_mode: 'paginated', ...payload } })}\n{"type":"response_item"}\n`);
    await fs.utimes(file, modified, modified);
    return file;
  };
  // The first file is in the day before and was written to last, so neither the folder nor the time decides which file leads.
  const first = await write(`2026/10/24/rollout-2026-10-24T23-50-00-${ID}.jsonl`, {}, new Date(Date.now() - 60_000));
  const second = await write(`2026/10/25/rollout-2026-10-25T08-55-47-${ID}_${SEGMENT}.jsonl`, { history_base: { thread_id: ID, end_ordinal_exclusive: 2, end_byte_offset: 120 } }, new Date(Date.now() - 120_000));
  const registered: string[] = [], into = path.join(elpisHome, 'sessions');
  const client = {
    externalSessions: async () => [],
    registerRollout: async (file: string) => {
      registered.push(file);
      if (refuse) throw new Error('engine refused it');
      const meta = JSON.parse((await fs.readFile(file, 'utf8')).split('\n')[0]!).payload;
      const present = (await fs.readdir(into, { recursive: true })).some(name => path.basename(name) === `rollout-2026-10-24T23-50-00-${ID}.jsonl`);
      if (meta.history_base && !present) throw new Error(`invalid paginated history lineage for ${ID}: missing source rollout`);
    },
  };
  return { root, first, second, registered, imports: createImportChats({ client, codexHome, elpisHome }), copy: (file: string) => path.join(into, path.relative(from, file)) };
}
const codexCount = async (imports: ReturnType<typeof createImportChats>) => (await imports.list()).sources.find(source => source.id === 'codex')!.chats;

test('A267: a Codex chat continued in a second file comes in as one chat: both files copied, only the newest registered', async () => {
  const f = await continuedChat();
  try {
    assert.equal(await codexCount(f.imports), 1, 'one chat, not two');
    const originals = [await fs.readFile(f.first), await fs.readFile(f.second)];
    assert.deepEqual(await f.imports.run({ source: 'codex' }), { imported: 1, skipped: [] });
    assert.deepEqual(f.registered, [f.copy(f.second)]);
    assert.deepEqual([await fs.readFile(f.copy(f.first)), await fs.readFile(f.copy(f.second))], originals);
    assert.deepEqual([await fs.readFile(f.first), await fs.readFile(f.second)], originals);
    assert.equal(await codexCount(f.imports), 0, 'an imported chat is not offered again');
  } finally { await fs.rm(f.root, { recursive: true }); }
});

test('A267: a continued chat the engine refuses leaves none of its files behind and is offered again', async () => {
  const f = await continuedChat({ refuse: true });
  try {
    const outcome = await f.imports.run({ source: 'codex' });
    assert.equal(outcome.imported, 0);
    assert.equal(outcome.skipped.length, 1); assert.match(String(outcome.skipped[0]), new RegExp(`${ID}_${SEGMENT}\\.jsonl: engine refused it`));
    for (const file of [f.first, f.second]) await assert.rejects(fs.access(f.copy(file)), /ENOENT/);
    assert.equal(await codexCount(f.imports), 1);
  } finally { await fs.rm(f.root, { recursive: true }); }
});
