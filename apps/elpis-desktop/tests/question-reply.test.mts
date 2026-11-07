// lib/question-reply.ts: only the engine's complete answer envelope becomes question cards; prose, quoted tags, code and
// malformed envelopes stay ordinary text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { questionReplies, questionReplyText } from '../lib/question-reply.ts';

const envelope = (body: string) => `<send_user_message_question_reply>${body}</send_user_message_question_reply>`;

test('a complete envelope, single or many, becomes replies; copying gives question and answer', () => {
  const reply = { questionItemId: 'q1', question: 'Which file?', answer: 'parser.ts' };
  assert.deepEqual(questionReplies(envelope(JSON.stringify(reply))), [reply]);
  assert.deepEqual(questionReplies(`  ${envelope(JSON.stringify([reply, { ...reply, questionItemId: 'q2' }]))}\n`)?.length, 2);
  assert.equal(questionReplyText([reply]), 'Which file?\nparser.ts');
});

test('prose, quoted tags, code blocks and malformed envelopes are not replies', () => {
  for (const text of ['Just a message.', `I saw ${envelope('{}')} in the log`, '```\n' + envelope('{"questionItemId":"q","question":"a","answer":"b"}') + '\n```',
    envelope('not json'), envelope('[]'), envelope('{"questionItemId":"q","question":"a"}'), envelope('{"questionItemId":1,"question":"a","answer":"b"}')]) assert.equal(questionReplies(text), null, text);
});
