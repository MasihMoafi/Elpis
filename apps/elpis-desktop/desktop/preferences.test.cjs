const test = require('node:test');
const assert = require('node:assert/strict');
const { closeNeedsConfirmation } = require('./preferences.cjs');

test('closing asks only when the saved preference says so', () => {
  const store = value => ({ read: () => value });
  assert.equal(closeNeedsConfirmation(store({ 'elpis-preferences-v1': JSON.stringify({ confirmClose: true }) })), true);
  for (const value of [{}, { error: 'unreadable' }, { 'elpis-preferences-v1': '{"confirmClose":false}' }, { 'elpis-preferences-v1': 'not json' }, { 'elpis-preferences-v1': '{"confirmClose":"yes"}' }]) assert.equal(closeNeedsConfirmation(store(value)), false);
});

test('the Session Manager is off unless saved on', () => {
  const { sessionManagerOn } = require('./preferences.cjs');
  const store = value => ({ read: () => value });
  assert.equal(sessionManagerOn(store({ 'elpis-preferences-v1': JSON.stringify({ sessionManager: true }) })), true);
  for (const value of [{}, { error: 'unreadable' }, { 'elpis-preferences-v1': '{"sessionManager":false}' }, { 'elpis-preferences-v1': '{"sessionManager":"yes"}' }, { 'elpis-preferences-v1': 'not json' }])
    assert.equal(sessionManagerOn(store(value)), false);
});

test('Close to tray is off unless saved on; the Quick Entry shortcut is Ctrl+Alt+Space unless saved, and empty turns it off', () => {
  const { closesToTray, quickEntryShortcut } = require('./preferences.cjs');
  const store = value => ({ read: () => value });
  const saved = value => store({ 'elpis-preferences-v1': JSON.stringify(value) });
  assert.equal(closesToTray(saved({ closeToTray: true })), true);
  for (const value of [store({}), store({ error: 'unreadable' }), saved({ closeToTray: 'yes' }), store({ 'elpis-preferences-v1': 'not json' })]) {
    assert.equal(closesToTray(value), false);
    assert.equal(quickEntryShortcut(value), 'Ctrl+Alt+Space');
  }
  assert.equal(quickEntryShortcut(saved({ quickEntryShortcut: 'Super+E' })), 'Super+E');
  assert.equal(quickEntryShortcut(saved({ quickEntryShortcut: '' })), '');
  assert.equal(quickEntryShortcut(saved({ quickEntryShortcut: 7 })), 'Ctrl+Alt+Space');
});
