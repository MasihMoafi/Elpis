import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createImportChats } from './import-chats.mjs';

// Masih, 23 Oct: "we should add the import chats options like cloudroom does."
async function fixture(t, { claude = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-import-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rollout = async (day, name, ageDays) => {
    const directory = path.join(root, 'codex', 'sessions', '2026', '10', day); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-${name}.jsonl`); await fs.writeFile(file, '{}\n');
    const when = new Date(Date.now() - ageDays * 86_400_000); await fs.utimes(file, when, when); return file;
  };
  const calls = { claude: [], rollouts: [] };
  const client = {
    externalSessions: async () => claude,
    importExternalSessions: async sessions => { calls.claude.push(sessions); return { imported: sessions.length, skipped: [] }; },
    importRollout: async file => { calls.rollouts.push(file); if (file.includes('broken')) throw new Error('The chat could not be read.'); return { id: `thread-${calls.rollouts.length}` }; },
  };
  const imports = createImportChats({ client, codexHome: path.join(root, 'codex'), ledgerFile: path.join(root, 'ledger.json') });
  return { root, rollout, calls, imports };
}

test('only the apps that have chats are offered, with how many', async t => {
  const f = await fixture(t, { claude: [{ path: '/c/1.jsonl', cwd: '/p', title: 'One' }, { path: '/c/2.jsonl', cwd: '/p', title: 'Two' }] });
  await f.rollout('01', 'recent', 2); await f.rollout('02', 'old', 45);
  assert.deepEqual(await f.imports.list(), { days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats: 2 }, { id: 'codex', name: 'Codex', chats: 1 }] }, 'a Codex chat older than 30 days is not offered');
  assert.deepEqual((await (await fixture(t)).imports.list()).sources, [], 'with nothing to import the list is empty');
});

test('Claude Code chats go through the engine; Codex chats are forked once each and then skipped', async t => {
  const sessions = [{ path: '/c/1.jsonl', cwd: '/p', title: 'One' }];
  const f = await fixture(t, { claude: sessions });
  assert.deepEqual(await f.imports.run({ source: 'claude-code' }), { imported: 1, skipped: [] });
  assert.deepEqual(f.calls.claude, [sessions]);
  const good = await f.rollout('01', 'good', 1); await f.rollout('02', 'broken', 1);
  const result = await f.imports.run({ source: 'codex' });
  assert.equal(result.imported, 1); assert.deepEqual(result.skipped, ['The chat could not be read.']);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'ledger.json'), 'utf8'))[good], 'thread-1', 'the new chat is remembered against its source');
  f.calls.rollouts.length = 0;
  await f.imports.run({ source: 'codex' });
  assert.deepEqual(f.calls.rollouts.map(file => path.basename(file)), ['rollout-broken.jsonl'], 'what was imported is never imported twice; what failed is tried again');
});

test('one press imports at most 50, and a second press at the same time is refused', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 55; index++) await f.rollout('03', `chat-${index}`, 1);
  assert.equal((await f.imports.run({ source: 'codex' })).imported, 50);
  assert.equal((await f.imports.list()).sources[0].chats, 5, 'five are left for the next press');
  await assert.rejects(f.imports.run({ source: 'nope' }), /Choose Claude Code or Codex/);
  const slow = await fixture(t); await slow.rollout('04', 'one', 1);
  let release; slow.imports.run({ source: 'codex' });
  const second = slow.imports.run({ source: 'codex' });
  await assert.rejects(second, /already running/);
});
