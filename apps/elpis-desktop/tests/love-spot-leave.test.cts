const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileFunction } = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { act } = React;
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');

test('leaving an open edit never sends it on leave or return, but completion sends it', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window; global.document = dom.window.document;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map<string, string>(), posts: string[] = [];
  const mocks: Record<string, unknown> = {
    '@/lib/api': { api: async (_url: string, body: { text: string }) => { if (body) posts.push(body.text); return {}; } },
    '@/lib/projects': { appStorage: () => ({ getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) }) },
    '@/lib/matilda': { PROTOCOL: 'persona', savedPersona: () => 'persona', keepPersona: async () => {} },
    '@/lib/preferences': { usePreferences: () => ({}) },
    '@/lib/custom-characters': { useCustomCharacters: () => ({ characters: [] }) },
    '@/lib/theme-characters': { selectedBoardPortrait: async () => undefined },
    '@/lib/error-text.mts': { errorText: String },
  };
  const file = path.join(__dirname, '../components/love-spot-matilda.tsx');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as { useMatilda: (options: { context: string; ready: () => boolean; enabled: () => boolean;
    told: (ids: Set<string>) => string; drawingOnly: () => boolean; send: (value: string) => Promise<string>;
    onError: (error: string) => void }) => { notice: (ids: string[], done: boolean, active?: string) => void } } };
  compileFunction(code, ['require', 'exports', 'module'])((id: string) => mocks[id] || (id.startsWith('@/components/') ? {} : require(id)), module.exports, module);
  const { useMatilda } = module.exports;
  let hook!: ReturnType<typeof useMatilda>, editing = true, text = 'unfinished', send = async (value: string) => { posts.push(value); return 'sent'; };
  function Board() {
    hook = useMatilda({ context: 'page', ready: () => !editing, enabled: () => true, told: ids => ids.size ? text : '', drawingOnly: () => false,
      send: value => send(value), onError: error => { throw Error(error); } });
    return null;
  }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(Board)));
    await act(async () => hook.notice(['note'], false, 'note'));
    await act(async () => root.unmount());
    assert.deepEqual(posts, [], 'unfinished text must not be sent when leaving');
    editing = false;
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(Board)));
    await act(async () => { await pause(450); });
    assert.deepEqual(posts, [], 'returning must not send the abandoned edit');
    text = 'finished thought';
    editing = true;
    await act(async () => hook.notice([], false, 'note'));
    editing = false;
    await act(async () => hook.notice([], true, undefined));
    await act(async () => { await pause(100); });
    assert.deepEqual(posts, ['finished thought'], 'a completed note is sent');
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(Board)));
    text = 'completed before leaving';
    await act(async () => hook.notice(['second'], true));
    await act(async () => root.unmount());
    assert.deepEqual(posts, ['finished thought', 'completed before leaving'], 'a completed note is sent on leave');

    let release!: (value: string) => void;
    send = () => new Promise<string>(resolve => { release = resolve; });
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(Board)));
    text = 'being handed over';
    await act(async () => { hook.notice(['third'], true); await pause(50); });
    assert.equal(typeof release, 'function', 'the handover started');
    editing = true;
    await act(async () => hook.notice(['third'], false, 'third'));
    await act(async () => root.unmount());
    await act(async () => release('stale'));
    assert.deepEqual(posts, ['finished thought', 'completed before leaving'], 'a stale in-flight handover cannot send an open edit');
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
