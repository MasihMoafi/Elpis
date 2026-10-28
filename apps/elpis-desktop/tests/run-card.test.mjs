// 28 Oct: the run's progress showed "Latest observed report · Mother: {"action":"continue","summary":…}". The Mother's and a
// check's JSON read as words wherever they show (lib/run-card.ts); any other reply is left as written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCard } from '../lib/run-card.ts';

test('a Mother decision and a check verdict read as words; other replies stay as written', () => {
  const mother = runCard('{"action":"continue","summary":"Quillon has listed the folder.","reason":"A sensible first step."}');
  assert.deepEqual([mother.heading, mother.summary, mother.mother], ['Mother lets the agent continue', 'Quillon has listed the folder.', true]);
  assert.match(mother.text, /\*\*Why:\*\* A sensible first step\./);
  const check = runCard('```json\n{"passed":false,"summary":"page 2 is missing"}\n```');
  assert.deepEqual([check.heading, check.summary, check.failed], ['Check failed', 'page 2 is missing', true]);
  for (const other of ['Done: wrote pages.md', '{"action":"dance","summary":"x"}', '{"passed":true,"summary":"ok","extra":1}', '{not json'])
    assert.equal(runCard(other), null, other);
});
