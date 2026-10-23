import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImportChats } from './import-chats.mjs';

// Masih, 23 Oct: "we should add the import chats options like cloudroom does."
const sessions = count => Array.from({ length: count }, (_, index) => ({ path: `/c/${index}.jsonl`, cwd: '/p', title: `Chat ${index}` }));
function fixture(count) {
  const calls = [];
  const client = { externalSessions: async () => sessions(count), importExternalSessions: async chats => { calls.push(chats); return { imported: chats.length, skipped: [] }; } };
  return { calls, imports: createImportChats({ client }) };
}

test('Claude Code is offered with how many chats it has, and nothing is offered when it has none', async () => {
  assert.deepEqual(await fixture(3).imports.list(), { days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats: 3 }] });
  assert.deepEqual((await fixture(0).imports.list()).sources, []);
});

test('one press imports at most 50 through the engine, and a second press at the same time is refused', async () => {
  const f = fixture(55);
  assert.deepEqual(await f.imports.run({ source: 'claude-code' }), { imported: 50, skipped: [] });
  assert.equal(f.calls[0].length, 50);
  await assert.rejects(f.imports.run({ source: 'codex' }), /Only Claude Code chats/);
  const second = fixture(1); const first = second.imports.run({ source: 'claude-code' });
  await assert.rejects(second.imports.run({ source: 'claude-code' }), /already running/); await first;
});
