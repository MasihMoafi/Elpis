const test = require('node:test');
const assert = require('node:assert/strict');
const { closeNeedsConfirmation } = require('./preferences.cjs');

test('closing asks only when the saved preference says so', () => {
  const store = value => ({ read: () => value });
  assert.equal(closeNeedsConfirmation(store({ 'elpis-preferences-v1': JSON.stringify({ confirmClose: true }) })), true);
  for (const value of [{}, { error: 'unreadable' }, { 'elpis-preferences-v1': '{"confirmClose":false}' }, { 'elpis-preferences-v1': 'not json' }, { 'elpis-preferences-v1': '{"confirmClose":"yes"}' }]) assert.equal(closeNeedsConfirmation(store(value)), false);
});

test('the Session Manager is on unless saved off', () => {
  const { sessionManagerOn } = require('./preferences.cjs');
  const store = value => ({ read: () => value });
  for (const value of [{}, { error: 'unreadable' }, { 'elpis-preferences-v1': '{"sessionManager":true}' }, { 'elpis-preferences-v1': 'not json' }]) assert.equal(sessionManagerOn(store(value)), true);
  assert.equal(sessionManagerOn(store({ 'elpis-preferences-v1': '{"sessionManager":false}' })), false);
});

test('the shell seeds what ships hidden once and never over a saved choice', async () => {
  const { seedShippedDefaults, SHIPPED_DEFAULTS } = require('./preferences.cjs');
  assert.deepEqual(SHIPPED_DEFAULTS, { hiddenPages: 'experimentLab', sessionManager: false, profileAsked: false });
  const patches = [], store = value => ({ read: () => value, snapshot: () => ({ revision: 3 }), patch: async (input, writer) => { patches.push([input, writer]); } });
  await seedShippedDefaults(store({}));
  assert.deepEqual(patches, [[{ key: 'elpis-preferences-v1', changes: SHIPPED_DEFAULTS, baseRevision: 3 }, null]]);
  patches.length = 0;
  await seedShippedDefaults(store({ 'elpis-preferences-v1': JSON.stringify({ hiddenPages: '', sessionManager: true, profileAsked: true }) }));
  assert.deepEqual(patches, [], 'a saved choice is never replaced');
  await seedShippedDefaults(store({ 'elpis-preferences-v1': JSON.stringify({ hiddenPages: 'canvas' }) }));
  assert.deepEqual(patches[0][0].changes, { sessionManager: false, profileAsked: false }, 'only what is missing is seeded');
  patches.length = 0;
  await seedShippedDefaults(store({ 'elpis-preferences-v1': JSON.stringify({ hiddenPages: 'experimentLab,canvas', sessionManager: false, profileAsked: false }) }));
  assert.deepEqual(patches[0][0].changes, { hiddenPages: 'experimentLab' }, 'the list the first version shipped, never changed, gets Workflows back');
});

test('the real store accepts the seed, keeps other preferences and seeds only once', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createStateStore } = require('./state.cjs');
  const { seedShippedDefaults, sessionManagerOn, PREFERENCES_KEY } = require('./preferences.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-seed-'));
  const store = createStateStore(path.join(dir, 'workspace.json'));
  await store.set(PREFERENCES_KEY, JSON.stringify({ navOrder: 'customize' }));
  await seedShippedDefaults(store);
  const saved = JSON.parse(store.read()[PREFERENCES_KEY]);
  assert.deepEqual(saved, { navOrder: 'customize', hiddenPages: 'experimentLab', sessionManager: false, profileAsked: false });
  assert.equal(sessionManagerOn(store), false);
  const revision = store.snapshot().revision;
  await seedShippedDefaults(store);
  assert.equal(store.snapshot().revision, revision, 'a second start changes nothing');
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
