import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../lib/message-copy.ts';

test('markdown becomes the text a reader sees', () => {
  assert.equal(plainText('The parser has **two passes**.\n\n- lexing\n- parsing\n\nSee [the guide](https://example.invalid/guide).'),
    'The parser has two passes.\n\n- lexing\n- parsing\n\nSee the guide.');
  assert.equal(plainText('# Title\n\n## Sub *section*\n\n> quoted _text_'), 'Title\n\nSub section\n\nquoted text');
  assert.equal(plainText('Run `npm test` now, ~~not~~ later. ![diagram](x.png)'), 'Run npm test now, not later. diagram');
  assert.equal(plainText('1. one\n2. two'), '1. one\n2. two');
});

test('code blocks keep their code, without the fences', () => {
  assert.equal(plainText('Before\n\n```ts\nconst a = **1**;\n```\n\nAfter'), 'Before\n\nconst a = **1**;\n\nAfter');
  assert.equal(plainText('~~~\nplain\n~~~'), 'plain');
});

test('text without markdown comes back as it was, trimmed at the ends', () => {
  assert.equal(plainText('  just words, 2 * 3 = 6  \n'), 'just words, 2 * 3 = 6');
  assert.equal(plainText(''), '');
});
