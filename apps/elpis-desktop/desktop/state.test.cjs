'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore, registerState } = require('./state.cjs');
const { createWindowIpc } = require('./window-ipc.cjs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

test('a saved workspace holding a setting this version no longer knows still opens and keeps it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-old-key-')), 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ 'elpis-theme': 'dark', 'elpis-love-bars': '{"tools":{"x":1,"y":2}}' }));
  const store = createStateStore(file);
  assert.equal(store.snapshot().error, undefined, 'it opens');
  await store.set('elpis-theme', 'light');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['elpis-love-bars'], '{"tools":{"x":1,"y":2}}', 'and the old setting stays in the file');
  fs.writeFileSync(file, JSON.stringify({ 'elpis-theme': 3 }));
  assert.match(createStateStore(file).snapshot().error, /Could not read saved Elpis workspace/, 'a value that is not text is still corruption');
});

test('prompt bookmarks survive reopening the desktop store', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-prompt-bookmarks-')), 'workspace.json');
  const key = 'elpis:prompt-rail-bookmarks:chat-1';
  await createStateStore(file).set(key, '["turn-1","turn-2"]');
  assert.equal(createStateStore(file).read()[key], '["turn-1","turn-2"]');
  await assert.rejects(() => createStateStore(file).set('elpis:prompt-rail-bookmarks:../config', '[]'), /Unsupported/);
});

test('saved project chat assignments preserve the workspace and remain writable after restart', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-project-chat-state-')), 'workspace.json');
  const assignments = JSON.stringify({ 'chat-1': 'project-1' });
  const values = { 'elpis-project-chats-v1': assignments, 'elpis-theme': 'dark', 'elpis-draft-v1:chat-1': 'Unsent draft' };
  fs.writeFileSync(file, JSON.stringify(values));
  const store = createStateStore(file);
  assert.equal(store.read().error, undefined);
  assert.deepEqual(store.read(), values);
  await store.set('elpis-project-chats-v1', JSON.stringify({ 'chat-1': 'project-2' }));
  const reopened = createStateStore(file);
  assert.equal(reopened.read()['elpis-draft-v1:chat-1'], 'Unsent draft');
  assert.deepEqual(JSON.parse(reopened.read()['elpis-project-chats-v1']), { 'chat-1': 'project-2' });
  await assert.rejects(() => reopened.set('elpis-unknown-setting', 'untrusted'), /Unsupported/);
});

// The review's reproduction: two actual preloads and preference modules, routed
// through production window IPC to one real store. Broadcasts can be delayed.
function windows(t, initial = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-windows-')), 'workspace.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  const store = createStateStore(file), ipc = new EventEmitter(), handlers = new Map(), pending = [], broadcasts = [];
  ipc.handle = (key, handler) => handlers.set(key, handler);
  ipc.removeHandler = key => handlers.delete(key);
  const scope = createWindowIpc(ipc);
  let delay = false;
  const open = id => {
    const renderer = new EventEmitter(), mainFrame = { url: 'http://127.0.0.1:45001/' };
    const webContents = { id, mainFrame, isDestroyed: () => false, send: (channel, value) => {
      const deliver = () => renderer.emit(channel, {}, value);
      if (delay) broadcasts.push(deliver); else deliver();
    } };
    const event = () => ({ sender: webContents, senderFrame: mainFrame });
    renderer.sendSync = channel => { const e = event(); ipc.emit(channel, e); return e.returnValue; };
    renderer.invoke = (channel, ...args) => {
      const result = Promise.resolve().then(() => handlers.get(channel)(event(), ...args));
      pending.push(result); return result;
    };
    const dispose = registerState({ host: { webContents }, origin: 'http://127.0.0.1:45001', ipcMain: scope({ webContents }), dialog: {}, store });
    t.after(dispose);
    const context = vm.createContext({ window: {}, require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (key, value) => { context.window[key] = value; } } };
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), context);
    const storage = context.window.elpisDesktop.storage, errors = [], changes = [];
    storage.onError(message => errors.push(message));
    storage.onChange?.(key => changes.push(key));
    const code = require('typescript').transpileModule(fs.readFileSync(path.join(__dirname, '../lib/preferences.ts'), 'utf8'), { compilerOptions: { module: 1 } }).outputText;
    const exports = {};
    vm.runInContext('(function(require,exports){' + code + '\n})', context)(name => name === 'react' ? {} : { appStorage: () => storage }, exports);
    exports.readPreferences(); // Both windows cache defaults before either edits.
    return { storage, preferences: exports, errors, changes };
  };
  return { store, file, open, delay: value => { delay = value; }, deliver: () => { for (const send of broadcasts.splice(0)) send(); }, settle: async () => { await Promise.allSettled(pending.splice(0)); await new Promise(resolve => setImmediate(resolve)); } };
}

