import test from 'node:test';
import assert from 'node:assert/strict';
import { insertMention, mentionAt, rankMentions, usedMentions } from '../lib/mentions.ts';

const file = name => ({ kind: 'file', name, detail: 'File', path: `/work/${name}` });
const chat = (name, id = name) => ({ kind: 'chat', name, detail: 'Chat', path: `thread://${id}` });

test('an @ starts a mention at the start of the text or after whitespace, and ends at the caret', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('look at @src/ap', 15), { start: 8, query: 'src/ap' });
  assert.deepEqual(mentionAt('two\n@x', 6), { start: 4, query: 'x' });
  assert.deepEqual(mentionAt('@abc def', 4), { start: 0, query: 'abc' }, 'the caret decides, not the end of the text');
  assert.equal(mentionAt('mail me at a@b.c', 16), null, 'an @ inside a word is not a mention');
  assert.equal(mentionAt('@abc def', 8), null, 'a space after the query ends the mention');
  assert.equal(mentionAt('no at sign', 10), null);
});

test('files rank by how the name matches (the path starts, the file name starts, the file name contains, the path contains), the shorter path first', () => {
  const items = [file('docs/app-guide.md'), file('src/lib/app.ts'), file('src/application.ts'), file('app.config.js'), file('src/other.ts')];
  assert.deepEqual(rankMentions(items, 'app').map(item => item.name), ['app.config.js', 'src/lib/app.ts', 'docs/app-guide.md', 'src/application.ts']);
  assert.deepEqual(rankMentions(items, 'LIB/').map(item => item.name), ['src/lib/app.ts'], 'case is ignored');
  assert.deepEqual(rankMentions(items, 'zzz'), []);
});

test('with nothing typed the first files come in the order given, then at most three chats, eight in all', () => {
  const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.ts`)), chats = Array.from({ length: 5 }, (_, i) => chat(`Chat ${i}`));
  const shown = rankMentions([...files, ...chats], '');
  assert.equal(shown.length, 8);
  assert.deepEqual(shown.map(item => item.name), ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'Chat 0', 'Chat 1', 'Chat 2']);
  assert.deepEqual(rankMentions(chats, '').map(item => item.name), ['Chat 0', 'Chat 1', 'Chat 2', 'Chat 3', 'Chat 4'].slice(0, 5), 'with no files the chats fill the list');
});

test('a chat matches on its title', () => {
  const items = [file('docs/write.md'), chat('Write the docs'), chat('Fix the parser')];
  assert.deepEqual(rankMentions(items, 'write').map(item => item.name), ['Write the docs', 'docs/write.md']);
  assert.deepEqual(rankMentions(items, 'PARSER').map(item => item.name), ['Fix the parser']);
});

test('inserting replaces @query with @name and a space, and puts the caret after it', () => {
  assert.deepEqual(insertMention('look at @ap now', 8, 11, 'src/app.ts'), { text: 'look at @src/app.ts  now', caret: 20 });
  assert.deepEqual(insertMention('@', 0, 1, 'Write the docs'), { text: '@Write the docs ', caret: 16 });
});

test('only mentions whose @name is still in the text are sent', () => {
  const known = [{ name: 'src/app.ts', path: '/work/src/app.ts' }, { name: 'Write the docs', path: 'thread://b' }, { name: 'gone.ts', path: '/work/gone.ts' }];
  assert.deepEqual(usedMentions('see @src/app.ts and @Write the docs please', known).map(item => item.name), ['src/app.ts', 'Write the docs']);
  assert.deepEqual(usedMentions('nothing here', known), []);
  assert.deepEqual(usedMentions('@src/app.ts @src/app.ts', [known[0], known[0]]).length, 1, 'a file is mentioned once');
});
