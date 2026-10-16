import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INIT_PROMPT } from '../lib/init-prompt.ts';
import { conversationMarkdown, exportFileName, lastReply, splitCommand } from '../lib/slash.ts';

test('/init sends the terminal\'s own prompt, byte for byte', () => {
  const terminal = fs.readFileSync(new URL('../../../codex-rs/tui/assets/prompt_for_init_command.md', import.meta.url), 'utf8');
  assert.equal(INIT_PROMPT, terminal);
});

const user = (id, text) => ({ turnId: 't', item: { id, type: 'userMessage', content: [{ type: 'text', text }, { type: 'image', url: 'data:' }] } });
const agent = (id, text) => ({ turnId: 't', item: { id, type: 'agentMessage', text } });
const entries = [user('1', 'Fix the cache.'), { turnId: 't', item: { id: 'x', type: 'commandExecution', command: 'ls' } }, agent('2', 'The cache is fixed.'), user('3', 'Thanks'), agent('4', '')];

test('lastReply is the newest non-empty Elpis message, or null', () => {
  assert.equal(lastReply(entries), 'The cache is fixed.');
  assert.equal(lastReply([user('1', 'hi')]), null);
  assert.equal(lastReply([]), null);
});

test('conversationMarkdown keeps the messages, in order, under who said them', () => {
  assert.equal(conversationMarkdown('Cache chat', entries), '# Cache chat\n\n## You\n\nFix the cache.\n\n## Elpis\n\nThe cache is fixed.\n\n## You\n\nThanks\n');
  assert.equal(conversationMarkdown('Empty', []), '# Empty\n');
});

test('exportFileName is a safe .md name from the chat title', () => {
  assert.equal(exportFileName('Cache chat'), 'cache-chat.md');
  assert.equal(exportFileName('  ../../etc/passwd: "x"  '), 'etc-passwd-x.md');
  assert.equal(exportFileName('日本語'), '日本語.md');
  assert.equal(exportFileName('?!?'), 'conversation.md');
  assert.equal(exportFileName('x'.repeat(200)).length, 'x'.repeat(60).length + 3);
});

test('splitCommand reads "/name arguments", and nothing else', () => {
  assert.deepEqual(splitCommand('/effort high'), { name: 'effort', args: 'high' });
  assert.deepEqual(splitCommand('/Review   check the cache  \n'), { name: 'review', args: 'check the cache' });
  assert.deepEqual(splitCommand('/compact keep\nnames'), { name: 'compact', args: 'keep\nnames' });
  assert.equal(splitCommand('/effort'), null);
  assert.equal(splitCommand('/effort   '), null);
  assert.equal(splitCommand('use /effort high'), null);
  assert.equal(splitCommand('/ high'), null);
});