test('sidebar bookmarks save through native IPC and preserve existing workspace state', async t => {
  const original = {
    'elpis-bookmarked-chats-v1': '["chat-existing"]',
    'elpis-pinned-chats-v1': '["chat-pinned"]',
    'elpis-chat-attention-v1': '{"unread":["chat-unread"],"plans":{}}',
    'elpis-draft-v1:chat-existing': 'Unsent draft',
  };
  const f = windows(t, original), a = f.open(1);
  a.storage.setItem('elpis-bookmarked-chats-v1', '["chat-new","chat-existing"]');
  await f.settle();
  assert.deepEqual(a.errors, []);
  assert.deepEqual(createStateStore(f.file).read(), { ...original, 'elpis-bookmarked-chats-v1': '["chat-new","chat-existing"]' });
  a.storage.setItem('elpis-bookmarked-chats-v1', '["chat-existing"]');
  await f.settle();
  assert.deepEqual(createStateStore(f.file).read(), original);
});

test('SETTINGS2 sizing, corners and sleep preference persist through native IPC and reopening', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  a.preferences.savePreferences({ interfaceSize: 'l', codeSize: 's', cornerStyle: 'rounded', preventSleep: true }); await f.settle();
  b.preferences.savePreferences({ codeSize: 'l' }); await f.settle();
  const saved = JSON.parse(createStateStore(f.file).read()['elpis-preferences-v1']);
  assert.equal(saved.interfaceSize, 'l'); assert.equal(saved.codeSize, 'l'); assert.equal(saved.cornerStyle, 'rounded'); assert.equal(saved.preventSleep, true);
  const fresh = f.open(3).preferences.readPreferences();
  assert.equal(fresh.interfaceSize, 'l'); assert.equal(fresh.codeSize, 'l'); assert.equal(fresh.cornerStyle, 'rounded'); assert.equal(fresh.preventSleep, true);
});

test('appearance choices persist through real desktop IPC, rebase across windows, and reject unknown values', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  a.preferences.savePreferences({ accent: 'teal' }); await f.settle();
  b.preferences.savePreferences({ chatFont: 'serif' }); await f.settle();
  const customThemes = '[{"id":"palette-1","name":"My palette"}]';
  a.preferences.savePreferences({ customThemes, selectedPalette: 'palette-1' }); await f.settle();
  const saved = JSON.parse(createStateStore(f.file).read()['elpis-preferences-v1']);
  assert.equal(saved.accent, 'teal'); assert.equal(saved.chatFont, 'serif');
  assert.equal(saved.customThemes, customThemes); assert.equal(saved.selectedPalette, 'palette-1');
  for (const window of [a, b]) {
    assert.equal(window.preferences.readPreferences().accent, 'teal');
    assert.equal(window.preferences.readPreferences().chatFont, 'serif');
    assert.equal(window.preferences.readPreferences().customThemes, customThemes);
    assert.equal(window.preferences.readPreferences().selectedPalette, 'palette-1');
    assert.deepEqual(window.errors, []);
  }
  for (const changes of [{ accent: 'bad' }, { chatFont: 'bad' }])
    await assert.rejects(f.store.patch({ key: 'elpis-preferences-v1', baseRevision: f.store.snapshot().revision, changes }), /Unsupported/);
});

