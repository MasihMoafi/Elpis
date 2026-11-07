import type { ReactElement, ReactNode } from 'react';
import type { Thread } from '../lib/api.ts';

type MenuAction = { label: string; run(): void };
type ElementProps = { children?: ReactNode; actions?: MenuAction[] };
type ThreadActions = (props: { thread: Thread; pinned: boolean; bookmarked?: boolean; onPin(): void; onBookmark: ((thread: Thread) => void) | undefined; area: ReactElement; children(menu: ReactNode): ReactNode }) => ReactNode;
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createRequire }: typeof import('node:module') = require('node:module');
const ts: typeof import('typescript') = require('typescript');
const React: typeof import('react') = require('react');

// Exercise source and hook lifecycles without a renderer build, as in model-picker-configure.test.mts.
function fixture() {
  const root = path.resolve(__dirname, '..'), cache = new Map<string, { exports: unknown }>(), slots: unknown[] = [], pending: (() => void)[] = [];
  let cursor = 0;
  const hooks = { ...React,
    useState(initial: unknown) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], (next: unknown) => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    // Shared stores (preferences, follow-ups) read their current snapshot; nothing here subscribes.
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
    useEffect(effect: () => void, deps: unknown[]) { const key = cursor++, previous = slots[key] as unknown[] | undefined; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) { slots[key] = deps; pending.push(effect); } },
  };
  function load<T>(relative: string): T {
    const file = path.resolve(root, relative);
    const cached = cache.get(file); if (cached) return cached.exports as T;
    const module: { exports: unknown } = { exports: {} }; cache.set(file, module);
    const local = createRequire(file);
    const imports = (id: string): unknown => {
      if (id === 'react') return hooks;
      if (!id.startsWith('@/') && !id.startsWith('.')) return local(id);
      const base = id.startsWith('@/') ? path.join(root, id.slice(2)) : path.resolve(path.dirname(file), id);
      const target = [base, base + '.ts', base + '.tsx'].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      return target ? /\.tsx?$/.test(target) ? load(target) : local(target) : local(id);
    };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', code)(imports, module, module.exports);
    return module.exports as T;
  }
  return { load, render<T>(run: () => T): T { cursor = 0; return run(); }, effects() { for (const effect of pending.splice(0)) effect(); } };
}

function storage(t: import('node:test').TestContext, initial: Record<string, string> = {}) {
  const previous = globalThis.window, values = new Map(Object.entries(initial));
  Reflect.set(globalThis, 'window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  t.after(() => { if (previous === undefined) Reflect.deleteProperty(globalThis, 'window'); else Reflect.set(globalThis, 'window', previous); });
  return values;
}
function mounted() {
  const view = fixture(), { useBookmarks } = view.load<Pick<typeof import('../lib/use-sidebar-state.ts'), 'useBookmarks'>>('lib/use-sidebar-state.ts');
  assert.equal(typeof useBookmarks, 'function', 'sidebar state must expose bookmarks');
  view.render(useBookmarks); view.effects();
  return { current: () => view.render(useBookmarks) };
}
function elements(node: ReactNode): ReactElement<ElementProps>[] { return React.isValidElement<ElementProps>(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : Array.isArray(node) ? node.flatMap(elements) : []; }

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
  const { readPins, savePins } = fixture().load<typeof import('../lib/pins.ts')>('lib/pins.ts');
  assert.deepEqual(readPins(), ['pinned']);
  savePins(['other-pin']);
  assert.deepEqual(mounted().current().bookmarks, ['second'], 'pinning must not change bookmarks');
});

test('B1: unreadable bookmark storage is empty and non-string entries cannot mark a chat', t => {
  const values = storage(t), { readBookmarks, saveBookmarks } = fixture().load<typeof import('../lib/bookmarks.ts')>('lib/bookmarks.ts');
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
  const state = mounted(), view = fixture(), { ThreadActions } = view.load<{ ThreadActions: ThreadActions }>('components/thread-actions.tsx');
  const thread = { id: 'chat', name: 'My chat' };
  const props = { thread, pinned: true, onPin() { assert.fail('bookmarking must not pin'); }, onBookmark(chat: Thread) { assert.equal(chat, thread); state.current().toggleBookmarked(chat.id); }, area: React.createElement('div'), children: (menu: ReactNode) => menu };
  const menus = () => elements(view.render(() => ThreadActions({ ...props, bookmarked: state.current().bookmarks.includes(thread.id) }))).filter((element): element is ReactElement<{ actions: MenuAction[] }> => Array.isArray(element.props.actions));
  let actions = menus();
  assert.equal(actions.length, 2, 'right-click and the ellipsis must both offer the action');
  const first = actions[0]; assert.ok(first); const bookmark = first.props.actions.find(action => action.label === 'Bookmark');
  assert.ok(bookmark, 'Bookmark must be available');
  bookmark.run();
  assert.deepEqual(state.current().bookmarks, ['chat']);
  actions = menus();
  assert.ok(actions.every(menu => menu.props.actions.some(action => action.label === 'Remove bookmark')));
  const second = actions[1]; assert.ok(second); const remove = second.props.actions.find(action => action.label === 'Remove bookmark'); assert.ok(remove); remove.run();
  assert.deepEqual(state.current().bookmarks, []);
  const absent = elements(view.render(() => ThreadActions({ ...props, onBookmark: undefined }))).filter((element): element is ReactElement<{ actions: MenuAction[] }> => Array.isArray(element.props.actions));
  assert.ok(absent.every(menu => !menu.props.actions.some(action => /bookmark/i.test(action.label))), 'no bookmark action without a handler');
});
