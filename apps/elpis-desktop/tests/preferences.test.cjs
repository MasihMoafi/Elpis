// Settings → General and Notifications: the preference, queue and notification modules app/page.tsx wires in.
// Compiles the real TypeScript modules; no browser, runtime or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { closeNeedsConfirmation } = require('../desktop/preferences.cjs');

const root = path.resolve(__dirname, '..');
function loader() {
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const local = id => {
      if (!id.startsWith('@/')) return require(id);
      const base = path.join(root, id.slice(2));
      return load(['.ts', '.tsx'].map(extension => base + extension).find(fs.existsSync));
    };
    new Function('require', 'exports', 'module', code)(local, module.exports, module);
    return module.exports;
  };
  return name => load(path.join(root, name));
}
function browser({ focused = true } = {}) {
  const values = new Map(), shown = [], posts = [];
  let fetchResult = () => ({ ok: true, json: async () => ({}) });
  global.window = { addEventListener() {}, removeEventListener() {}, focus() {}, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } };
  global.document = { visibilityState: 'visible', hasFocus: () => focused };
  global.Notification = class { static permission = 'granted'; constructor(title, options) { this.title = title; this.options = options; shown.push(this); } close() {} };
  global.AudioContext = class { currentTime = 0; destination = {}; createOscillator() { return { frequency: {}, connect: node => node, start() {}, stop() {} }; } createGain() { const gain = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: node => node }; return gain; } };
  global.fetch = async (url, init) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : undefined }); return fetchResult(posts.length); };
  return { values, shown, posts, setFocus: value => { focused = value; }, respond: next => { fetchResult = next; } };
}

test('preferences keep valid choices on this device, and the desktop reads the same close setting', () => {
  const env = browser(), use = loader();
  const { readPreferences, savePreferences, DEFAULT_PREFERENCES, PREFERENCES_KEY } = use('lib/preferences.ts');
  assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
  savePreferences({ sendShortcut: 'modEnter', confirmClose: true, defaultFolder: '/work' });
  const saved = JSON.parse(env.values.get(PREFERENCES_KEY));
  assert.equal(saved.sendShortcut, 'modEnter'); assert.equal(saved.defaultFolder, '/work');
  assert.equal(closeNeedsConfirmation({ read: () => Object.fromEntries(env.values) }), true);
  env.values.set(PREFERENCES_KEY, JSON.stringify({ sendShortcut: 'always', followUp: 'queue', defaultFolder: 'relative', showContextUsage: 'yes' }));
  const fresh = loader()('lib/preferences.ts').readPreferences();
  assert.deepEqual([fresh.sendShortcut, fresh.followUp, fresh.defaultFolder, fresh.showContextUsage], ['enter', 'queue', '', true], 'unknown or unsafe values fall back to defaults (the context ring is on by default, as in the ChatGPT app)');
});

test('send shortcut, hint and new-chat folder follow the saved preferences', () => {
  browser();
  const { isSendKey, sendHint, newChatFolder } = loader()('lib/preferences.ts');
  const key = (extra = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, nativeEvent: { isComposing: false }, ...extra });
  const enter = { sendShortcut: 'enter' }, mod = { sendShortcut: 'modEnter' };
  assert.equal(isSendKey(key(), enter), true);
  assert.equal(isSendKey(key({ shiftKey: true }), enter), false);
  assert.equal(isSendKey(key({ nativeEvent: { isComposing: true } }), enter), false);
  assert.equal(isSendKey(key(), mod), false, 'Enter inserts a new line when Ctrl+Enter sends');
  assert.equal(isSendKey(key({ ctrlKey: true }), mod), true);
  assert.equal(isSendKey(key({ metaKey: true }), mod), true);
  assert.equal(isSendKey(key({ key: 'a', ctrlKey: true }), mod), false);
  assert.match(sendHint(mod), /^Ctrl\+Enter to send/);
  assert.equal(newChatFolder(' /project ', { defaultFolder: '/default' }), '/project');
  assert.equal(newChatFolder('', { defaultFolder: '/default' }), '/default');
  assert.equal(newChatFolder('', { defaultFolder: '' }), '');
});