test('Agent runs visibility persists through actual desktop IPC and synchronizes between windows', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  a.preferences.savePreferences({ showAgentRuns: false }); await f.settle();
  assert.deepEqual(a.errors, []);
  assert.equal(JSON.parse(createStateStore(f.file).read()['elpis-preferences-v1']).showAgentRuns, false);
  assert.equal(b.preferences.readPreferences().showAgentRuns, false);
  b.preferences.savePreferences({ showAgentRuns: true }); await f.settle();
  assert.equal(a.preferences.readPreferences().showAgentRuns, true);
  assert.deepEqual(b.errors, []);
  await assert.rejects(f.store.patch({ key: 'elpis-preferences-v1', baseRevision: f.store.snapshot().revision, changes: { showAgentRuns: 'yes' } }), /Unsupported/);
});

test('two actual preloads preserve wrap when another window changes notifications and refresh both preference caches', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  a.preferences.savePreferences({ softWrap: true }); await f.settle();
  b.preferences.savePreferences({ turnNotifications: 'always' }); await f.settle();
  const saved = JSON.parse(createStateStore(f.file).read()['elpis-preferences-v1']);
  assert.equal(saved.softWrap, true); assert.equal(saved.turnNotifications, 'always');
  for (const window of [a, b]) {
    assert.equal(window.preferences.readPreferences().softWrap, true);
    assert.equal(window.preferences.readPreferences().turnNotifications, 'always');
    assert.ok(window.changes.includes('elpis-preferences-v1'));
    assert.deepEqual(window.errors, []);
  }
});

test('rejected writes clear optimistic cache values and report failures without disturbing another key', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  await a.storage.saveItem('elpis-theme', 'dark'); await f.settle();
  fs.renameSync(f.file, f.file + '.fixture'); fs.mkdirSync(f.file);
  a.storage.setItem('elpis-sidebar-width', '240'); await f.settle();
  assert.match(a.errors.at(-1), /Could not save/);
  for (const window of [a, b]) { assert.equal(window.storage.getItem('elpis-sidebar-width'), null); assert.equal(window.storage.getItem('elpis-theme'), 'dark'); }
  a.storage.setItem('../config.toml', 'unsupported'); await f.settle();
  assert.equal(a.storage.getItem('../config.toml'), null); assert.match(a.errors.at(-1), /Unsupported/);
});

test('stale preference fields rebase; overlapping fields conflict and restore the committed cache', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  f.delay(true);
  a.preferences.savePreferences({ softWrap: true }); await f.settle();
  b.preferences.savePreferences({ turnNotifications: 'always' }); await f.settle();
  assert.equal(JSON.parse(f.store.read()['elpis-preferences-v1']).softWrap, true);
  a.preferences.savePreferences({ softWrap: false }); await f.settle();
  b.preferences.savePreferences({ softWrap: true, turnNotifications: 'never' }); await f.settle();
  assert.match(b.errors.at(-1), /another window/i);
  assert.equal(b.preferences.readPreferences().softWrap, false);
  assert.equal(b.preferences.readPreferences().turnNotifications, 'always', 'a conflict rejects the entire patch');
  f.deliver();
  assert.equal(a.preferences.readPreferences().turnNotifications, 'always');
});

test('Love Spot journals merge independent element drafts across delayed native windows', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2), key = 'elpis-draft-v1:love-spot-text-journal';
  f.delay(true);
  a.storage.patchItem(key, { 'page:note:a': 'Masih verdict' }); await f.settle();
  b.storage.patchItem(key, { 'page:note:b': 'Other edit' }); await f.settle();
  assert.deepEqual(JSON.parse(f.store.read()[key]), { 'page:note:a': 'Masih verdict', 'page:note:b': 'Other edit' });
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  b.storage.patchItem('elpis-draft-v1:chat-1', { text: 'not a journal' }); await f.settle();
  assert.match(b.errors.at(-1), /Unsupported workspace patch/);
});

test('rapid own edits remain ordered; stale shared drafts conflict rather than silently replacing another window', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2), key = 'elpis-draft-v1:chat-1';
  a.storage.setItem(key, 'first'); a.storage.setItem(key, 'second'); await f.settle();
  assert.equal(f.store.read()[key], 'second'); assert.deepEqual(a.errors, []);
  f.delay(true);
  a.storage.setItem(key, 'third'); await f.settle();
  await assert.rejects(b.storage.saveItem(key, 'competing draft'), /another window/i);
  assert.equal(b.storage.getItem(key), 'third');
  f.deliver();
  b.storage.removeItem(key); await f.settle(); f.deliver();
  assert.equal(a.storage.getItem(key), null);
});

