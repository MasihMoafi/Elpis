'use strict';
const providers = [
  { id: '', label: 'Elpis configuration', model: '', key: null },
  { id: 'openai', label: 'OpenAI', model: 'gpt-5.4', key: 'OPENAI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.4', key: 'OPENROUTER_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-6', key: 'ANTHROPIC_API_KEY' },
  { id: 'google-gemini', label: 'Google Gemini', model: 'gemini-3.5-flash', key: 'GEMINI_API_KEY' },
];
function selectedProvider(id) {
  const provider = providers.find(item => item.id === (id || ''));
  if (!provider) throw new Error(`Unsupported Elpis provider: ${id}`);
  return provider;
}
function runtimeOptions(settings, apiKey) {
  const provider = selectedProvider(settings.provider);
  return { ...settings, provider: provider.id, model: settings.model || provider.model,
    env: apiKey && provider.key ? { [provider.key]: apiKey } : {} };
}
function modelChoices(providerId, current = '', catalog = []) {
  selectedProvider(providerId);
  const items = [...catalog];
  if (!providerId) items.unshift({ label: 'Use configured model', description: 'Keep your Elpis configuration', model: '' });
  if (current && !items.some(p => p.model === current)) items.unshift({ label: current, description: 'Current model', model: current });
  items.push({ label: 'Enter custom model ID…', description: 'Use any model supported by this provider', custom: true });
  return items;
}
module.exports = { providers, selectedProvider, runtimeOptions, modelChoices };
