import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalogSnapshot, refreshModelCatalog, subscribeModelCatalog } from '../lib/model-catalog.ts';

// The one live model list every desktop model menu reads (lib/model-catalog.ts).
const list = (...models) => async path => { assert.equal(path, '/models?refresh=true'); return { data: models.map(model => ({ id: model, model, displayName: model })) }; };
const slugs = () => modelCatalogSnapshot().models.map(item => item.model);

test('each refresh asks for the live list; a new model appears and a failure keeps the last list', async () => {
  let notified = 0; const stop = subscribeModelCatalog(() => notified++);
  try {
    await refreshModelCatalog(list('gpt-6.1-sol'));
    assert.deepEqual(slugs(), ['gpt-6.1-sol']);
    await refreshModelCatalog(list('gpt-6.1-sol', 'gpt-6.1-terra'));
    assert.deepEqual(slugs(), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    assert.equal(modelCatalogSnapshot().error, '');
    await refreshModelCatalog(async () => { throw new Error('network down'); });
    assert.deepEqual(slugs(), ['gpt-6.1-sol', 'gpt-6.1-terra'], 'the last list stays');
    assert.equal(modelCatalogSnapshot().error, 'network down');
    assert.equal(modelCatalogSnapshot().loading, false);
    await refreshModelCatalog(async () => ({ nothing: true }));
    assert.match(modelCatalogSnapshot().error, /did not return a model list/);
    assert.ok(notified >= 8);
  } finally { stop(); }
});

test('the newest refresh wins over a slower older one', async () => {
  let release; const slow = refreshModelCatalog(() => new Promise(resolve => { release = () => resolve({ data: [{ model: 'old' }] }); }));
  await refreshModelCatalog(list('new'));
  release(); await slow;
  assert.deepEqual(slugs(), ['new']);
});