test('delayed duplicate saves from another window succeed without a conflict, but different stale values still fail', async t => {
  const f = windows(t), a = f.open(1), b = f.open(2);
  f.delay(true);
  for (const [key, value] of [['elpis-theme', 'dark'], ['elpis-draft-v1:chat-1', 'shared draft'], ['elpis-last-chat', 'chat-1']]) {
    a.storage.setItem(key, value); await f.settle();
    await b.storage.saveItem(key, value);
    a.storage.setItem(key, value + '-new'); await f.settle();
    await assert.rejects(b.storage.saveItem(key, value + '-different'), /another window/i);
  }
  a.preferences.savePreferences({ accent: 'teal', chatFont: 'serif' }); await f.settle();
  b.preferences.savePreferences({ accent: 'teal', transcriptSize: 'l' }); await f.settle();
  assert.deepEqual(b.errors, [], 'an already committed choice is not a competing edit');
  assert.equal(b.preferences.readPreferences().transcriptSize, 'l');
  a.preferences.savePreferences({ accent: 'blue' }); await f.settle();
  b.preferences.savePreferences({ accent: 'rose', chatFont: 'mono' }); await f.settle();
  assert.match(b.errors.at(-1), /another window/i);
  assert.equal(b.preferences.readPreferences().chatFont, 'serif');
  a.storage.removeItem('elpis-last-chat'); await f.settle();
  b.storage.removeItem('elpis-last-chat'); await f.settle();
  assert.equal(b.errors.length, 1, 'duplicate removal also succeeds');
  f.deliver();
});

test('main revisions rebase other keys, reject overlapping and invalid patches, and do not publish failed saves', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-revisions-')), 'workspace.json');
  const store = createStateStore(file), changes = [];
  store.subscribe(change => changes.push(change));
  await store.patch({ key: 'elpis-theme', baseRevision: 0, value: 'dark' });
  const result = await store.patch({ key: 'elpis-sidebar-width', baseRevision: 0, value: '240' });
  assert.equal(result.rebased, true); assert.equal(result.revision, 2);
  await assert.rejects(store.patch({ key: 'elpis-theme', baseRevision: 0, value: 'light' }), /another window/i);
  for (const patch of [{ key: 'elpis-theme', value: 'light' }, { key: 'elpis-theme', baseRevision: 99, value: 'light' }, { key: '../config', baseRevision: 2, value: 'x' }, { key: 'elpis-preferences-v1', baseRevision: 2, changes: { softWrap: 'yes' } }]) await assert.rejects(store.patch(patch), /Unsupported/);
  assert.equal(changes.length, 2);
  fs.renameSync(file, file + '.fixture'); fs.mkdirSync(file);
  await assert.rejects(store.patch({ key: 'elpis-theme', baseRevision: 2, value: 'light' }), /Could not save/);
  assert.equal(store.read()['elpis-theme'], 'dark'); assert.equal(changes.length, 2);
  fs.renameSync(file, file + '.unavailable');
  await store.patch({ key: 'elpis-theme', baseRevision: 2, value: 'light' });
  assert.equal(store.snapshot().revision, 3);
});

test('persistence does not use synchronous filesystem writes', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-async-')), 'workspace.json');
  const store = createStateStore(file), originals = {};
  for (const name of ['mkdirSync', 'writeFileSync', 'renameSync', 'fsyncSync']) { originals[name] = fs[name]; fs[name] = () => { throw Error('synchronous persistence'); }; }
  try { await store.set('elpis-theme', 'dark'); }
  finally { Object.assign(fs, originals); }
  assert.equal(createStateStore(file).read()['elpis-theme'], 'dark');
});

