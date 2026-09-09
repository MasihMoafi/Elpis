const test = require('node:test');
const assert = require('node:assert/strict');
const {modelChoices} = require('../src/providers');
const {loadProviderModels} = require('../src/provider-catalog');
const ok = body => ({ok:true, json:async()=>body});

test('every provider uses its returned catalog instead of bundled suggestions', () => {
  for (const provider of ['openrouter', 'anthropic', 'google-gemini']) {
    const choices = modelChoices(provider, '', [{label:'New server model',model:'catalog-only-sentinel'}]);
    assert.deepEqual(choices.filter(x=>!x.custom).map(x=>x.model), ['catalog-only-sentinel']);
    assert.equal(modelChoices(provider, '').filter(x=>!x.custom).length, 0);
  }
});

test('public OpenRouter catalog sends no credentials', async () => {
  const catalog = await loadProviderModels('openrouter', {OPENROUTER_API_KEY:'secret'}, async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.deepEqual(options.headers, {});
    return ok({data:[{id:'vendor/new',name:'New model'}, {id:'vendor/new'}, null]});
  });
  assert.deepEqual(catalog.map(x=>x.model), ['vendor/new']);
});

test('Anthropic pages using its own key', async () => {
  let calls = 0;
  const catalog = await loadProviderModels('anthropic', {ANTHROPIC_API_KEY:'secret'}, async (url, options) => {
    assert.equal(options.headers['x-api-key'], 'secret');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert(!url.includes('secret'));
    if (++calls === 1) return ok({data:[{id:'first',display_name:'First'}],has_more:true,last_id:'first'});
    assert.equal(new URL(url).searchParams.get('after_id'), 'first');
    return ok({data:[{id:'second'}],has_more:false});
  });
  assert.deepEqual(catalog.map(x=>x.model), ['first','second']);
});

test('Gemini pages and excludes embedding-only models', async () => {
  let calls = 0;
  const catalog = await loadProviderModels('google-gemini', {GEMINI_API_KEY:'secret'}, async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'secret');
    if (++calls === 1) return ok({models:[{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'next'});
    assert.equal(new URL(url).searchParams.get('pageToken'), 'next');
    return ok({models:[{name:'models/new-gemini',displayName:'New Gemini',supportedGenerationMethods:['generateContent']}]});
  });
  assert.deepEqual(catalog.map(x=>x.model), ['new-gemini']);
});

test('errors are explicit, redact secrets, and do not substitute stale models', async () => {
  await assert.rejects(loadProviderModels('anthropic', {}, ()=>assert.fail('must not request')), /API key/);
  await assert.rejects(loadProviderModels('openrouter', {}, async()=>({ok:false,status:401})), /HTTP 401/);
  await assert.rejects(loadProviderModels('openrouter', {}, async()=>{throw new Error('secret');}), /^Error: Cannot reach the OpenRouter model catalog\.$/);
  await assert.rejects(loadProviderModels('openrouter', {}, async()=>ok({wrong:[]})), /invalid model catalog/);
  await assert.rejects(loadProviderModels('anthropic', {ANTHROPIC_API_KEY:'secret'}, async()=>ok({data:[],has_more:true,last_id:'repeat'})), /repeated/);
  assert.deepEqual(modelChoices('anthropic','private-id').filter(x=>!x.custom).map(x=>x.model), ['private-id']);
});
