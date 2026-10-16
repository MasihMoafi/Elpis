import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url), React = require('react');
const { transpileModule, ModuleKind, JsxEmit, ScriptTarget } = require('typescript');
const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(relative, name, props, seed = {}) {
  const slots = [], pending = [], cache = new Map(); let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const key = cursor++; if (!(key in slots)) slots[key] = key in seed ? seed[key] : typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useRef(initial) { const key = cursor++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
    useEffect(effect, deps) { const key = cursor++, old = slots[key]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[key] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); }); } },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module); const local = createRequire(file);
    const imports = id => {
      if (id === 'react') return hooks;
      if (!id.startsWith('@/')) return local(id);
      const target = path.join(root, id.slice(2));
      return load(['.tsx', '.ts'].map(extension => target + extension).find(existsSync));
    };
    const { outputText } = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } });
    new Function('require', 'module', 'exports', outputText)(imports, module, module.exports);
    return module.exports;
  }
  const Component = load(path.join(root, relative))[name];
  return { render() { cursor = 0; return Component(props); }, effects() { for (const effect of pending.splice(0)) effect(); }, dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}
function elements(node) { return React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : Array.isArray(node) ? node.flatMap(elements) : []; }
const named = (tree, name) => elements(tree).find(element => element.type?.name === name);
const button = (tree, label) => elements(tree).find(element => element.props.children === label && typeof element.props.onClick === 'function');
const models = [{ id: 'sol', model: 'sol', displayName: 'Sol' }];
const settings = { main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'local', displayName: 'Local server' }] };
const choice = { id: 'local', provider: 'local', label: 'Local server', models: [] };
const pickerProps = { choices: [choice], models: [], model: 'saved', choiceId: 'local', disabled: false, onChange() { assert.fail('Configuration must not change the selected model'); } };
async function open(view) { view.render().props.onOpenChange(true); view.render(); view.effects(); await new Promise(setImmediate); return view.render(); }

test('catalog error offers connection setup and closes the popup before navigation', async () => {
  const previous = globalThis.fetch, calls = []; let configured = 0, view;
  globalThis.fetch = async url => { calls.push(url); return { ok: false, json: async () => ({ error: 'Set up the connection address.' }) }; };
  view = fixture('components/model-picker.tsx', 'ModelPicker', { ...pickerProps, onConfigure() { assert.equal(view.render().props.open, false); configured++; } });
  try {
    const tree = await open(view);
    assert.equal(elements(tree).find(element => element.props.role === 'alert').props.children, 'Set up the connection address.');
    assert.ok(button(tree, 'Try again'));
    const configure = button(tree, 'Manage connections'); assert.ok(configure, 'catalog error needs a path to connection setup');
    configure.props.onClick();
    assert.equal(configured, 1); assert.equal(view.render().props.open, false);
    assert.deepEqual(calls, ['/api/models?provider=local']);
  } finally { view.dispose(); globalThis.fetch = previous; }
});

test('optional setup callback is absent safely; retry recovers without changing the selected model', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? { ok: false, json: async () => ({ error: 'Unavailable' }) } : { ok: true, json: async () => ({ data: [{ id: 'saved', model: 'saved' }] }) };
  const view = fixture('components/model-picker.tsx', 'ModelPicker', pickerProps);
  try {
    let tree = await open(view); assert.equal(button(tree, 'Manage connections'), undefined);
    button(tree, 'Try again').props.onClick(); view.render(); view.effects(); await new Promise(setImmediate);
    tree = view.render(); assert.equal(button(tree, 'Manage connections'), undefined); assert.equal(button(tree, 'Try again'), undefined);
    assert.equal(calls, 2); assert.equal(tree.props.open, true);
  } finally { view.dispose(); globalThis.fetch = previous; }
});

test('new-agent form forwards the same connection setup callback to its model picker', () => {
  const onConfigure = () => {};
  const view = fixture('components/new-agent-form.tsx', 'NewAgentForm', { models, settings, defaultCwd: '/workspace', connected: true, onCreated() {}, onConfigure });
  assert.equal(named(view.render(), 'ModelPicker').props.onConfigure, onConfigure);
});

test('inherited subscription defaults retain their provider identity while exact route matches take precedence', () => {
  const choices = [{ id: '', label: 'OpenAI', models }];
  for (const [defaultModel, provider] of [['claude/opus', 'Anthropic'], ['agy/gpt-oss', 'Antigravity'], ['sol', 'OpenAI']]) {
    const view = fixture('components/model-picker.tsx', 'ModelPicker', { ...pickerProps, choices, models, choiceId: '', model: '', defaultModel });
    const trigger = elements(view.render()).find(element => element.props['aria-label'] === 'Model');
    assert.ok(trigger.props.title.endsWith(` · ${provider}`), trigger.props.title);
  }
  const explicit = fixture('components/model-picker.tsx', 'ModelPicker', { ...pickerProps, choices: [{ ...choice, models: [{ id: 'own', model: 'claude/opus', displayName: 'Own model' }] }], model: 'claude/opus' });
  assert.equal(elements(explicit.render()).find(element => element.props['aria-label'] === 'Model').props.title, 'Own model · Local server');
});

test('a saved connection revision replaces its catalog without remounting or changing the selected model', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'model-' + ++calls, model: 'model-' + calls, displayName: 'Reported model ' + calls }] }) });
  const props = { ...pickerProps, choices: [{ ...choice, catalogVersion: 'v1' }] };
  const view = fixture('components/model-picker.tsx', 'ModelPicker', props);
  try {
    assert.deepEqual((await open(view)).props.items.map(item => item.model), ['model-1']);
    props.choices = [{ ...choice, catalogVersion: 'v2' }];
    assert.deepEqual(view.render().props.items, [], 'models from the old connection must stop being offered immediately');
    view.effects(); await new Promise(setImmediate);
    assert.deepEqual(view.render().props.items.map(item => item.model), ['model-2']);
    assert.equal(calls, 2);
    assert.equal(elements(view.render()).find(element => element.props['aria-label'] === 'Model').props['data-value'], 'saved');
  } finally { view.dispose(); globalThis.fetch = previous; }
});

test('a late catalog from the previous connection revision cannot replace the new one', async () => {
  const previous = globalThis.fetch; let calls = 0, release;
  globalThis.fetch = async () => {
    const request = ++calls;
    if (request === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ data: [{ id: request === 1 ? 'old' : 'new', model: request === 1 ? 'old' : 'new' }] }) };
  };
  const props = { ...pickerProps, choices: [{ ...choice, catalogVersion: 'v1' }] };
  const view = fixture('components/model-picker.tsx', 'ModelPicker', props);
  try {
    await open(view);
    props.choices = [{ ...choice, catalogVersion: 'v2' }];
    view.render(); view.effects(); await new Promise(setImmediate);
    assert.deepEqual(view.render().props.items.map(item => item.model), ['new']);
    release(); await new Promise(setImmediate);
    assert.deepEqual(view.render().props.items.map(item => item.model), ['new']);
    assert.equal(calls, 2);
  } finally { release?.(); view.dispose(); globalThis.fetch = previous; }
});