test('queued follow-ups wait for a completed turn, survive stops and failures, and steer only when chosen', async () => {
  const env = browser(), use = loader();
  const { savePreferences } = use('lib/preferences.ts');
  const { queueFollowUp, sendQueuedFollowUp, sendFollowUpNow } = use('lib/follow-ups.ts');
  assert.equal(queueFollowUp('T', 'steered instead'), false, 'Steer is the default');
  savePreferences({ followUp: 'queue' });
  assert.equal(queueFollowUp('T', 'first', [{ id: 'a', type: 'text', name: 'notes.txt' }]), true);
  assert.equal(queueFollowUp('T', 'second'), true);
  await sendQueuedFollowUp('turn/completed', { threadId: 'T', turn: { status: 'interrupted' } });
  await sendQueuedFollowUp('turn/started', { threadId: 'T', turn: { status: 'completed' } });
  assert.deepEqual(env.posts, [], 'a stopped turn sends nothing');
  env.respond(count => count === 1 ? { ok: false, status: 409, json: async () => ({ error: 'This conversation is running. Use Steer with its active turn ID.' }) } : { ok: true, json: async () => ({ turn: { id: 'next' } }) });
  await sendQueuedFollowUp('turn/completed', { threadId: 'T', turn: { status: 'completed' } });
  assert.deepEqual(env.posts.map(post => [post.url, post.body]), [
    ['/api/threads/T/turns', { text: 'first', attachments: [{ id: 'a', type: 'text', name: 'notes.txt' }] }],
    ['/api/threads/T/turns', { text: 'first', attachments: [{ id: 'a', type: 'text', name: 'notes.txt' }] }],
  ], 'a just-finished thread is retried, once per 409');
  env.respond(() => ({ ok: false, status: 502, json: async () => ({ error: 'Elpis rejected the operation' }) }));
  await assert.rejects(sendQueuedFollowUp('turn/completed', { threadId: 'T', turn: { status: 'completed' } }), /rejected/);
  env.respond(() => ({ ok: true, json: async () => ({}) }));
  await sendFollowUpNow('T', 'missing-id', 'turn-1');
  assert.equal(env.posts.length, 3, 'unknown queue entries send nothing');
});

test('a queued message sent now steers the running turn; another chat finishing leaves it queued', async () => {
  const env = browser(), use = loader();
  use('lib/preferences.ts').savePreferences({ followUp: 'queue' });
  const queue = use('lib/follow-ups.ts');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'queued-1', configurable: true });
  try { queue.queueFollowUp('R', 'now please'); } finally { delete globalThis.crypto.randomUUID; }
  await queue.sendQueuedFollowUp('turn/completed', { threadId: 'other', turn: { status: 'completed' } });
  assert.equal(env.posts.length, 0);
  await queue.sendFollowUpNow('R', 'queued-1', 'turn-9');
  assert.deepEqual(env.posts.map(post => [post.url, post.body]), [['/api/threads/R/steer', { text: 'now please', expectedTurnId: 'turn-9' }]]);
  await queue.sendQueuedFollowUp('turn/completed', { threadId: 'R', turn: { status: 'completed' } });
  assert.equal(env.posts.length, 1, 'a message sent now is not sent again');
});

test('notifications follow the turn and input choices, skip agents and stopped turns, and notify once', () => {
  const env = browser({ focused: false }), use = loader();
  const { savePreferences } = use('lib/preferences.ts');
  const { notifyRuntimeEvent, notifyApproval } = use('lib/notifications.ts');
  const threads = [{ id: 'root', name: 'Fix the parser' }, { id: 'child', name: 'Check docs', parentThreadId: 'root' }];
  const done = (threadId, id, status = 'completed') => notifyRuntimeEvent('turn/completed', { threadId, turn: { id, status } }, threads);
  done('root', 't1'); done('root', 't1');
  done('child', 't2'); done('root', 't3', 'interrupted'); done('unknown', 't4');
  assert.deepEqual(env.shown.map(item => [item.title, item.options.body, item.options.silent]), [['Elpis finished', 'Fix the parser', true]]);
  env.setFocus(true); done('root', 't5');
  assert.equal(env.shown.length, 1, 'Only when unfocused stays quiet while you look at Elpis');
  savePreferences({ turnNotifications: 'always' }); done('root', 't6', 'failed');
  assert.equal(env.shown.at(-1).title, 'Elpis stopped with an error');
  savePreferences({ turnNotifications: 'never' }); env.setFocus(false); done('root', 't7');
  assert.equal(env.shown.length, 2);
  const approval = { id: 'a1', ownerThreadId: 'root', method: 'item/commandExecution/requestApproval', params: { threadId: 'root', reason: 'Run the tests' } };
  notifyApproval(approval, threads); notifyApproval(approval, threads);
  assert.deepEqual([env.shown.length, env.shown.at(-1).title, env.shown.at(-1).options.body], [3, 'Elpis needs your approval', 'Fix the parser · Run the tests']);
  savePreferences({ inputNotifications: false });
  notifyApproval({ ...approval, id: 'a2' }, threads);
  assert.equal(env.shown.length, 3);
  global.Notification.permission = 'denied';
  savePreferences({ turnNotifications: 'always' }); done('root', 't8');
  assert.equal(env.shown.length, 3, 'nothing is shown without permission');
});
