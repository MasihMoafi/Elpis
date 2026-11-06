const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const providers = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', auth: { keySet: true } },
  { id: 'api-other', name: 'Other API', baseUrl: 'https://example.test/v1', auth: { keySet: true } },
];
function component(records, overrides = {}) {
  const file = path.join(root, 'components/settings/use-for-settings.tsx');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const select = props => { records.push(props); return React.createElement('select', props, props.children); };
  const passthrough = name => props => React.createElement(name, props, props.children);
  const mocks = {
    '@/components/ui/option-select': { OptionSelect: select },
    '@/components/ui/button': { Button: passthrough('button') },
    '@/components/settings/rows': { SettingsGroup: passthrough('section'), SettingRow: passthrough('div'), SettingsNotice: passthrough('p'), SettingsActions: passthrough('div') },
    '@/lib/api': { api: overrides.api ?? (async () => ({})), connectionOrder: rows => rows, subscriptionOf: model => model?.startsWith('claude/') ? { prefix: 'claude/', label: 'Claude subscription' } : null },
    '@/lib/error-text.mjs': { errorText: error => String(error) },
    '@/lib/speech-model.mjs': require('../lib/speech-model.mjs'),
    '@/lib/settings-store': { useElpisSettings: () => ({ data: { version: 'v1', main: { provider: 'openai', model: 'model' }, providers: [{ id: 'openai', displayName: 'ChatGPT' }], write: { available: true } } }), editable: () => true, saveSettings: overrides.saveSettings ?? (async () => {}) },
    '@/components/settings/maintenance': { useModelCatalog: () => ({ models: [{ id: 'claude/opus', model: 'claude/opus', displayName: 'Claude Opus' }] }) },
  };
  new Function('require', 'module', 'exports', code)(id => id === 'react' && overrides.react ? overrides.react : mocks[id] || require(id), module, module.exports);
  return module.exports.UseForSettings;
}

test('Use for presents four capabilities with unsupported speech sources disabled', () => {
  const records = [], UseForSettings = component(records);
  const html = renderToStaticMarkup(React.createElement(UseForSettings, { providers, refreshKey: 0 }));
  for (const name of ['Chat', 'Read aloud', 'Live voice', 'Dictation']) assert.match(html, new RegExp(name));
  const speech = records.find(item => item['aria-label'] === 'Read aloud source');
  const live = records.find(item => item['aria-label'] === 'Live voice source');
  assert.ok(speech && live, 'the capability rows use selects');
  const options = select => React.Children.toArray(select.children).filter(React.isValidElement);
  assert.equal(options(speech).find(option => option.props.value === 'openrouter').props.disabled, false);
  assert.equal(options(speech).find(option => option.props.value === 'api-other').props.disabled, true);
  assert.equal(options(live).find(option => option.props.value === 'openrouter').props.disabled, true);
  assert.equal(options(live).find(option => option.props.value === 'local').props.disabled, true);
});

test('Use for offers a connected Claude subscription for the chat default', () => {
  const records = [], UseForSettings = component(records);
  renderToStaticMarkup(React.createElement(UseForSettings, { providers, refreshKey: 0 }));
  const chat = records.find(item => item['aria-label'] === 'Chat source');
  const options = React.Children.toArray(chat.children).filter(React.isValidElement);
  assert.ok(options.some(option => option.props.value === 'claude/'));
  assert.ok(options.some(option => option.props.value === 'openai'));
});

test('Use for explains that ChatGPT live voice needs a sign-in', () => {
  const records = [], UseForSettings = component(records);
  renderToStaticMarkup(React.createElement(UseForSettings, { providers, refreshKey: 0, chatgptAvailable: false }));
  const live = records.find(item => item['aria-label'] === 'Live voice source');
  const option = React.Children.toArray(live.children).find(item => React.isValidElement(item) && item.props.value === 'chatgpt');
  assert.equal(option.props.disabled, true);
  assert.match(option.props['data-hint'], /sign in/i);
});

