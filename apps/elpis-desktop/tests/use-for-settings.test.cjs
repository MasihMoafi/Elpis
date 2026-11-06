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
    '@/components/settings/rows': { SettingsGroup: passthrough('section'), SettingRow: props => React.createElement('section', { 'aria-label': props.title }, props.description, props.children), SettingsNotice: passthrough('p'), SettingsActions: passthrough('div') },
    '@/lib/api': { api: overrides.api ?? (async () => ({})), connectionOrder: rows => rows, subscriptionOf: model => model?.startsWith('claude/') ? { prefix: 'claude/', label: 'Claude subscription' } : null },
    '@/lib/error-text.mjs': { errorText: error => String(error) },
    '@/lib/speech-model.mjs': require('../lib/speech-model.mjs'),
    '@/lib/settings-store': { useElpisSettings: () => ({ data: { version: 'v1', main: { provider: 'openai', model: 'model' }, providers: [{ id: 'openai', displayName: 'ChatGPT' }], write: { available: true } } }), editable: () => true, saveSettings: overrides.saveSettings ?? (async () => {}) },
    '@/components/settings/maintenance': { useModelCatalog: () => ({ models: [{ id: 'claude/opus', model: 'claude/opus', displayName: 'Claude Opus' }] }) },
  };
  new Function('require', 'module', 'exports', code)(id => id === 'react' && overrides.react ? overrides.react : mocks[id] || require(id), module, module.exports);
  return module.exports.UseForSettings;
}

function providersPage(UseForSettings) {
  const file = path.join(root, 'components/providers-settings.tsx');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const passthrough = name => props => React.createElement(name, null, props.children);
  const subscription = { state: 'notConnected', models: [], usage: [] };
  const mocks = {
    '@/components/settings/settings.css': {},
    '@/components/ui/disclosure-summary': { DisclosureSummary: passthrough('summary') },
    '@/components/ui/button': { Button: passthrough('button') },
    '@/components/ui/option-select': { OptionSelect: passthrough('select') },
    '@/components/ui/input': { Input: passthrough('input') },
    '@/lib/api': { api: async () => ({}) },
    '@/lib/provider-form': { providerFormId: () => '' },
    '@/components/settings/rows': { RefreshButton: passthrough('button'), SettingsHeader: passthrough('header'), SettingsNotice: passthrough('p') },
    '@/components/claude-accounts-settings': { ClaudeAccountsSettings: () => null },
    '@/components/settings/use-for-settings': { UseForSettings },
    '@/components/provider-usage': { useProviderUsage: () => ({ data: { openai: { auth: { state: 'signedOut' } }, claude: subscription, gemini: subscription, openrouter: [] }, error: '', load: async () => {} }) },
    '@/lib/error-text.mjs': { errorText: error => String(error) },
  };
  new Function('require', 'module', 'exports', code)(id => mocks[id] || require(id), module, module.exports);
  return module.exports.ProvidersSettings;
}

for (const response of ['rejected', 'empty', 'malformed']) test(`provider cards remain visible when Use for replies are ${response}`, async () => {
  const slots = [], pending = []; let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  const api = async route => {
    if (response === 'rejected') throw Error('route failed');
    if (response === 'malformed' && route === '/mcp') return { write: { available: true }, servers: [{ name: 'whispertype', whispertype: { backend: 'openrouter', model: {} } }] };
    return {};
  };
  const UseForSettings = component([], { react: hooks, api });
  const props = { providers: [], refreshKey: 0, active: true };
  UseForSettings(props);
  for (const effect of pending.splice(0)) effect();
  await new Promise(setImmediate);
  cursor = 0;
  const html = renderToStaticMarkup(React.createElement(providersPage(UseForSettings), { refreshKey: 0 }));
  for (const name of ['openai', 'claude', 'cloudroom', 'gemini']) assert.match(html, new RegExp(`data-provider="${name}"`));
  for (const name of ['Chat', 'Read aloud', 'Dictation']) {
    const row = html.match(new RegExp(`<section aria-label="${name}">[\\s\\S]*?</section>`));
    assert.ok(row, `${name} row is visible`);
    assert.match(row[0], /unavailable/i, `${name} explains its unavailable route`);
    if (name === 'Dictation') assert.doesNotMatch(row[0], /Add WhisperType/, 'an unreadable setting is not reported as missing');
  }
});

for (const source of ['local', 'openrouter']) test(`Use for isolates unavailable ${source === 'local' ? 'voice' : 'speech model'} and dictation model choices`, async () => {
  const slots = [], pending = []; let cursor = 0, failing = true;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  const api = async route => {
    if (route === '/mcp') return { version: 'v1', write: { available: true }, servers: [{ name: 'whispertype', whispertype: { backend: 'local', model: null } }] };
    if (route === '/read-aloud/settings') return { source, model: source === 'local' ? null : 'fish/voice', voice: null };
    if (route === '/read-aloud/voices') { if (failing) throw Error('voices unavailable'); return { voices: ['warm'] }; }
    if (route.includes('outputModality=')) { if (failing) return {}; return { data: [{ model: 'fish/voice', displayName: 'Fish' }] }; }
    return { data: [{ model: 'model', displayName: 'Model' }] };
  };
  const UseForSettings = component([], { react: hooks, api }), props = { providers, refreshKey: 0, active: true };
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  const render = () => { cursor = 0; return UseForSettings(props); };
  const effects = () => { for (const effect of pending.splice(0)) effect(); };
  const settle = async () => { render(); effects(); await new Promise(setImmediate); render(); effects(); await new Promise(setImmediate); };
  const hasText = (row, text) => elements(row).some(item => item.props.children === text);
  await settle();
  let tree = elements(render());
  let speech = tree.find(item => item.props.title === 'Read aloud'), dictation = tree.find(item => item.props.title === 'Dictation');
  assert.ok(hasText(speech, source === 'local' ? 'Voice choices unavailable.' : 'Speech model choices unavailable.'));
  assert.ok(hasText(dictation, 'Dictation model choices unavailable.'));
  assert.equal(!!tree.find(item => item.props['aria-label'] === 'Chat model').props.disabled, false);
  assert.equal(!!tree.find(item => item.props['aria-label'] === 'Dictation source').props.disabled, false);
  failing = false; props.refreshKey++;
  await settle();
  tree = elements(render()); speech = tree.find(item => item.props.title === 'Read aloud'); dictation = tree.find(item => item.props.title === 'Dictation');
  assert.equal(hasText(speech, 'Voice choices unavailable.') || hasText(speech, 'Speech model choices unavailable.'), false);
  assert.equal(hasText(dictation, 'Dictation model choices unavailable.'), false);
});

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
