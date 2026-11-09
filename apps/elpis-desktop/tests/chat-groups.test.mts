import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS_KEY, chatSelectionRoots, chatSubtree, emptyGroups, groupSections, holdChatOrder, isDefaultView, staysWithChatList, moveChats, placeChat, prioritizeChats, putChatsUnder, readGroups, sidebarParents, sortChats, writeGroups } from '../lib/chat-groups.ts';
import type { ChatGroups } from '../lib/chat-groups.ts';

const storage = (initial: Record<string, string> = {}) => { const values = new Map(Object.entries(initial)); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }; };
const chat = (id: string, name: string, createdAt?: number) => ({ id, name, ...(createdAt === undefined ? {} : { createdAt }) });
const nameOf = (thread: { id: string; name?: string }) => thread.name as string;
const ids = (list: { id: string }[]) => list.map(thread => thread.id);

test('recursive placements override native parents and survive storage, including explicit roots', () => {
  const native = { worker: 'root', grandchild: 'worker', leaf: 'grandchild', orphan: 'not-loaded' };
  const known = ['root', 'worker', 'grandchild', 'leaf', 'other', 'orphan'];
  const tree = (state: ChatGroups) => sidebarParents(known, state, native);
  let state = putChatsUnder(emptyGroups(), ['grandchild'], null, native);
  assert.deepEqual(tree(state), { worker: 'root', leaf: 'grandchild' });
  state = putChatsUnder(state, ['grandchild'], 'other', native);
  const store = storage(); assert.equal(writeGroups(state, store), true);
  const restored = readGroups(store);
  assert.deepEqual(restored, state);
  assert.deepEqual(chatSubtree(['other'], tree(restored)), ['other', 'grandchild', 'leaf']);
  assert.deepEqual(chatSelectionRoots(['grandchild', 'leaf'], tree(restored)), ['grandchild']);
  const detached = putChatsUnder(restored, ['worker', 'leaf'], null, native);
  assert.equal(tree(detached).worker, undefined); assert.equal(tree(detached).leaf, undefined);
  assert.ok(detached.parents); assert.equal(detached.parents.grandchild, 'other', 'unselected placements remain intact');
});

test('mixed native/display cycles are refused atomically and corrupt saved cycles leave every chat reachable', () => {
  const native = { child: 'root', grandchild: 'child' }, state = emptyGroups();
  for (const selected of [['root'], ['root', 'child'], ['other', 'root']]) assert.equal(putChatsUnder(state, selected, 'grandchild', native), state);
  const nested = putChatsUnder(state, ['other'], 'grandchild', native);
  assert.equal(putChatsUnder(nested, ['child'], 'other', native), nested);
  const saved = { ...emptyGroups(), parents: { a: 'b', b: 'a', self: 'self', child: 'root', outside: 'not-loaded', root: null }, branches: { a: true, b: 'bad' } };
  const restored = readGroups(storage({ [GROUPS_KEY]: JSON.stringify(saved) }));
  assert.ok(restored.parents);
  assert.equal(restored.parents.a, null); assert.equal(restored.parents.b, null); assert.equal(restored.parents.self, null);
  assert.equal(restored.parents.outside, 'not-loaded', 'unloaded relationships are kept for later pages');
  assert.equal('branches' in restored, false, 'old open-state data cannot reopen chats after restart');
  assert.deepEqual(sidebarParents(['root', 'child', 'a', 'b', 'self', 'outside'], restored, native), { child: 'root' });
  assert.deepEqual(sidebarParents(['root', 'child', 'grandchild'], { ...state, parents: { root: 'grandchild' } }, native), {}, 'saved and native edges cannot jointly hide a cycle');
  const cyclicNative = { a: 'b', b: 'a', leaf: 'a', c: null };
  const repaired = putChatsUnder(state, ['a', 'b'], 'c', cyclicNative);
  assert.deepEqual(sidebarParents(['a', 'b', 'leaf', 'c'], repaired, cyclicNative), { a: 'c', b: 'c', leaf: 'a' }, 'both visible roots of a malformed native cycle can move together');
  assert.deepEqual(chatSubtree(['c'], sidebarParents(['a', 'b', 'leaf', 'c'], repaired, cyclicNative)), ['c', 'a', 'b', 'leaf']);
});

test('A102: recency uses bridge timestamps after merges, with stable ties and no timestamps', () => {
  const list = [{ id: 'old', updatedAt: 10 }, { id: 'new', updatedAt: 30 }, { id: 'run', updatedAt: 100, recencyAt: 5 }, { id: 'tie', updatedAt: 30 }, { id: 'unknown' }];
  assert.deepEqual(ids(sortChats(list, 'recency', nameOf)), ['new', 'tie', 'old', 'run', 'unknown']);
  assert.deepEqual(ids(sortChats([chat('b', 'B'), chat('a', 'A')], 'recency', nameOf)), ['b', 'a']);
  assert.deepEqual(ids(list), ['old', 'new', 'run', 'tie', 'unknown']);
});

test('working chats come first by default, followed by waiting and unread', () => {
  const list = ['working', 'idle', 'unread', 'error', 'waiting', 'unknown', 'unread', 'waiting', 'working'];
  assert.deepEqual(prioritizeChats(list, value => value), ['working', 'working', 'waiting', 'waiting', 'unread', 'unread', 'idle', 'error', 'unknown']);
  assert.deepEqual(prioritizeChats(['idle', 'working'], value => value), ['working', 'idle']);
});

