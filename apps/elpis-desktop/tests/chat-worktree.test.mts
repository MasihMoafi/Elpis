// lib/chat-worktree.ts: after archiving or deleting a chat, a notice appears only when its worktree stays on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keptNotice } from '../lib/chat-worktree.ts';

const kept = (changes: number) => ({ path: '/repo-elpis/chats/chat-abc123', branch: 'elpis/chat-abc123', kept: true as const, changes });

test('a kept worktree with changes is named, with the way back; a removed one shows nothing', () => {
  assert.equal(keptNotice('Fix parser', 'archived', kept(2)), '“Fix parser” was archived with 2 uncommitted changes. Its worktree is still on disk at /repo-elpis/chats/chat-abc123 (branch elpis/chat-abc123). Unarchive the chat to keep working in it.');
  assert.equal(keptNotice('Fix parser', 'deleted', kept(1)), '“Fix parser” was deleted. Its worktree has 1 uncommitted change, so it is still on disk at /repo-elpis/chats/chat-abc123 (branch elpis/chat-abc123).');
  assert.equal(keptNotice('Fix parser', 'deleted', kept(0)), '“Fix parser” was deleted. Its worktree could not be removed, so it is still on disk at /repo-elpis/chats/chat-abc123 (branch elpis/chat-abc123).');
  assert.equal(keptNotice('Fix parser', 'archived', { path: '/x', branch: 'b', removed: true }), '');
  assert.equal(keptNotice('Fix parser', 'archived'), '');
});
