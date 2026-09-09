const {selectedProvider} = require('./providers');

async function loadProviderModels(providerId, env = {}, fetchPage = fetch) {
  const provider = selectedProvider(providerId);
  const key = env[provider.key];
  const headers = {};
  let url;
  if (providerId === 'openrouter') url = new URL('https://openrouter.ai/api/v1/models');
  else if (providerId === 'anthropic') {
    url = new URL('https://api.anthropic.com/v1/models?limit=1000');
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (providerId === 'google-gemini') {
    url = new URL('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    headers['x-goog-api-key'] = key;
  } else throw new Error('Use the Elpis runtime catalog for this provider.');
  if (providerId !== 'openrouter' && !key) throw new Error(`Set the ${provider.label} API key to load its models. Custom model IDs remain available.`);
  const models = new Map(), cursors = new Set();
  const signal = AbortSignal.timeout(15000);
  for (;;) {
    let response;
    try { response = await fetchPage(url.toString(), {headers, signal}); }
    catch { throw new Error(`Cannot reach the ${provider.label} model catalog.`); }
    if (!response.ok) throw new Error(`${provider.label} model catalog returned HTTP ${response.status}.`);
    let page;
    try { page = await response.json(); } catch { throw new Error(`${provider.label} returned an invalid model catalog.`); }
    const entries = providerId === 'google-gemini' ? page?.models : page?.data;
    if (!Array.isArray(entries)) throw new Error(`${provider.label} returned an invalid model catalog.`);
    for (const entry of entries) {
      if (!entry || (providerId === 'google-gemini' && !entry.supportedGenerationMethods?.includes('generateContent'))) continue;
      const model = providerId === 'google-gemini' ? (typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : '') : entry.id;
      if (typeof model !== 'string' || !model) continue;
      const name = entry.displayName || entry.display_name || entry.name;
      models.set(model, {model, label:typeof name === 'string' ? name : model, description:model});
    }
    const cursor = providerId === 'anthropic' ? (page.has_more ? page.last_id : null) : providerId === 'google-gemini' ? page.nextPageToken : null;
    if (providerId === 'anthropic' && page.has_more && !cursor) throw new Error('Anthropic returned an invalid model catalog cursor.');
    if (!cursor) return [...models.values()];
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error(`${provider.label} repeated or invalidated a model catalog page.`);
    cursors.add(cursor);
    url.searchParams.set(providerId === 'anthropic' ? 'after_id' : 'pageToken', cursor);
  }
}
module.exports = {loadProviderModels};
