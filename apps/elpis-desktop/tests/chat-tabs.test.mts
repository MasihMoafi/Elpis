import test from 'node:test';
import assert from 'node:assert/strict';
import { activate, activeTab as findActiveTab, addBackgroundTab, addTab, closeTab, cycle, followChat, forgetChats, makeTab, readTabs, renameTabs, startTabs, tabFor as findTabFor, writeTabs } from '../lib/chat-tabs.ts';
import type { ChatTabs } from '../lib/chat-tabs.ts';

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
const activeTab = (state: ChatTabs) => { const tab = findActiveTab(state); assert.ok(tab); return tab; };
const tabFor = (state: ChatTabs, threadId: string) => { const tab = findTabFor(state, threadId); assert.ok(tab); return tab; };
/** Alpha, Bravo, Charlie; Charlie is shown. */
const three = () => addTab(addTab(followChat(startTabs(), { id: 'a', title: 'Alpha' }), makeTab('b', 'Bravo')), makeTab('c', 'Charlie'));
const ids = (state: ChatTabs) => state.tabs.map(tab => tab.threadId);
const showing = (state: ChatTabs, threadId: string) => activate(state, tabFor(state, threadId).id);

test('a new tab is an empty sibling chat at the end and becomes the shown tab', () => {
  const state = addTab(three());
  assert.deepEqual(ids(state), ['a', 'b', 'c', null]);
  const active = activeTab(state), last = addTab(state).tabs.at(-1);
  assert.equal(active.threadId, null);
  assert.ok(typeof active.draftKey === 'string');
  assert.match(active.draftKey, /^new-tab-/, 'each empty tab has its own draft');
  assert.ok(last);
  assert.notEqual(last.draftKey, active.draftKey);
});

test('a background tab opens beside the others without replacing the shown chat', () => {
  const state = three(), next = addBackgroundTab(state, makeTab('workflow', 'Workflow'));
  assert.deepEqual(ids(next), ['a', 'b', 'c', 'workflow']);
  assert.equal(activeTab(next).threadId, 'c');
});

test('closing the shown tab shows its right neighbour, else its left; another tab leaves the shown one alone', () => {
  const state = showing(three(), 'b');
  const afterMiddle = closeTab(state, state.activeId);
  assert.deepEqual(ids(afterMiddle), ['a', 'c']);
  assert.equal(activeTab(afterMiddle).threadId, 'c');
  const last = three();
  assert.equal(activeTab(closeTab(last, last.activeId)).threadId, 'b');
  assert.equal(closeTab(state, tabFor(state, 'a').id).activeId, state.activeId);
});

test('closing the last tab leaves one empty New chat', () => {
  const empty = startTabs(), left = closeTab(empty, empty.activeId);
  assert.equal(left.tabs.length, 1);
  assert.equal(activeTab(left).threadId, null);
  const one = followChat(startTabs(), { id: 'a', title: 'Alpha' });
  assert.deepEqual(ids(closeTab(one, one.activeId)), [null]);
});

test('Ctrl+Tab cycles forwards and backwards around the strip', () => {
  const state = three();
  assert.equal(activeTab(cycle(state, 1)).threadId, 'a', 'past the last tab wraps to the first');
  assert.equal(activeTab(cycle(cycle(state, -1), -1)).threadId, 'a');
  assert.equal(activeTab(cycle(showing(state, 'a'), -1)).threadId, 'c');
  const one = startTabs();
  assert.equal(cycle(one, 1), one);
});

test('the shown tab follows the chat on screen and opening a chat does not add a tab', () => {
  let state = showing(three(), 'b');
  state = followChat(state, { id: 'z', title: 'Zulu' });
  assert.deepEqual(ids(state), ['a', 'z', 'c']);
  assert.equal(tabFor(state, 'z').title, 'Zulu');
  assert.equal(followChat(state, { id: 'z', title: 'Zulu' }), state, 'nothing changes when nothing changed');
  const empty = followChat(state, null);
  assert.equal(activeTab(empty).threadId, null);
  assert.equal(activeTab(empty).title, undefined);
});

test('deleted chats close their other tabs; titles refresh after a rename', () => {
  const state = showing(three(), 'b');
  assert.deepEqual(ids(forgetChats(state, new Set(['a', 'b', 'c']))), ['b'], 'the shown tab stays; the page empties it as it leaves the chat');
  const renamed = renameTabs(state, id => id === 'b' ? 'Bravo 2' : undefined);
  assert.equal(tabFor(renamed, 'b').title, 'Bravo 2');
  assert.equal(renameTabs(renamed, id => id === 'b' ? 'Bravo 2' : undefined), renamed);
});

test('tabs and the shown one persist, and damaged storage is ignored', () => {
  const store = storage(), saved = showing(addTab(three()), 'a');
  assert.equal(writeTabs(saved, store), true);
  assert.deepEqual(readTabs(store), saved);
  assert.equal(readTabs(storage()), null);
  for (const bad of ['not json', '{"tabs":[]}', '{"tabs":[{"id":3}]}', '{"tabs":[{"id":"x","threadId":5}]}']) {
    const broken = storage(); broken.setItem('elpis-chat-tabs-v1', bad);
    assert.equal(readTabs(broken), null, bad);
  }
  const partial = storage(); partial.setItem('elpis-chat-tabs-v1', JSON.stringify({ tabs: [{ id: 'x', threadId: 'q' }, { id: 'x', threadId: 'dup' }, { nope: 1 }], activeId: 'missing' }));
  assert.deepEqual(readTabs(partial), { tabs: [{ id: 'x', threadId: 'q' }], activeId: 'x' });
});