test('SIGKILL immediately after acknowledgement preserves the last acknowledged write', { timeout: 10000 }, async t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-crash-')), 'workspace.json');
  const child = spawn(process.execPath, ['-e', `const {createStateStore}=require(${JSON.stringify(path.join(__dirname, 'state.cjs'))});const store=createStateStore(process.argv[1]);store.set('elpis-draft-v1:chat-1','Durable متن فارسی').then(()=>{process.send('ack');setInterval(()=>{},1000);});`, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`child exited ${code} before acknowledgement`))); });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  assert.equal(createStateStore(file).read()['elpis-draft-v1:chat-1'], 'Durable متن فارسی');
});

test('desktop state survives a new process store, preserves exact drafts and uses private files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-'));
  const file = path.join(dir, 'profile', 'workspace.json');
  const store = createStateStore(file);
  const draft = 'Review this\n\nمتن فارسی';
  await Promise.all([store.set('elpis-draft-v1:chat-1', draft), store.set('elpis-draft-v1:recovery-chat-1', 'Unsent edited message'), store.set('elpis-theme', 'light'), store.set('elpis-theme', 'dark'), store.set('elpis-workflow-draft-v1', '{"workflow":"exact draft"}')]);
  const reopened = createStateStore(file);
  assert.equal(reopened.read()['elpis-draft-v1:chat-1'], draft);
  assert.equal(reopened.read()['elpis-draft-v1:recovery-chat-1'], 'Unsent edited message', 'a failed replacement is saved separately from the current composer draft');
  assert.equal(reopened.read()['elpis-theme'], 'dark');
  assert.equal(reopened.read()['elpis-workflow-draft-v1'], '{"workflow":"exact draft"}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  await reopened.set('elpis-draft-v1:chat-1', null);
  assert.equal(createStateStore(file).read()['elpis-draft-v1:chat-1'], undefined);
  assert.equal(createStateStore(file).read()['elpis-draft-v1:recovery-chat-1'], 'Unsent edited message');
  await assert.rejects(() => reopened.set('elpis-draft-v1:recovery:chat-1', 'unsupported old namespace'), /Unsupported/);
  await assert.rejects(() => reopened.set('../config.toml', 'x'), /Unsupported/);
  await assert.rejects(() => reopened.set('elpis-theme', 'x'.repeat(1_000_001)), /large/);
});

test('corrupt state is reported and preserved, rather than silently overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-invalid-'));
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(file, '{broken');
  const store = createStateStore(file);
  assert.match(store.read().error, /read/);
  await assert.rejects(() => store.set('elpis-theme', 'light'), /read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('pinned chats and terminal height persist across a desktop restart, with unknown keys still rejected', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-ux-state-')), 'workspace.json');
  const store = createStateStore(file), pins = JSON.stringify(['chat-1', 'chat-2']);
  await store.set('elpis-pinned-chats-v1', pins);
  await store.set('elpis-terminal-height', '360');
  const reopened = createStateStore(file);
  assert.equal(reopened.read()['elpis-pinned-chats-v1'], pins);
  assert.equal(reopened.read()['elpis-terminal-height'], '360');
  await assert.rejects(store.set('elpis-pinned-chats-v2', pins), /Unsupported/);
  await assert.rejects(store.set('elpis-terminal-height:other', '360'), /Unsupported/);
});

test('chat groups, their chats and the sidebar order persist across a desktop restart; other versions are rejected', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-groups-state-')), 'workspace.json');
  const store = createStateStore(file), groups = JSON.stringify({ groups: [{ id: 'g1', name: 'Work' }], members: { 'chat-1': 'g1' }, groupBy: 'custom', sortBy: 'name', collapsed: [] });
  await store.set('elpis-chat-groups-v1', groups);
  await store.set('elpis-session-manager-v1', 'manager-thread');
  assert.equal(createStateStore(file).read()['elpis-chat-groups-v1'], groups);
  assert.equal(createStateStore(file).read()['elpis-session-manager-v1'], 'manager-thread');
  await assert.rejects(store.set('elpis-chat-groups-v2', groups), /Unsupported/);
  await assert.rejects(store.set('elpis-session-manager-v2', 'manager-thread'), /Unsupported/);
});

