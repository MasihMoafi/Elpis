const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const React = require('react');

// Exercise source and hook lifecycles without a renderer build, as in model-picker-configure.test.mjs.
function fixture() {
  const root = path.resolve(__dirname, '..'), cache = new Map(), slots = [], pending = [];
  let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, previous = slots[key]; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) { slots[key] = deps; pending.push(effect); } },
  };
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const local = createRequire(file);
    const imports = id => {
      if (id === 'react') return hooks;
      if (!id.startsWith('@/') && !id.startsWith('.')) return local(id);
      const base = id.startsWith('@/') ? path.join(root, id.slice(2)) : path.resolve(path.dirname(file), id);
      const target = [base, base + '.ts', base + '.tsx'].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      return target ? /\.tsx?$/.test(target) ? load(target) : local(target) : local(id);
    };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', code)(imports, module, module.exports);
    return module.exports;
  }
  return { load, render(run) { cursor = 0; return run(); }, effects() { for (const effect of pending.splice(0)) effect(); } };
}

function storage(t, initial = {}) {
  const previous = globalThis.window, values = new Map(Object.entries(initial));
  globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  return values;
}
function mounted() {
  const view = fixture(), { useBookmarks } = view.load('lib/use-sidebar-state.ts');
  assert.equal(typeof useBookmarks, 'function', 'sidebar state must expose bookmarks');
  view.render(useBookmarks); view.effects();
  return { current: () => view.render(useBookmarks) };
}
function elements(node) { return React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : Array.isArray(node) ? node.flatMap(elements) : []; }

test('B1: bookmarks toggle on and off, survive remount, and leave pins and other marks alone', t => {
  const values = storage(t, { 'elpis-pinned-chats-v1': '["pinned"]' });
  const view = mounted();
  assert.deepEqual(view.current().bookmarks, []);
  view.current().toggleBookmarked('first');
  view.current().toggleBookmarked('second');
  assert.deepEqual(view.current().bookmarks, ['second', 'first']);
  assert.equal(values.get('elpis-bookmarked-chats-v1'), '["second","first"]');
  const reopened = mounted();
  assert.deepEqual(reopened.current().bookmarks, ['second', 'first']);
  reopened.current().toggleBookmarked('first');
  assert.deepEqual(mounted().current().bookmarks, ['second']);
  assert.equal(values.get('elpis-pinned-chats-v1'), '["pinned"]');
  const { readPins, savePins } = fixture().load('lib/pins.ts');
  assert.deepEqual(readPins(), ['pinned']);
  savePins(['other-pin']);
  assert.deepEqual(mounted().current().bookmarks, ['second'], 'pinning must not change bookmarks');
});

test('B1: unreadable bookmark storage is empty and non-string entries cannot mark a chat', t => {
  const values = storage(t), { readBookmarks, saveBookmarks } = fixture().load('lib/bookmarks.ts');
  for (const raw of [undefined, '{broken', 'null', '{}', '42']) {
    if (raw === undefined) values.delete('elpis-bookmarked-chats-v1'); else values.set('elpis-bookmarked-chats-v1', raw);
    assert.deepEqual(readBookmarks(), []);
  }
  values.set('elpis-bookmarked-chats-v1', '["chat",null,9,{},false]');
  assert.deepEqual(readBookmarks(), ['chat']);
  saveBookmarks([]);
  assert.deepEqual(readBookmarks(), []);
});

test('B1: the shared chat menus toggle Bookmark and Remove bookmark without pinning', t => {
  storage(t);
  const state = mounted(), view = fixture(), { ThreadActions } = view.load('components/thread-actions.tsx');
  const thread = { id: 'chat', name: 'My chat' };
  const props = { thread, pinned: true, onPin() { assert.fail('bookmarking must not pin'); }, onBookmark(chat) { assert.equal(chat, thread); state.current().toggleBookmarked(chat.id); }, area: React.createElement('div'), children: menu => menu };
  const menus = () => elements(view.render(() => ThreadActions({ ...props, bookmarked: state.current().bookmarks.includes(thread.id) }))).filter(element => Array.isArray(element.props.actions));
  let actions = menus();
  assert.equal(actions.length, 2, 'right-click and the ellipsis must both offer the action');
  const bookmark = actions[0].props.actions.find(action => action.label === 'Bookmark');
  assert.ok(bookmark, 'Bookmark must be available');
  bookmark.run();
  assert.deepEqual(state.current().bookmarks, ['chat']);
  actions = menus();
  assert.ok(actions.every(menu => menu.props.actions.some(action => action.label === 'Remove bookmark')));
  actions[1].props.actions.find(action => action.label === 'Remove bookmark').run();
  assert.deepEqual(state.current().bookmarks, []);
  const absent = elements(view.render(() => ThreadActions({ ...props, onBookmark: undefined }))).filter(element => Array.isArray(element.props.actions));
  assert.ok(absent.every(menu => !menu.props.actions.some(action => /bookmark/i.test(action.label))), 'no bookmark action without a handler');
});
