import test from 'node:test';
import assert from 'node:assert/strict';
import { providerLabel, providerChoices, choiceOf } from '../lib/api.ts';

const providers = [
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'lmstudio', displayName: 'gpt-oss' },
  { id: 'ollama', displayName: 'gpt-oss' },
  { id: 'team-one', displayName: 'Research' },
  { id: 'team-two', displayName: 'Research' },
];
const models = [
  { id: 'sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
  { id: 'opus', model: 'claude/opus', displayName: 'Opus' },
];
const settings = { main: { model: 'gpt-6.1-sol', provider: 'openai' }, providers };

test('equal saved model nicknames still name their actual local providers', () => {
  assert.equal(providerLabel(null, 'lmstudio', providers), 'gpt-oss · LM Studio');
  assert.equal(providerLabel(null, 'ollama', providers), 'gpt-oss · Ollama');
  assert.equal(providerLabel(null, 'lmstudio'), 'LM Studio');
  assert.equal(providerLabel(null, 'ollama'), 'Ollama');
});

test('provider choices stay distinct without exposing internal keys as ordinary labels', () => {
  const choices = providerChoices(models, settings);
  assert.equal(new Set(choices.map(choice => choice.label)).size, choices.length);
  for (const id of ['team-one', 'team-two']) assert(!choices.find(choice => choice.provider === id).label.includes(id));
  assert.equal(choiceOf({ id: 'chat', model: 'gpt-oss', modelProvider: 'ollama' }, choices).provider, 'ollama');
  assert.equal(choiceOf({ id: 'chat', model: 'gpt-oss', modelProvider: 'lmstudio' }, choices).provider, 'lmstudio');
});

test('subscription identity comes from the actual route and does not borrow the engine label', () => {
  assert.equal(providerLabel('claude/opus', 'openai', providers), 'Claude subscription');
  assert.equal(providerLabel('agy/gpt-oss-120b-medium', 'openai', providers), 'Antigravity');
  assert.equal(providerLabel('gpt-6.1-sol', 'openai', providers), 'OpenAI');
});

test('a provider without a catalog never receives another provider’s models or bypasses managed policy', () => {
  const choices = providerChoices(models, settings);
  assert.deepEqual(choices.find(choice => choice.provider === 'ollama').models, []);
  assert.deepEqual(choices.find(choice => choice.id === '').models.map(model => model.model), ['gpt-6.1-sol']);
  const managed = providerChoices(models, { ...settings, managed: { modelProvider: 'openai' } });
  assert(!managed.some(choice => choice.provider === 'ollama'));
});

test('configured catalogs follow the saved configuration revision without changing route identities', () => {
  const old = providerChoices(models, { ...settings, version: 'v1' });
  const next = providerChoices(models, { ...settings, version: 'v2' });
  assert.equal(old.find(choice => choice.provider === 'ollama').catalogVersion, 'v1');
  assert.equal(next.find(choice => choice.provider === 'ollama').catalogVersion, 'v2');
  assert.deepEqual(old.map(choice => choice.id), next.map(choice => choice.id));
});
