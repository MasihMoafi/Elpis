// Models & accounts: each API key carries a checkbox per feature (Masih, 6 Nov: "optionally one key for everything;
// remember? we get to check and uncheck."). A ticked box routes that feature to the key through its existing owner
// (Configuration's main model, the read aloud preference, WhisperType); an unticked one returns it to the default.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const ROUTER = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', auth: { keySet: true } };
const OTHER = { id: 'api-other', name: 'Other API', baseUrl: 'https://example.test/v1', auth: { keySet: true } };

/** The hook under fake React hooks: `render()` returns the per-key sections; `settle()` runs effects and awaits replies. */
function harness({ providers = [ROUTER, OTHER], speech = { source: 'local', model: null, voice: null }, whisper = { backend: null, model: null }, main = { provider: 'openai', model: 'sol' }, api: answer } = {}) {
  const slots = [], pending = [], posts = []; let cursor = 0;
  const settings = { version: 'v1', main: { ...main }, providers: [{ id: 'openai', displayName: 'ChatGPT' }, ...providers.map(item => ({ id: item.id, displayName: item.name }))], write: { available: true } };
  const state = { speech: { ...speech }, whisper: { ...whisper } };
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  const api = async (route, body) => {
    if (body !== undefined) posts.push({ route, body });
    const custom = answer?.(route, body);
    if (custom !== undefined) return custom;
    if (route === '/read-aloud/settings') { if (body) state.speech = body; return state.speech; }
    if (route === '/mcp') {
      if (body) state.whisper = { backend: body.backend, model: body.model === undefined ? state.whisper.model : body.model, ...(body.everyChat ? { everyChat: true, explicit: true } : {}) };
      return { version: 'v1', write: { available: true }, servers: [{ name: 'whispertype', whispertype: state.whisper }] };
    }
    if (route.includes('outputModality=speech')) return { data: [{ model: 'fish/voice', displayName: 'Fish' }] };
    if (route.includes('outputModality=transcription')) return { data: [{ model: 'openai/whisper', displayName: 'Whisper' }] };
    if (route === '/models?provider=openai') return { data: [{ model: 'mini', displayName: 'Mini' }, { model: 'sol', displayName: 'Sol', isDefault: true }] };
    if (route.startsWith('/models?provider=')) return { data: [{ model: 'qwen/coder', displayName: 'Qwen Coder' }] };
    return {};
  };
  const passthrough = name => props => React.createElement(name, props, props.children);
  const mocks = {
    '@/components/ui/option-select': { OptionSelect: passthrough('select') },
    '@/components/ui/checkbox': { Checkbox: passthrough('input') },
    '@/components/ui/button': { Button: passthrough('button') },
    '@/components/settings/rows': { SettingsNotice: passthrough('p') },
    '@/lib/api': { api },
    '@/lib/error-text.mjs': { errorText: error => String(error?.message ?? error) },
    '@/lib/speech-model.mjs': require('../lib/speech-model.mjs'),
    '@/lib/settings-store': { useElpisSettings: () => ({ data: settings }), editable: () => true, saveSettings: async (route, body) => { posts.push({ route, body }); Object.assign(settings.main, body.main); return settings; } },
  };
  const file = path.join(root, 'components/settings/use-for-settings.tsx');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => id === 'react' ? hooks : mocks[id] || require(id), module, module.exports);
  const props = { providers, refreshKey: 0, active: true };
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : Array.isArray(node) ? node.flatMap(elements) : [];
  const render = () => { cursor = 0; const uses = module.exports.useKeyUses(props); return providers.map(item => uses(item)); };
  const settle = async () => { for (let round = 0; round < 3; round++) { render(); for (const effect of pending.splice(0)) effect(); await new Promise(setImmediate); } };
  const find = label => elements(render()).find(item => item.props['aria-label'] === label);
  const box = (key, feature) => find(`Use ${key.name} for ${feature}`);
  const text = (key) => elements(render()[providers.indexOf(key)]).map(item => typeof item.props.children === 'string' ? item.props.children : '').join(' | ');
  const click = async node => { await node.props.onClick(); await settle(); };
  const tick = async (key, feature, checked) => { await box(key, feature).props.onCheckedChange(checked); await settle(); };
  const choose = async (label, value) => { find(label).props.onChange({ target: { value } }); await settle(); };
  const save = (key, feature) => elements(render()[providers.indexOf(key)]).find(item => item.props['aria-label'] === `Save ${feature} for ${key.name}`);
  return { settle, box, find, text, tick, choose, save, click, posts, settings, state };
}

