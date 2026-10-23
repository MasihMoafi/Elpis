import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentenceBuffer } from './speech-buffer.mjs';

test('sentences stream before completion, preserve Unicode and flush the unfinished tail once', () => {
  const spoken = [], buffer = createSentenceBuffer(chunk => spoken.push(chunk));
  for (const delta of ['Hello', ' there. ', 'سلام', '؟ ', 'A final', ' thought']) buffer.push(delta);
  assert.deepEqual(spoken, ['Hello there. ', 'سلام؟ ']);
  buffer.finish(); buffer.finish();
  assert.equal(spoken.join(''), 'Hello there. سلام؟ A final thought');
});

test('split and half-open fences, JSON and their punctuation never enter speech', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spoken = [], buffer = createSentenceBuffer(chunk => spoken.push(chunk));
  for (const delta of ['A flower. ', '`', '`', '`exca', 'lidraw\n[{"text":"SECRET!"}]', '\n`', '``', '\nStill here. ', '{"hidden":"NO!"}', ' Tail', ' `', '`']) {
    buffer.push(delta); t.mock.timers.tick(300);
    assert.doesNotMatch(spoken.join(''), /SECRET|NO|exca|`|[{}\[\]]/);
  }
  buffer.finish();
  assert.match(spoken.join(''), /A flower\.\s+Still here\.\s+Tail/);
  const hidden = createSentenceBuffer(chunk => spoken.push(chunk));
  hidden.push('```json\n{"never":"FINISH!"}'); hidden.finish();
  assert.doesNotMatch(spoken.join(''), /FINISH/);
  const array = createSentenceBuffer(chunk => spoken.push(chunk));
  for (const delta of ['[', 't', 'rue, "ARRAY!", {"nested":"NO!"}', ']']) array.push(delta);
  array.finish(); assert.doesNotMatch(spoken.join(''), /ARRAY|nested|true/);
});

test('300 ms flushes only a safe word prefix; long chunks stay below the transport cap; cancel drops the tail', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spoken = [], buffer = createSentenceBuffer(chunk => spoken.push(chunk));
  buffer.push('A sentence without punctua');
  t.mock.timers.tick(299); assert.equal(spoken.length, 0);
  t.mock.timers.tick(1); assert.equal(spoken.join(''), 'A sentence without ');
  buffer.push('tion ' + 'سلام 🌍 '.repeat(1000));
  t.mock.timers.tick(300); buffer.finish();
  assert.equal(spoken.join(''), 'A sentence without punctuation ' + 'سلام 🌍 '.repeat(1000));
  assert.ok(spoken.every(chunk => Buffer.byteLength(chunk) <= 3596));
  const cancelled = createSentenceBuffer(chunk => spoken.push(chunk));
  cancelled.push('MUST NOT SPEAK'); cancelled.cancel(); cancelled.finish(); t.mock.timers.tick(1000);
  assert.doesNotMatch(spoken.join(''), /MUST/);
});
