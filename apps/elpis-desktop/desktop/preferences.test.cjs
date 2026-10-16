const test = require('node:test');
const assert = require('node:assert/strict');
const { closeNeedsConfirmation } = require('./preferences.cjs');

test('closing asks only when the saved preference says so', () => {
  const store = value => ({ read: () => value });
  assert.equal(closeNeedsConfirmation(store({ 'elpis-preferences-v1': JSON.stringify({ confirmClose: true }) })), true);
  for (const value of [{}, { error: 'unreadable' }, { 'elpis-preferences-v1': '{"confirmClose":false}' }, { 'elpis-preferences-v1': 'not json' }, { 'elpis-preferences-v1': '{"confirmClose":"yes"}' }]) assert.equal(closeNeedsConfirmation(store(value)), false);
});
