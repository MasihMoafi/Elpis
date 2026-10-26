import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS_KEY, addGroup, chatSelectionRoots, chatSubtree, deleteGroup, emptyGroups, groupNameProblem, groupSections, holdChatOrder, isDefaultView, moveChats, placeChat, prioritizeChats, putChatsUnder, readGroups, renameGroup, sidebarParents, sortChats, toggleCollapsed, writeGroups } from '../lib/chat-groups.ts';

const storage = (initial = {}) => { const values = new Map(Object.entries(initial)); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
const chat = (id, name, createdAt) => ({ id, name, ...(createdAt === undefined ? {} : { createdAt }) });
const nameOf = thread => thread.name;
const ids = list => list.map(thread => thread.id);

test('recursive placements override native parents and survive storage, including explicit roots and folds', () => {
  const native = { worker: 'root', grandchild: 'worker', leaf: 'grandchild', orphan: 'not-loaded' };
  const known = ['root', 'worker', 'grandchild', 'leaf', 'other', 'orphan'];
  const tree = state => sidebarParents(known, state, native);
  let state = putChatsUnder(emptyGroups(), ['grandchild'], null, native);
  assert.deepEqual(tree(state), { worker: 'root', leaf: 'grandchild' });
  state = putChatsUnder(state, ['grandchild'], 'other', native);
  state = { ...state, branches: { root: true, worker: false, other: true } };
  const store = storage(); assert.equal(writeGroups(state, store), true);
  const restored = readGroups(store);
  assert.deepEqual(restored, state);
  assert.deepEqual(chatSubtree(['other'], tree(restored)), ['other', 'grandchild', 'leaf']);
  assert.deepEqual(chatSelectionRoots(['grandchild', 'leaf'], tree(restored)), ['grandchild']);
  const detached = putChatsUnder(restored, ['worker', 'leaf'], null, native);
  assert.equal(tree(detached).worker, undefined); assert.equal(tree(detached).leaf, undefined);
  assert.equal(detached.parents.grandchild, 'other', 'unselected placements remain intact');
});

test('mixed native/display cycles are refused atomically and corrupt saved cycles leave every chat reachable', () => {
  const native = { child: 'root', grandchild: 'child' }, state = emptyGroups();
  for (const selected of [['root'], ['root', 'child'], ['other', 'root']]) assert.equal(putChatsUnder(state, selected, 'grandchild', native), state);
  const nested = putChatsUnder(state, ['other'], 'grandchild', native);
  assert.equal(putChatsUnder(nested, ['child'], 'other', native), nested);
  const saved = { ...emptyGroups(), parents: { a: 'b', b: 'a', self: 'self', child: 'root', outside: 'not-loaded', root: null }, branches: { a: true, b: 'bad' } };
  const restored = readGroups(storage({ [GROUPS_KEY]: JSON.stringify(saved) }));
  assert.equal(restored.parents.a, null); assert.equal(restored.parents.b, null); assert.equal(restored.parents.self, null);
  assert.equal(restored.parents.outside, 'not-loaded', 'unloaded relationships are kept for later pages');
  assert.deepEqual(restored.branches, { a: true });
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

test('A102: waiting, then running, then unread; errors, idle and unknown have no priority', () => {
  const list = ['working', 'idle', 'unread', 'error', 'waiting', 'unknown', 'unread', 'waiting', 'working'];
  assert.deepEqual(prioritizeChats(list, value => value), ['waiting', 'waiting', 'working', 'working', 'unread', 'unread', 'idle', 'error', 'unknown']);
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

test('a saved state keeps only what it can use: named groups once each, members and collapsed of known groups, known choices', () => {
  const saved = { groups: [{ id: 'g1', name: '  Work  ' }, { id: 'g1', name: 'Again' }, { id: 'g2', name: '' }, { id: 3, name: 'Bad id' }, { id: 'g3', name: 'Home' }],
    members: { a: 'g1', b: 'gone', c: 'g3', d: 7 }, groupBy: 'custom', sortBy: 'name', collapsed: ['g3', 'gone', 'g3'] };
  const state = readGroups(storage({ [GROUPS_KEY]: JSON.stringify(saved) }));
  assert.deepEqual(state, { groups: [{ id: 'g1', name: 'Work' }, { id: 'g3', name: 'Home' }], members: { a: 'g1', c: 'g3' }, groupBy: 'custom', sortBy: 'name', collapsed: ['g3'], order: [] });
  assert.equal(readGroups(storage({ [GROUPS_KEY]: JSON.stringify({ ...saved, groupBy: 'date', sortBy: 'size' }) })).groupBy, 'none', 'an unknown grouping is the default');
  assert.equal(readGroups(storage({ [GROUPS_KEY]: JSON.stringify({ ...saved, sortBy: 'size' }) })).sortBy, 'recency', 'an unknown order is the default');
});

test('what is written is read back the same', () => {
  const store = storage();
  const state = moveChats(addGroup(emptyGroups(), 'Work', 'g1'), ['a', 'b'], 'g1');
  assert.equal(writeGroups(state, store), true);
  assert.deepEqual(readGroups(store), state);
  assert.equal(writeGroups(state, { getItem: () => null, setItem: () => { throw Error('full'); } }), false, 'a refused write reports false');
});

test('a new group comes last, trimmed, and switches the list to custom groups; a name must be new and not empty', () => {
  const one = addGroup(emptyGroups(), '  Work ', 'g1');
  assert.deepEqual(one.groups, [{ id: 'g1', name: 'Work' }]);
  assert.equal(one.groupBy, 'custom');
  assert.equal(isDefaultView(one), false);
  const two = addGroup(one, 'Home', 'g2');
  assert.deepEqual(two.groups.map(group => group.name), ['Work', 'Home']);
  assert.equal(groupNameProblem(two, '   '), 'Name the group.');
  assert.equal(groupNameProblem(two, ' work '), 'A group with this name already exists.');
  assert.equal(groupNameProblem(two, 'Work', 'g1'), null, 'a group may keep its own name when renamed');
  assert.equal(groupNameProblem(two, 'Errands'), null);
  assert.equal(groupNameProblem(two, 'x'.repeat(61)), 'Use 60 characters or fewer.');
});

test('chats move into a group, to another, and out of it; renaming keeps them; deleting ungroups them and forgets its collapse', () => {
  let state = addGroup(addGroup(emptyGroups(), 'Work', 'g1'), 'Home', 'g2');
  state = moveChats(state, ['a', 'b'], 'g1');
  assert.deepEqual(state.members, { a: 'g1', b: 'g1' });
  state = moveChats(state, ['b'], 'g2');
  assert.deepEqual(state.members, { a: 'g1', b: 'g2' });
  state = moveChats(state, ['a'], null);
  assert.deepEqual(state.members, { b: 'g2' });
  assert.deepEqual(moveChats(state, ['c'], 'missing').members, { b: 'g2' }, 'an unknown group moves nothing');
  state = renameGroup(state, 'g2', '  House ');
  assert.deepEqual(state.groups, [{ id: 'g1', name: 'Work' }, { id: 'g2', name: 'House' }]);
  assert.deepEqual(state.members, { b: 'g2' });
  state = toggleCollapsed(state, 'g2');
  assert.deepEqual(state.collapsed, ['g2']);
  assert.deepEqual(toggleCollapsed(state, 'g2').collapsed, []);
  state = deleteGroup(state, 'g2');
  assert.deepEqual(state.groups, [{ id: 'g1', name: 'Work' }]);
  assert.deepEqual(state.members, {});
  assert.deepEqual(state.collapsed, []);
});

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
