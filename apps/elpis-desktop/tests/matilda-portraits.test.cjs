const test = require('node:test');
const assert = require('node:assert/strict');
const { PORTRAITS, readPortraits, portraitSources } = require('../lib/matilda-portraits.cjs');

test('each place keeps its own built-in portrait, with safe defaults for invalid settings', () => {
  const selections = { pinned: 'wink', mini: 'kissSoft', board: 'smile', replies: 'kissPuckered' };
  assert.deepEqual(readPortraits(JSON.stringify(selections)), selections);
  assert.deepEqual(readPortraits('{'), { pinned: 'auto', mini: 'auto', board: 'auto', replies: 'auto' });
  assert.deepEqual(readPortraits(JSON.stringify({ ...selections, board: '../../other.png' })), { ...selections, board: 'auto' });
  for (const { value } of PORTRAITS.filter(choice => choice.value !== 'auto')) {
    const sources = portraitSources(value);
    assert.ok(sources.light && sources.dark, `${value} has a built-in image in both themes`);
  }
});
