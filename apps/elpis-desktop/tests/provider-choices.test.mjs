import test from 'node:test';
import assert from 'node:assert/strict';
import { providerLabel, providerChoices, choiceOf } from '../lib/api.ts';

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

test('the list leaves out the local gpt-oss servers and Bedrock, and ends with OpenRouter then Google Gemini', () => {
  assert.deepEqual(providerChoices(models, settings).map(choice => choice.label),
    ['OpenAI', 'Anthropic', 'Anthropic credits', 'Research (1)', 'Research (2)', 'OpenRouter', 'Google Gemini']);
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
  assert.deepEqual(choices.find(choice => choice.id === '').models.map(model => model.model), ['gpt-6.1-sol']);
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
