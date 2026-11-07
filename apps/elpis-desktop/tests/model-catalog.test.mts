import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalogSnapshot, refreshModelCatalog, subscribeModelCatalog } from '../lib/model-catalog.ts';

// The one live model list every desktop model menu reads (lib/model-catalog.ts).
const list = (...models: string[]) => async (path: string) => { assert.equal(path, '/models?refresh=true'); return { data: models.map(model => ({ id: model, model, displayName: model })) }; };
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
    await refreshModelCatalog(async () => ({}));
    assert.match(modelCatalogSnapshot().error, /did not return a model list/);
    assert.ok(notified >= 8);
  } finally { stop(); }
});

test('the newest refresh wins over a slower older one', async () => {
  const { promise, resolve } = Promise.withResolvers<{ data: { model: string }[] }>();
  const slow = refreshModelCatalog(() => promise);
  await refreshModelCatalog(list('new'));
  resolve({ data: [{ model: 'old' }] }); await slow;
  assert.deepEqual(slugs(), ['new']);
});

test('a failed refresh tries again by itself and recovers; a newer refresh replaces the pending retry', async () => {
  await refreshModelCatalog(list('gpt-6.1-sol'));
  let reads = 0; const flaky = async (path: string) => { reads++; if (reads === 1) throw new Error('request timed out'); return list('gpt-6.1-terra')(path); };
  await refreshModelCatalog(flaky, [20]);
  assert.equal(modelCatalogSnapshot().error, 'request timed out');
  assert.deepEqual(slugs(), ['gpt-6.1-sol'], 'the last list stays while it retries');
  for (let waited = 0; reads < 2 && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, 2, 'the retry ran without anyone asking');
  assert.deepEqual(slugs(), ['gpt-6.1-terra']); assert.equal(modelCatalogSnapshot().error, '');
  let stale = 0; await refreshModelCatalog(async () => { stale++; throw new Error('down'); }, [20]);
  await refreshModelCatalog(list('gpt-6.1-luna'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(stale, 1, 'a newer refresh cancelled the pending retry');
  assert.deepEqual(slugs(), ['gpt-6.1-luna']);
});