test('Use for reloads the Voice setting when returning to the providers page', async () => {
  const slots = [], pending = []; let cursor = 0, backend = 'local';
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  const api = async route => route === '/mcp' ? { version: 'v1', write: { available: true }, servers: [{ name: 'whispertype', whispertype: { backend, model: null } }] }
    : route === '/read-aloud/settings' ? { source: 'local', model: null, voice: null } : { data: [], voices: [] };
  const UseForSettings = component([], { react: hooks, api }), props = { providers, refreshKey: 0, active: true };
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  const render = () => { cursor = 0; return UseForSettings(props); };
  const effects = () => { for (const effect of pending.splice(0)) effect(); };
  const selected = () => elements(render()).find(item => item.props['aria-label'] === 'Dictation source').props.value;
  render(); effects(); await new Promise(setImmediate); assert.equal(selected(), 'local');
  props.active = false; render(); effects();
  backend = 'codex'; props.active = true; render(); effects(); await new Promise(setImmediate);
  assert.equal(selected(), 'codex');
});

test('Use for saves the chosen Claude model through Configuration’s shared writer', async () => {
  const slots = [], pending = [], saved = []; let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  const api = async route => route === '/mcp' ? { version: 'v1', write: { available: true }, servers: [] }
    : route === '/read-aloud/settings' ? { source: 'local', model: null, voice: null } : { data: [], voices: [] };
  const UseForSettings = component([], { react: hooks, api, saveSettings: async (route, body) => { saved.push({ route, body }); } });
  const props = { providers, refreshKey: 0, active: true };
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  const render = () => { cursor = 0; return UseForSettings(props); };
  const effects = () => { for (const effect of pending.splice(0)) effect(); };
  render(); effects(); await new Promise(setImmediate);
  elements(render()).find(item => item.props['aria-label'] === 'Chat source').props.onChange({ target: { value: 'claude/' } });
  render(); effects();
  elements(render()).find(item => item.props['aria-label'] === 'Chat model').props.onChange({ target: { value: 'claude/opus' } });
  const row = elements(render()).find(item => item.props.title === 'Chat');
  elements(row).find(item => item.props.children === 'Save').props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(saved, [{ route: '/settings', body: { version: 'v1', main: { provider: 'openai', model: 'claude/opus' } } }]);
});

test('Use for asks for a voice before saving a speech model that lists voices', async () => {
  const slots = [], pending = []; let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  const api = async route => route === '/mcp' ? { version: 'v1', write: { available: true }, servers: [] }
    : route === '/read-aloud/settings' ? { source: 'local', model: null, voice: null }
    : route.includes('outputModality=speech') ? { data: [{ model: 'fish/voice', displayName: 'Fish', voices: ['warm'] }] } : { data: [], voices: [] };
  const UseForSettings = component([], { react: hooks, api }), props = { providers, refreshKey: 0, active: true };
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  const render = () => { cursor = 0; return UseForSettings(props); };
  const effects = () => { for (const effect of pending.splice(0)) effect(); };
  const row = () => elements(render()).find(item => item.props.title === 'Read aloud');
  render(); effects(); await new Promise(setImmediate);
  elements(render()).find(item => item.props['aria-label'] === 'Read aloud source').props.onChange({ target: { value: 'openrouter' } });
  render(); effects(); await new Promise(setImmediate);
  elements(render()).find(item => item.props['aria-label'] === 'Read aloud model').props.onChange({ target: { value: 'fish/voice' } });
  assert.equal(elements(row()).find(item => item.props.children === 'Save').props.disabled, true);
  elements(render()).find(item => item.props['aria-label'] === 'Read aloud voice').props.onChange({ target: { value: 'warm' } });
  assert.equal(elements(row()).find(item => item.props.children === 'Save').props.disabled, false);
});
