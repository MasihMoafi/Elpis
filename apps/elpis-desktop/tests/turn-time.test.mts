// lib/turn-time.ts: a centred time line goes above a turn that starts an hour or more after the turn before, or on
// another day, and reads like ChatGPT's ("Yesterday 8:41 PM").
import test from 'node:test';
import assert from 'node:assert/strict';
import { pauseBefore, turnTime } from '../lib/turn-time.ts';

const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime();

test('a long pause or a new day gets a time line; close turns and missing times get none', () => {
  assert.equal(pauseBefore(at(5, 21, 0), at(5, 19, 59)), true, 'an hour or more');
  assert.equal(pauseBefore(at(6, 0, 5), at(5, 23, 59)), true, 'just past midnight');
  assert.equal(pauseBefore(at(5, 20, 43), at(5, 20, 41)), false, 'two minutes on');
  assert.equal(pauseBefore(at(5, 21, 0), undefined), false, 'the first turn');
  assert.equal(pauseBefore(undefined, at(5, 20, 0)), false);
});

test('the line names today, yesterday, a weekday this week, else the date', () => {
  const now = new Date(2026, 10, 6, 9, 0);
  assert.match(turnTime(at(6, 0, 5), now), /^Today 12:05\s?AM$/i);
  assert.match(turnTime(at(5, 20, 41), now), /^Yesterday 8:41\s?PM$/i);
  assert.match(turnTime(at(3, 10, 0), now), /^Tuesday 10:00\s?AM$/i);
  assert.match(turnTime(at(20, 10, 0) - 30 * 86_400_000, now), /^Oct 21, 10:00\s?AM$/i);
});