test('saved project memberships and Session Manager survive a full workspace round trip', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-union-')), 'workspace.json');
  const saved = {
    'elpis-theme': 'dark', 'elpis-chat-tabs-v1': '["h2"]', 'elpis-browser-sessions-v1': '{}',
    'elpis-sidebar-width': '282', 'elpis-preferences-v1': '{"accent":"orange"}',
    'elpis-projects-v1': '[{"id":"p","path":"/tmp/elpis-project"}]',
    'elpis-project-chats-v1': '{"h2":"p"}', 'elpis-pinned-chats-v1': '["h2"]',
    'elpis-terminal-height': '240', 'elpis-last-chat': 'h2', 'elpis-session-manager-v1': 'manager-thread',
    'elpis-session-manager-actions-v1': '{"h2":[{"action":"rename","status":"done","reason":"Name unset or irrelevant"}]}',
    'elpis-workflow-draft-v1': '{}', 'elpis-editor-v1': '{}', 'elpis-chat-attention-v1': '{}',
    'elpis-chat-groups-v1': '{"groups":[]}', 'elpis-draft-v1:h2': 'Unsent draft',
  };
  const original = JSON.stringify(saved); fs.writeFileSync(file, original);
  const store = createStateStore(file);
  assert.deepEqual(store.read(), saved);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'reading must preserve the original file');
  await store.set('elpis-project-chats-v1', '{"h2":"p","chat-2":"p"}');
  await store.set('elpis-session-manager-v1', 'manager-thread-2');
  const actions = '{"h2":[{"action":"archive","status":"done","reason":"No activity for more than 7 days"}]}';
  await store.set('elpis-session-manager-actions-v1', actions);
  const expected = { ...saved, 'elpis-project-chats-v1': '{"h2":"p","chat-2":"p"}', 'elpis-session-manager-v1': 'manager-thread-2', 'elpis-session-manager-actions-v1': actions };
  assert.deepEqual(createStateStore(file).read(), expected, 'reopen must retain every saved key and draft');
  const persisted = fs.readFileSync(file, 'utf8');
  await assert.rejects(store.set('elpis-project-chats-v2', '{}'), /Unsupported/);
  assert.equal(fs.readFileSync(file, 'utf8'), persisted, 'unknown keys must not change saved state');
});

test('reading options patch the preferences as the renderer saves them; wrong values are refused', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-reading-state-')), 'workspace.json');
  const store = createStateStore(file), key = 'elpis-preferences-v1';
  const reading = { transcriptSize: 'l', transcriptWidth: 'm', interfaceFont: 'serif', codeFont: 'DejaVu Sans Mono' };
  await store.patch({ key, baseRevision: 0, changes: reading });
  assert.deepEqual(JSON.parse(createStateStore(file).read()[key]), reading);
  for (const changes of [{ transcriptSize: 'xl' }, { transcriptWidth: 'full' }, { interfaceFont: 'comic' }, { codeFont: 12 }]) await assert.rejects(store.patch({ key, baseRevision: 1, changes }), /Unsupported/, JSON.stringify(changes));
});

test('A70: Settings orders and cross-group membership survive reopening the real desktop store', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-settings-order-')), 'workspace.json');
  const key = 'elpis-preferences-v1', store = createStateStore(file);
  await store.set(key, JSON.stringify({ navOrder: 'canvas,customize', sendShortcut: 'modEnter' }));
  await store.patch({ key, baseRevision: 1, changes: { settingsSectionOrder: 'advanced,app,models,permissions,context,connections' } });
  const settingsPageGroups = JSON.stringify({ general: 'context', appearance: 'connections' });
  const shortcutBindings = JSON.stringify({ settings: 'Ctrl+Alt+Y', search: '' });
  await store.patch({ key, baseRevision: 2, changes: { settingsPageOrder: 'appearance,general,notifications', settingsPageGroups, shortcutBindings } });
  assert.deepEqual(JSON.parse(createStateStore(file).read()[key]), {
    navOrder: 'canvas,customize', sendShortcut: 'modEnter',
    settingsSectionOrder: 'advanced,app,models,permissions,context,connections', settingsPageOrder: 'appearance,general,notifications', settingsPageGroups, shortcutBindings,
  });
  for (const changes of [{ settingsSectionOrder: [] }, { settingsPageOrder: false }, { settingsPageGroups: {} }, { shortcutBindings: {} }]) {
    await assert.rejects(store.patch({ key, baseRevision: 3, changes }), /Unsupported/);
  }
  assert.equal(JSON.parse(createStateStore(file).read()[key]).settingsPageGroups, settingsPageGroups, 'a rejected patch preserves the saved membership');
});