test('ticking read aloud on the OpenRouter key routes read aloud to it', async () => {
  const app = harness();
  await app.settle();
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, false, 'read aloud starts on its local default');
  assert.equal(app.find('Read aloud model for OpenRouter'), undefined, 'no model picker before the box is ticked');
  await app.tick(ROUTER, 'Read aloud', true);
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, true);
  assert.equal(app.save(ROUTER, 'Read aloud').props.disabled, true, 'saving waits for a model');
  await app.choose('Read aloud model for OpenRouter', 'fish/voice');
  await app.click(app.save(ROUTER, 'Read aloud'));
  assert.deepEqual(app.posts.filter(item => item.route === '/read-aloud/settings'), [{ route: '/read-aloud/settings', body: { source: 'openrouter', model: 'fish/voice', voice: null } }]);
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, true, 'the saved choice stays ticked');
  assert.equal(app.box(OTHER, 'Read aloud').props.checked, false);
});

test('a feature the key cannot do is disabled with its reason and cannot be ticked', async () => {
  const app = harness();
  await app.settle();
  for (const [key, feature] of [[OTHER, 'Read aloud'], [OTHER, 'Dictation'], [OTHER, 'Live voice'], [ROUTER, 'Live voice']]) {
    const box = app.box(key, feature);
    assert.equal(box.props.disabled, true, `${feature} on ${key.name} is disabled`);
    assert.equal(box.props.checked, false);
    await app.tick(key, feature, true);
    assert.equal(app.box(key, feature).props.checked, false, `${feature} on ${key.name} stays unticked`);
  }
  assert.match(app.text(OTHER), /no speech models/i);
  assert.match(app.text(ROUTER), /ChatGPT subscription/i, 'live voice says where it runs');
  assert.equal(app.box(OTHER, 'Chat').props.disabled, false, 'any key with a Responses endpoint can chat');
  assert.deepEqual(app.posts, [], 'nothing is saved');
});

test('a key without a saved API key offers nothing', async () => {
  const bare = { ...ROUTER, id: 'openrouter-bare', name: 'Bare', auth: { keySet: false } };
  const app = harness({ providers: [ROUTER, bare] });
  await app.settle();
  for (const feature of ['Chat', 'Read aloud', 'Live voice', 'Dictation']) assert.equal(app.box(bare, feature).props.disabled, true);
  assert.match(app.text(bare), /Add an API key first/);
});

test('a server on this computer can take chat without a key, but not hosted speech', async () => {
  const local = { id: 'local-server', name: 'Local server', baseUrl: 'http://127.0.0.1:1234/v1', auth: { keySet: false } };
  const app = harness({ providers: [ROUTER, local] });
  await app.settle();
  assert.equal(app.box(local, 'Chat').props.disabled, false);
  assert.equal(app.box(local, 'Read aloud').props.disabled, true);
});

test('unticking read aloud returns it to local Kokoro', async () => {
  const app = harness({ speech: { source: 'openrouter', model: 'fish/voice', voice: null } });
  await app.settle();
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, true);
  await app.tick(ROUTER, 'Read aloud', false);
  assert.deepEqual(app.posts, [{ route: '/read-aloud/settings', body: { source: 'local', model: null, voice: null } }]);
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, false);
});

test('ticking read aloud on one key unticks it on another', async () => {
  const second = { ...ROUTER, id: 'openrouter-work', name: 'Work key' };
  const app = harness({ providers: [ROUTER, second], speech: { source: 'openrouter-work', model: 'fish/voice', voice: null } });
  await app.settle();
  assert.equal(app.box(second, 'Read aloud').props.checked, true);
  await app.tick(ROUTER, 'Read aloud', true);
  assert.match(app.text(ROUTER), /Moves Read aloud from Work key/);
  await app.choose('Read aloud model for OpenRouter', 'fish/voice');
  await app.click(app.save(ROUTER, 'Read aloud'));
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, true);
  assert.equal(app.box(second, 'Read aloud').props.checked, false);
});

