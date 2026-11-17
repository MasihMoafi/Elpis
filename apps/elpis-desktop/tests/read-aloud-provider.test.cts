const { compileFunction }: typeof import('node:vm') = require('node:vm');
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const ts = require('typescript');

type AudioContext = { play(id: string, text: string): Promise<void>; stop(): void; error: { message: string } | null };
type StreamPlayer = (audio: HTMLAudioElement, url: string, signal: AbortSignal, response?: Promise<Response>) => Promise<void>;
function fixture(streamPlayer?: StreamPlayer) {
  const slots: unknown[] = [], effects: (() => void)[] = [], listeners = new Map<string, () => void>(); let cursor = 0, available = true;
  const hooks = { ...React,
    useState(initial: unknown) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], (next: unknown) => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useRef(initial: unknown) { const key = cursor++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
    useEffect(effect: () => void) { cursor++; effects.push(effect); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../components/read-aloud.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { ReadAloud(options: { enabled: boolean; children: null }): { props: { value: AudioContext | null } } } };
  let ticket = 0;
  const imports = (id: string): unknown => id === './read-aloud-text.ts' ? helpers() : id === 'react' ? hooks : id === '@/lib/api' ? {
    sessionReady: async () => {}, api: async (url: string) => url.endsWith('/prepare')
      ? { url: `/api/read-aloud/audio/11111111-1111-4111-8111-${String(++ticket).padStart(12, '0')}` }
      : { available, streaming: !!streamPlayer },
  }
    : id === '@/lib/remote-audio' ? { playRemoteAudio: () => ({}) }
    : id === '@/lib/streaming-audio' ? { playStreamingAudio: streamPlayer ?? (() => { throw Error('This fixture uses the nonstreaming provider'); }) }
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
    const value = view.render().props.value; assert.ok(value); void value.play('reply', 'Hello.'); await tick(); await tick();
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
    view.render(); view.start(); await tick(); const value = view.render().props.value; assert.ok(value); void value.play('reply', 'Hello.'); await tick(); await tick();
    assert.deepEqual(blobs, ['audio/mpeg']);
    assert.deepEqual(played, ['blob:fixture']);
    assert.equal(view.render().props.value?.error, null);
  } finally { view.dispose(); global.fetch = originalFetch; global.Audio = originalAudio; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});

test('streaming generates a bounded next queue before playback ends and Stop aborts every fetch', async () => {
  const originalFetch = global.fetch, originalAudio = global.Audio;
  const requests: AbortSignal[] = [], consumed: string[] = [];
  const view = fixture(async (_audio, url, signal, response) => {
    assert.ok(response, 'playback reuses the request started during preparation');
    assert.equal((await response).status, 200); consumed.push(url);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  Reflect.set(global, 'Audio', class { pause() {} removeAttribute() {} });
  global.fetch = async (_url, options) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    requests.push(options!.signal!); return new Response('audio');
  };
  try {
    view.render(); view.start(); await tick();
    const value = view.render().props.value!;
    const done = value.play('reply', Array.from({ length: 6 }, (_, i) => `Sentence ${i} ${'word '.repeat(55)}.`).join(' '));
    await tick(); await tick();
    assert.equal(consumed.length, 1, 'only the first piece is playing');
    assert.equal(requests.length, 3, 'the next two pieces are already generating, without fetching the whole reply');
    value.stop(); await done;
    assert.ok(requests.every(signal => signal.aborted), 'Stop cancels playing and prefetched synthesis');
    assert.equal(view.render().props.value?.error, null);
  } finally { view.render().props.value?.stop(); view.dispose(); global.fetch = originalFetch; global.Audio = originalAudio; }
});

test('a failed prefetched piece reports its error when reached and cleans up the reading', async () => {
  const originalFetch = global.fetch, originalAudio = global.Audio;
  let fetched = 0, played = 0, release = () => {};
  const view = fixture(async (_audio, _url, _signal, response) => {
    await response;
    played++;
    if (played === 1) await new Promise<void>(resolve => { release = resolve; });
  });
  Reflect.set(global, 'Audio', class { pause() {} removeAttribute() {} });
  global.fetch = async (_url, options) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (++fetched === 2) throw new Error('Local synthesis interrupted.');
    return new Response('audio');
  };
  try {
    view.render(); view.start(); await tick();
    const value = view.render().props.value!;
    const done = value.play('reply', `First ${'word '.repeat(55)}. Second ${'word '.repeat(55)}.`);
    await tick(); await tick();
    assert.equal(fetched, 2); assert.equal(played, 1);
    release(); await done;
    assert.match(view.render().props.value?.error?.message ?? '', /Local synthesis interrupted/);
  } finally { release(); view.render().props.value?.stop(); view.dispose(); global.fetch = originalFetch; global.Audio = originalAudio; }
});