test('retrying the same value after an actual write failure really persists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-retry-'));
  const file = path.join(dir, 'workspace.json');
  const store = createStateStore(file);
  fs.mkdirSync(file);
  await assert.rejects(() => store.set('elpis-projects-v1', 'project input'), /Could not save/);
  assert.equal(store.read()['elpis-projects-v1'], undefined, 'failed changes must not appear saved or persist after cancellation');
  fs.renameSync(file, path.join(dir, 'unavailable-fixture'));
  await store.set('elpis-projects-v1', 'project input');
  assert.equal(createStateStore(file).read()['elpis-projects-v1'], 'project input');
});

test('only the app main frame can read state or choose a folder; cancel has no side effects', async () => {
  const handlers = new Map(), listeners = new Map();
  const ipcMain = { handle: (key, value) => handlers.set(key, value), on: (key, value) => listeners.set(key, value), removeHandler: key => handlers.delete(key), removeListener: key => listeners.delete(key) };
  const mainFrame = { url: 'http://127.0.0.1:45001/' }, webContents = { mainFrame };
  const host = { webContents };
  let dialogs = 0;
  const dialog = { showOpenDialog: async () => { dialogs++; return { canceled: true, filePaths: [] }; } };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-ipc-')), 'workspace.json');
  const dispose = registerState({ host, origin: 'http://127.0.0.1:45001', ipcMain, dialog, store: createStateStore(file) });
  const foreign = { sender: {}, senderFrame: { url: 'https://example.com' } };
  await assert.rejects(() => handlers.get('elpis:folder')(foreign), /application/);
  await assert.rejects(() => handlers.get('elpis:state:write')(foreign, { key: 'elpis-theme', value: 'dark', baseRevision: 0 }), /application/);
  const own = { sender: webContents, senderFrame: mainFrame };
  for (const senderFrame of [{ url: mainFrame.url }, { url: 'https://example.com' }]) await assert.rejects(() => handlers.get('elpis:state:write')({ ...own, senderFrame }, { key: 'elpis-theme', value: 'dark', baseRevision: 0 }), /application/);
  assert.equal(await handlers.get('elpis:folder')(own), null);
  assert.equal(dialogs, 1);
  const dir = path.dirname(file);
  assert.equal(await handlers.get('elpis:folder:resolve')(own, dir), fs.realpathSync(dir));
  await assert.rejects(() => handlers.get('elpis:folder:resolve')(own, file), /folder/);
  await assert.rejects(() => handlers.get('elpis:folder:resolve')(own, 'relative'), /absolute/);
  dispose();
  assert.equal(handlers.size, 0);
});

test('attachment drafts persist through the real private store with separate file and total limits', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-attachment-state-')), 'workspace.json');
  const store = createStateStore(file), key = 'elpis-attachments-v1:chat-1';
  const value = JSON.stringify([{id:'image',name:'image.png',type:'image',mimeType:'image/png',dataUrl:'data:image/png;base64,'+'A'.repeat(1500000)}]);
  await store.set(key, value);
  assert.equal(createStateStore(file).read()[key], value);
  await assert.rejects(store.set('elpis-theme', value), /large/);
  await assert.rejects(store.set('elpis-attachments-v1:oversized', 'x'.repeat(6*1024*1024+1)), /large/);
  await assert.rejects(store.set('elpis-attachments-v1:bad:key', value), /Unsupported/);
  const large='x'.repeat(5*1024*1024);await store.set('elpis-attachments-v1:chat-2',large);
  await assert.rejects(store.set('elpis-attachments-v1:chat-3',large), /drafts are too large/);
  assert.equal(createStateStore(file).read()['elpis-attachments-v1:chat-2'],large);
  assert.equal(createStateStore(file).read()['elpis-attachments-v1:chat-3'],undefined);
  await store.set(key,null);assert.equal(createStateStore(file).read()[key],undefined);
});
