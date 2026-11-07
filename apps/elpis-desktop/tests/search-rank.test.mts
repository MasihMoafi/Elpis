// lib/search-rank.ts: chat search ranks the exact name first, then names that start with it (shorter first), then a word
// start, then anywhere in the name, then the chat's other text; equal matches keep the list's order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankBySearch, searchScore } from '../lib/search-rank.ts';

test('search ranks exact, prefix, word start, anywhere, then other text; no match and an empty query score 0', () => {
  const chats: [string, string][] = [['Other', 'mentions parser in the first message'], ['Reparser it', ''], ['Fix the parser', ''], ['Parser tests', ''], ['Parser', ''], ['Unrelated', '']];
  assert.deepEqual(rankBySearch(chats, 'parser', c => c[0], c => c[1]).map(c => c[0]), ['Parser', 'Parser tests', 'Fix the parser', 'Reparser it', 'Other', 'Unrelated']);
  assert.equal(searchScore('Parser', '', '  '), 0);
  assert.equal(searchScore('Unrelated', 'nothing', 'parser'), 0);
});

test('equal matches keep their given order', () => {
  const chats = ['b parser', 'a parser'];
  assert.deepEqual(rankBySearch(chats, 'parser', c => c, () => ''), ['b parser', 'a parser']);
});
