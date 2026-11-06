const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const ts = require('typescript');

function fixture() {
  const slots = [], effects = [], listeners = new Map(); let cursor = 0, available = true;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useRef(initial) { const key = cursor++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
    useEffect(effect) { cursor++; effects.push(effect); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../components/read-aloud.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const imports = id => id === 'react' ? hooks : id === '@/lib/api' ? { sessionReady: async () => {}, api: async () => ({ available }) }
    : id === '@/lib/love-spot-audio' ? { READ_ALOUD_AUDIO: { available: false } }
    : id === '@/lib/error-text.mts' ? { errorText: (error, fallback) => error?.message || fallback } : require(id);
  new Function('require', 'module', 'exports', code)(imports, module, module.exports);
  const previousWindow = global.window;
  global.window = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  return {
    render() { cursor = 0; return module.exports.ReadAloud({ enabled: true, children: null }); },
    start() { for (const effect of effects.splice(0)) effect(); },
    setAvailable(value) { available = value; },
    notify() { listeners.get('elpis-read-aloud-settings')?.(); },
    dispose() { global.window = previousWindow; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('read aloud displays the API error instead of a generic message or retry', async () => {
  const view = fixture(), originalFetch = global.fetch, originalAudio = global.Audio, requests = [];
  global.Audio = class { pause() {} removeAttribute() {} };
  global.fetch = async url => { requests.push(url); return { ok: false, json: async () => ({ error: 'Read aloud API rejected the provider key.' }) }; };
  try {
    view.render(); view.start(); await tick();
    view.render().props.value.play('reply', 'Hello.'); await tick(); await tick();
    assert.match(view.render().props.value.error.message, /rejected the provider key/);
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
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, blobs = [], played = [];
  URL.createObjectURL = blob => { blobs.push(blob.type); return 'blob:fixture'; };
  URL.revokeObjectURL = () => {};
  global.Audio = class { pause() {} removeAttribute() {} play() { played.push(this.src); queueMicrotask(() => this.onended?.()); return Promise.resolve(); } };
  global.fetch = async () => new Response(Buffer.from('ID3-test-mp3'), { headers: { 'content-type': 'audio/mpeg' } });
  try {
    view.render(); view.start(); await tick(); view.render().props.value.play('reply', 'Hello.'); await tick(); await tick();
    assert.deepEqual(blobs, ['audio/mpeg']);
    assert.deepEqual(played, ['blob:fixture']);
    assert.equal(view.render().props.value.error, null);
  } finally { view.dispose(); global.fetch = originalFetch; global.Audio = originalAudio; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});