test('chat on a key saves the main model there; unticking returns chat to the ChatGPT default model', async () => {
  const app = harness();
  await app.settle();
  await app.tick(ROUTER, 'Chat', true);
  await app.choose('Chat model for OpenRouter', 'qwen/coder');
  await app.click(app.save(ROUTER, 'Chat'));
  assert.deepEqual(app.posts.at(-1), { route: '/settings', body: { version: 'v1', main: { provider: 'openrouter', model: 'qwen/coder' } } });
  assert.equal(app.box(ROUTER, 'Chat').props.checked, true);
  await app.tick(ROUTER, 'Chat', false);
  assert.deepEqual(app.posts.at(-1), { route: '/settings', body: { version: 'v1', main: { provider: 'openai', model: 'sol' } } });
  assert.equal(app.box(ROUTER, 'Chat').props.checked, false);
});

test('chat stays on the key when there is no ChatGPT model to return to', async () => {
  const app = harness({ main: { provider: 'openrouter', model: 'qwen/coder' }, api: route => route === '/models?provider=openai' ? { data: [] } : undefined });
  await app.settle();
  await app.tick(ROUTER, 'Chat', false);
  assert.equal(app.posts.some(item => item.route === '/settings'), false, 'no silent switch to another model');
  assert.equal(app.box(ROUTER, 'Chat').props.checked, true);
  assert.match(app.text(ROUTER), /Sign in with ChatGPT/);
});

test('dictation on the OpenRouter key saves WhisperType for every chat; unticking restores Automatic', async () => {
  const app = harness();
  await app.settle();
  await app.tick(ROUTER, 'Dictation', true);
  await app.choose('Dictation model for OpenRouter', 'openai/whisper');
  await app.click(app.save(ROUTER, 'Dictation'));
  assert.deepEqual(app.posts.at(-1), { route: '/mcp', body: { version: 'v1', name: 'whispertype', action: 'whispertype', backend: 'openrouter', model: 'openai/whisper', everyChat: true } });
  assert.equal(app.box(ROUTER, 'Dictation').props.checked, true);
  await app.tick(ROUTER, 'Dictation', false);
  assert.deepEqual(app.posts.at(-1), { route: '/mcp', body: { version: 'v1', name: 'whispertype', action: 'whispertype', backend: null, everyChat: false } });
  assert.equal(app.box(ROUTER, 'Dictation').props.checked, false);
});

test('unticking a box that was ticked but never saved changes nothing', async () => {
  const app = harness();
  await app.settle();
  await app.tick(ROUTER, 'Read aloud', true);
  await app.tick(ROUTER, 'Read aloud', false);
  assert.equal(app.box(ROUTER, 'Read aloud').props.checked, false);
  assert.equal(app.find('Read aloud model for OpenRouter'), undefined);
  assert.deepEqual(app.posts, []);
});

for (const response of ['rejected', 'empty', 'malformed']) test(`a key explains unreadable read aloud and dictation settings when replies are ${response}`, async () => {
  const app = harness({ api: route => {
    if (route !== '/read-aloud/settings' && route !== '/mcp') return undefined;
    if (response === 'rejected') throw Error('route failed');
    if (response === 'malformed' && route === '/mcp') return { write: { available: true }, servers: [{ name: 'whispertype', whispertype: { backend: 'openrouter', model: {} } }] };
    return {};
  } });
  await app.settle();
  assert.equal(app.box(ROUTER, 'Read aloud').props.disabled, true);
  assert.equal(app.box(ROUTER, 'Dictation').props.disabled, true);
  assert.equal(app.box(ROUTER, 'Chat').props.disabled, false, 'one unreadable setting leaves the others usable');
  assert.match(app.text(ROUTER), /Read aloud settings unavailable/);
  assert.match(app.text(ROUTER), /Dictation settings unavailable/);
});
