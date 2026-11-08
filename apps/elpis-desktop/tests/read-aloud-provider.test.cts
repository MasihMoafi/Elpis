const { compileFunction }: typeof import('node:vm') = require('node:vm');
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const ts = require('typescript');

type AudioContext = { play(id: string, text: string): void; error: { message: string } | null };
function fixture() {
  const slots: unknown[] = [], effects: (() => void)[] = [], listeners = new Map<string, () => void>(); let cursor = 0, available = true;
  const hooks = { ...React,
    useState(initial: unknown) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], (next: unknown) => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useRef(initial: unknown) { const key = cursor++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
    useEffect(effect: () => void) { cursor++; effects.push(effect); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../components/read-aloud.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { ReadAloud(options: { enabled: boolean; children: null }): { props: { value: AudioContext | null } } } };
  const imports = (id: string): unknown => id === './read-aloud-text.ts' ? helpers() : id === 'react' ? hooks : id === '@/lib/api' ? { sessionReady: async () => {}, api: async () => ({ available }) }
    : id === '@/lib/remote-audio' ? { playRemoteAudio: () => ({}) }
    : id === '@/lib/love-spot-audio' ? { READ_ALOUD_AUDIO: { available: false } }
    : id === '@/lib/error-text.mts' ? { errorText: (error: { message?: string } | null, fallback: string) => error?.message || fallback } : require(id);
  const helpers = () => {
    const text = fs.readFileSync(path.join(__dirname, '../components/read-aloud-text.ts'), 'utf8');
    const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const helper = { exports: {} };
    compileFunction(compiled, ['require', 'module', 'exports'])(imports, helper, helper.exports);
    return helper.exports;
  };
  compileFunction(code, ['require', 'module', 'exports'])(imports, module, module.exports);
  const previousWindow = global.window;
  Reflect.set(global, 'window', { addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) });
  return {
    render() { cursor = 0; return module.exports.ReadAloud({ enabled: true, children: null }); },
    start() { for (const effect of effects.splice(0)) effect(); },
    setAvailable(value: boolean) { available = value; },
    notify() { listeners.get('elpis-read-aloud-settings')?.(); },
    dispose() { global.window = previousWindow; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('read aloud displays the API error instead of a generic message or retry', async () => {
  const view = fixture(), originalFetch = global.fetch, originalAudio = global.Audio, requests: (RequestInfo | URL)[] = [];
  Reflect.set(global, 'Audio', class { pause() {} removeAttribute() {} });
  Reflect.set(global, 'fetch', async (url: RequestInfo | URL) => { requests.push(url); return { ok: false, json: async () => ({ error: 'Read aloud API rejected the provider key.' }) }; });
  try {
    view.render(); view.start(); await tick();
    const value = view.render().props.value; assert.ok(value); value.play('reply', 'Hello.'); await tick(); await tick();
    const error = view.render().props.value?.error; assert.ok(error); assert.match(error.message, /rejected the provider key/);
    assert.deepEqual(requests, ['/api/read-aloud']);
  } finally { view.dispose(); global.fetch = originalFetch; global.Audio = originalAudio; }
});

test('read aloud refreshes availability after its source is changed in settings', async () => {
  const view = fixture();
  try {
    view.render(); view.start(); await tick(); assert.ok(view.render().props.value);
    view.setAvailable(false); view.notify(); await tick();
    assert.equal(view.render().props.value, null);
  } finally { view.dispose(); }
});

test('read aloud plays an MP3 response through the shared audio player', async () => {
  const view = fixture(), originalFetch = global.fetch, originalAudio = global.Audio;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, blobs: string[] = [], played: string[] = [];
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); blobs.push(blob.type); return 'blob:fixture'; };
  URL.revokeObjectURL = () => {};
  Reflect.set(global, 'Audio', class { declare src: string; declare onended: (() => void) | undefined; pause() {} removeAttribute() {} play() { played.push(this.src); queueMicrotask(() => this.onended?.()); return Promise.resolve(); } });
  global.fetch = async () => new Response(Buffer.from('ID3-test-mp3'), { headers: { 'content-type': 'audio/mpeg' } });
  try {
    view.render(); view.start(); await tick(); const value = view.render().props.value; assert.ok(value); value.play('reply', 'Hello.'); await tick(); await tick();
    assert.deepEqual(blobs, ['audio/mpeg']);
    assert.deepEqual(played, ['blob:fixture']);
    assert.equal(view.render().props.value?.error, null);
  } finally { view.dispose(); global.fetch = originalFetch; global.Audio = originalAudio; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});
