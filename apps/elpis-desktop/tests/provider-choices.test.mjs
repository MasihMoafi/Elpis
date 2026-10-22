import test from 'node:test';
import assert from 'node:assert/strict';
import { providerLabel, providerChoices, choiceOf, connectionOrder, isListedProvider } from '../lib/api.ts';

const providers = [
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'lmstudio', displayName: 'gpt-oss' },
  { id: 'ollama', displayName: 'gpt-oss' },
  { id: 'amazon-bedrock', displayName: 'Amazon Bedrock' },
  { id: 'google-gemini', displayName: 'Gemini' },
  { id: 'openrouter', displayName: 'OpenRouter' },
  { id: 'anthropic-credits', displayName: 'Anthropic promotional credits' },
  { id: 'team-one', displayName: 'Research' },
  { id: 'team-two', displayName: 'Research' },
];
const models = [
  { id: 'sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
  { id: 'opus', model: 'claude/opus', displayName: 'Opus' },
];
const settings = { main: { model: 'gpt-6.1-sol', provider: 'openai' }, providers };

test('known providers keep their own short names whatever their saved nickname', () => {
  assert.equal(providerLabel(null, 'anthropic-credits', providers), 'Anthropic credits');
  assert.equal(providerLabel(null, 'google-gemini', providers), 'Google Gemini');
  assert.equal(providerLabel(null, 'openrouter'), 'OpenRouter');
});

test('the list leaves out the local gpt-oss servers and Bedrock, and keeps the owned order (R35)', () => {
  assert.deepEqual(providerChoices(models, settings).map(choice => choice.label),
    ['OpenAI', 'Anthropic', 'OpenRouter', 'Anthropic credits', 'Google Gemini', 'Research (1)', 'Research (2)']);
});

test('every list orders connections as Masih owns them and lists neither Amazon entry (R35)', () => {
  const ids = ['google-gemini', 'amazon-bedrock', 'anthropic', 'team', 'openrouter', 'openai', 'amazon-bedrock-runtime', 'claude/', 'agy/'];
  const listed = connectionOrder(ids.filter(isListedProvider).map(id => ({ id, label: providerLabel(null, id, []) })));
  assert.deepEqual(listed.map(item => item.id), ['openai', 'claude/', 'agy/', 'openrouter', 'anthropic', 'google-gemini', 'team']);
});

test('provider choices stay distinct without exposing internal keys as ordinary labels', () => {
  const choices = providerChoices(models, settings);
  assert.equal(new Set(choices.map(choice => choice.label)).size, choices.length);
  for (const id of ['team-one', 'team-two']) assert(!choices.find(choice => choice.provider === id).label.includes(id));
  assert.equal(choiceOf({ id: 'chat', model: 'deepseek/deepseek-v4.1-flash', modelProvider: 'openrouter' }, choices).provider, 'openrouter');
});

test('subscription identity comes from the actual route and does not borrow the engine label', () => {
  assert.equal(providerLabel('claude/opus', 'openai', providers), 'Anthropic');
  assert.equal(providerLabel('agy/gpt-oss-120b-medium', 'openai', providers), 'Antigravity');
  assert.equal(providerLabel('gpt-6.1-sol', 'openai', providers), 'OpenAI');
});

test('a provider without a catalog never receives another provider’s models or bypasses managed policy', () => {
  const choices = providerChoices(models, settings);
  assert.deepEqual(choices.find(choice => choice.provider === 'openrouter').models, []);
  assert.deepEqual(choices[0].models.map(model => model.model), ['gpt-6.1-sol']);
  const managed = providerChoices(models, { ...settings, managed: { modelProvider: 'openai' } });
  assert(!managed.some(choice => choice.provider === 'openrouter'));
});

test('configured catalogs follow the saved configuration revision without changing route identities', () => {
  const old = providerChoices(models, { ...settings, version: 'v1' });
  const next = providerChoices(models, { ...settings, version: 'v2' });
  assert.equal(old.find(choice => choice.provider === 'openrouter').catalogVersion, 'v1');
  assert.equal(next.find(choice => choice.provider === 'openrouter').catalogVersion, 'v2');
  assert.deepEqual(old.map(choice => choice.id), next.map(choice => choice.id));
});

test('a configured API default never borrows the engine startup catalog after the default changes', () => {
  for (const provider of ['anthropic-credits', 'openrouter', 'team-one']) {
    const choices = providerChoices(models, { ...settings, version: 'changed-default', main: { provider, model: 'vendor-model' } });
    const primary = choices[0];
    assert.equal(primary.provider, provider, 'the default API connection must load its own catalog');
    assert.deepEqual(primary.models, [], 'Sol from the engine startup catalog does not become an API provider model');
    assert.equal(primary.catalogVersion, 'changed-default');
    assert.equal(choiceOf({ id: 'existing', model: 'vendor-model', modelProvider: provider }, choices), primary);
    assert.deepEqual(choices.find(choice => choice.id === 'claude/').models.map(model => model.model), ['claude/opus']);
  }
  const openai = providerChoices(models, settings)[0];
  assert.equal(openai.provider, undefined, 'OpenAI retains its authenticated engine catalog');
  assert.deepEqual(openai.models.map(model => model.model), ['gpt-6.1-sol']);
});

test('an explicit provider choice keeps its identity when another provider becomes the default', () => {
  const before = providerChoices(models, settings);
  const solChoice = before.find(choice => choice.models.some(model => model.model === 'gpt-6.1-sol'));
  const after = providerChoices(models, { ...settings, main: { model: 'claude-opus-5-5', provider: 'anthropic-credits' } });
  const retained = after.find(choice => choice.id === solChoice.id);
  assert.equal(retained?.provider, 'openai', 'the chosen Sol route must not become Anthropic credits');
});

test('a stored chat provider is not relabeled as the new default when its connection is absent from settings', () => {
  const choices = providerChoices(models, { main: { model: 'claude-opus-5-5', provider: 'anthropic-credits' }, providers: providers.filter(item => item.id === 'anthropic-credits') });
  const stored = choiceOf({ id: 'old-openai-chat', model: 'gpt-6.1-sol', modelProvider: 'openai' }, choices);
  assert.equal(stored.provider ?? stored.id, 'openai');
  assert.equal(stored.label, 'OpenAI');
});