test('A102: holding positions keeps fresh statuses, appends arrivals, removes missing chats, and releases to live order', () => {
  const list = [{ id: 'c', status: 'unread' }, { id: 'a', status: 'waiting' }, { id: 'new' }];
  assert.deepEqual(ids(holdChatOrder(list, ['a', 'gone', 'c'])), ['a', 'c', 'new']);
  assert.equal(holdChatOrder(list, ['a', 'c'])[0], list[1], 'current objects, not stale row state');
  assert.equal(holdChatOrder(list, null), list);
  assert.deepEqual(holdChatOrder([], ['gone']), []);
});

test('nothing saved, or something unreadable, is no groups, ungrouped and in last-activity order', () => {
  assert.deepEqual(readGroups(storage()), emptyGroups());
  assert.deepEqual(readGroups(storage({ [GROUPS_KEY]: '{not json' })), emptyGroups());
  assert.deepEqual(readGroups(storage({ [GROUPS_KEY]: '[1,2]' })), emptyGroups());
  assert.deepEqual(emptyGroups(), { groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [] });
  assert.equal(isDefaultView(emptyGroups()), true);
});

// Groups can no longer be created in the app; saved state with groups is built directly.
const addGroup = (state: ChatGroups, name: string, id: string): ChatGroups => ({ ...state, groups: [...state.groups, { id, name }], groupBy: 'custom' });

test('sort: last activity keeps the given order, date created is newest first, name is A to Z; ties keep their order', () => {
  const list = [chat('a', 'beta', 100), chat('b', 'Alpha 10', 300), chat('c', 'alpha 9', undefined), chat('d', 'Gamma', 200), chat('e', 'beta', 300)];
  assert.deepEqual(ids(sortChats(list, 'recency', nameOf)), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids(sortChats(list, 'created', nameOf)), ['b', 'e', 'd', 'a', 'c'], 'a chat without a creation time goes last');
  assert.deepEqual(ids(sortChats(list, 'name', nameOf)), ['c', 'b', 'a', 'e', 'd'], 'case-blind, with numbers in number order');
  assert.deepEqual(ids(list), ['a', 'b', 'c', 'd', 'e'], 'the given list is not changed');
});

test('sections: each group in its order with its chats in list order, then the rest; chats of unknown groups are the rest', () => {
  let state = addGroup(addGroup(emptyGroups(), 'Work', 'g1'), 'Home', 'g2');
  state = moveChats(state, ['c', 'a'], 'g2');
  state = moveChats(state, ['d'], 'g1');
  state = { ...state, members: { ...state.members, e: 'gone' } };
  const list = [chat('a', 'A'), chat('b', 'B'), chat('c', 'C'), chat('d', 'D'), chat('e', 'E')];
  const sections = groupSections(list, state);
  assert.deepEqual(sections.groups.map(section => [section.group.name, ids(section.chats)]), [['Work', ['d']], ['Home', ['a', 'c']]]);
  assert.deepEqual(ids(sections.ungrouped), ['b', 'e']);
  const empty = groupSections([chat('b', 'B')], state);
  assert.deepEqual(empty.groups.map(section => [section.group.name, ids(section.chats)]), [['Work', []], ['Home', []]], 'an empty group is still a section');
});

test('manual order: unplaced chats first, then the saved order; a stale id is ignored', () => {
  const list = [chat('n1', 'New1'), chat('a', 'A'), chat('b', 'B'), chat('c', 'C')];
  assert.deepEqual(ids(sortChats(list, 'manual', nameOf, ['c', 'gone', 'a', 'b'])), ['n1', 'c', 'a', 'b']);
  assert.deepEqual(ids(sortChats(list, 'manual', nameOf)), ['n1', 'a', 'b', 'c'], 'no saved order keeps the given order');
});

test('placing a chat saves the order, makes the list manual, keeps unlisted placed chats, and moves it between groups', () => {
  const start = moveChats(addGroup({ ...emptyGroups(), order: ['old'] }, 'Work', 'g1'), ['a'], 'g1');
  const moved = placeChat(start, ['b', 'a', 'c'], 'b', undefined);
  assert.deepEqual([moved.sortBy, moved.order, moved.members], ['manual', ['b', 'a', 'c', 'old'], { a: 'g1' }]);
  assert.equal(placeChat(start, ['a', 'b'], 'b', 'g1').members.b, 'g1');
  assert.equal('a' in placeChat(start, ['a', 'b'], 'a', null).members, false);
  assert.equal(placeChat(start, ['a'], 'a', 'nope').members.a, 'g1', 'an unknown group moves nothing');
  const store = storage(); writeGroups(moved, store);
  assert.deepEqual(readGroups(store).order, ['b', 'a', 'c', 'old'], 'the order survives a reload');
  assert.equal(readGroups(store).sortBy, 'manual');
});

test('the held chat order survives the pointer reaching a row tooltip or menu, and only those', () => {
  const at = (role: string) => ({ closest: (selector: string) => selector.includes(`[role="${role}"]`) ? {} : null });
  for (const role of ['tooltip', 'menu', 'dialog', 'alertdialog']) assert.equal(staysWithChatList(at(role)), true, role);
  for (const target of [at('main'), { closest: () => null }, null, undefined, {}]) assert.equal(staysWithChatList(target), false);
});

