import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transpileModule, ModuleKind, JsxEmit, ScriptTarget } = require('typescript');
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = new Map();
let editorDraft, hook = 0;
const react = { ...React, useState(initial) {
  hook++;
  // Seed the actual editor's draft and selected task without a DOM or changing production defaults.
  return React.useState(editorDraft && hook === 1 ? editorDraft : editorDraft && hook === 4 ? editorDraft.tasks[0].id : initial);
} };
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const local = createRequire(file);
  const imports = id => {
    if (id === 'react') return react;
    if (!id.startsWith('@/')) return local(id);
    const target = path.join(root, id.slice(2));
    const source = ['.tsx', '.ts'].map(ext => target + ext).find(existsSync);
    if (!source) throw Error(`Missing source: ${id}`);
    return load(source);
  };
  const { outputText } = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } });
  new Function('require', 'module', 'exports', outputText)(imports, module, module.exports);
  return module.exports;
}
const workflow = load(path.join(root, 'components/workflow-editor.tsx'));
const models = [
  { id: 'sol', model: 'sol', displayName: 'Sol' },
  { id: 'claude/opus', model: 'claude/opus', displayName: 'Claude Opus' },
  { id: 'agy/gpt-oss', model: 'agy/gpt-oss', displayName: 'GPT OSS' },
];
const settings = { main: { provider: 'openai', model: 'sol' }, providers: [
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'lab', displayName: 'Lab server' },
  { id: 'home', displayName: 'Home server' },
] };
const runtime = { visible: true, connected: true, target: { id: 'root', model: 'sol', modelProvider: 'openai', desktopAccess: { writable: true } },
  targetIsChild: false, models, providerSettings: settings, defaultCwd: '/workspace', defaultModel: 'sol', defaultProvider: 'openai',
  onCreateTarget: async () => {}, onResumeTarget: async () => {}, onStarted() {}, onStop: async () => {}, onOpenThread() {} };
function renderEditor(task) {
  editorDraft = { name: 'Research', max_concurrency: 2, tasks: [{ id: 'task_1', title: 'Inspect book', instruction: 'Keep the original task', kind: 'explore', depends_on: [], write_scopes: [], acceptance_criteria: ['Report findings'], ...task }] };
  hook = 0;
  try { return renderToStaticMarkup(React.createElement(workflow.WorkflowEditor, { runtime })); }
  finally { editorDraft = undefined; }
}

test('actual workflow inspector uses the shared model picker and names the selected local connection', () => {
  const html = renderEditor({ provider: 'lab', model: 'gpt-oss' });
  assert.match(html, /Keep the original task/);
  assert.match(html, /Task settings/);
  assert.match(html, /aria-label="Model"/);
  assert.match(html, /Lab server/);
  assert.doesNotMatch(html, /<input[^>]*aria-label="Task model"/);
});

test('native workflow choices separate main catalog from API connections and exclude subscriptions', () => {
  const choices = workflow.workflowProviderChoices(models, settings);
  assert.deepEqual(choices.map(choice => [choice.id, choice.label]), [['openai', 'OpenAI'], ['home', 'Home server'], ['lab', 'Lab server']]);
  assert.deepEqual(choices[0].models.map(model => model.model), ['sol']);
  assert.equal(choices[0].provider, undefined, 'main route uses its existing native catalog');
  for (const id of ['lab', 'home']) {
    const choice = workflow.workflowModelChoice(choices, id, settings.providers);
    assert.equal(choice.provider, id, 'shared picker fetches the explicitly selected connection');
    assert.deepEqual(choice.models, [], 'never borrow the main or subscription catalog for another connection');
  }
  const managed = workflow.workflowProviderChoices(models, { ...settings, managed: { modelProvider: 'openai' } });
  assert.deepEqual(managed.map(choice => choice.id), ['openai']);
});

test('inherited and saved unknown model values remain visible without becoming new overrides', () => {
  const html = renderEditor({});
  assert.match(html, /Uses the conversation model\./);
  assert.match(html, /title="Sol · OpenAI"/);
  const unknown = renderEditor({ provider: 'retired-api', model: 'saved-native-4242' });
  assert.match(unknown, /saved-native-4242/);
  assert.match(unknown, /retired-api \(not configured\)/);
  assert.doesNotMatch(unknown, /<input[^>]*aria-label="Task model"/);
  const choice = workflow.workflowModelChoice(workflow.workflowProviderChoices(models, settings), 'retired-api', settings.providers);
  assert.deepEqual(choice.models, []); assert.equal(choice.provider, 'retired-api');
});

test('shared workflow model control scopes catalog lookup and changes only the selected route model', () => {
  const choices = workflow.workflowProviderChoices(models, settings);
  const choice = workflow.workflowModelChoice(choices, 'lab', settings.providers);
  const changed = [];
  const control = workflow.WorkflowModelChoice({ choice, model: 'saved-native-4242', defaultLabel: 'Use conversation model', disabled: false, onChange: model => changed.push(model) });
  const [picker, reset] = control.props.children;
  assert.equal(picker.type.name, 'ModelPicker'); assert.deepEqual(picker.props.choices, [choice]);
  assert.deepEqual(picker.props.models, [], 'unrelated main metadata is not used to label API models');
  assert.equal(picker.props.model, 'saved-native-4242');
  picker.props.onChange({ choiceId: 'lab', model: 'gpt-oss' });
  picker.props.onChange({ choiceId: 'home', model: 'wrong-route-model' });
  assert.deepEqual(changed, ['gpt-oss'], 'a stale result for another route cannot change this model');
  reset.props.onClick(); assert.deepEqual(changed, ['gpt-oss', '']);
});

test('explicit provider still requires a model and inheritance leaves native graph data unchanged', () => {
  const task = { id: 'task_1', title: 'Inspect book', instruction: 'Read', kind: 'explore', depends_on: [], write_scopes: [], acceptance_criteria: ['Report'] };
  const inherited = { name: 'Research', max_concurrency: 2, tasks: [task] };
  assert.deepEqual(workflow.validateWorkflow(inherited), []);
  assert(workflow.validateWorkflow({ ...inherited, tasks: [{ ...task, provider: 'lab' }] }).some(message => /explicit model/.test(message)));
  assert.deepEqual(workflow.validateWorkflow({ ...inherited, tasks: [{ ...task, provider: 'lab', model: 'gpt-oss' }] }), []);
  assert(workflow.validateWorkflow({ ...inherited, tasks: [{ ...task, model: 'agy/gpt-oss' }] }).some(message => /native provider and model/.test(message)));
  assert.deepEqual(inherited.tasks[0], task);
});
