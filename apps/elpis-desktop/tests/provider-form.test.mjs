import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFormId } from '../lib/provider-form.ts';
import { providerEdits } from '../bridge/provider-settings.mjs';

const valid = id => assert.match(id, /^[a-z][a-z0-9_-]{0,63}$/);

test('known connections generate their own internal identity without an ID field', () => {
  assert.equal(providerFormId({ type: 'openrouter', name: 'OpenRouter' }, []), 'openrouter');
  valid(providerFormId({ type: 'local', name: 'Local server' }, []));
});

test('custom names become bounded valid internal keys while names stay untouched', () => {
  const identity = { type: 'custom', name: 'Café Research 2' };
  assert.equal(providerFormId(identity, []), 'api-cafe-research-2');
  assert.equal(identity.name, 'Café Research 2');
  const long = { type: 'custom', name: 'Research '.repeat(30) };
  const first = providerFormId(long, []), second = providerFormId(long, [first]);
  valid(first); valid(second); assert.notEqual(first, second); assert.match(second, /-2$/);
});

test('creating a connection never selects an existing or reserved account identity', () => {
  for (const name of ['openai', 'claude', 'agy', 'antigravity']) {
    const id = providerFormId({ type: 'custom', name }, []);
    valid(id); assert.notEqual(id, name);
  }
  const occupied = ['local', 'local-2', 'local-3'];
  assert.equal(providerFormId({ type: 'local', name: 'Local' }, occupied), 'local-4');
  assert.deepEqual(occupied, ['local', 'local-2', 'local-3']);
  assert.equal(providerFormId({ type: 'custom', name: 'Research' }, ['API-RESEARCH']), 'api-research-2');
});

test('non-Latin or punctuation-only display names still receive a valid unique internal key', () => {
  for (const name of ['پژوهش کتاب', '!!!', '  ']) {
    const first = providerFormId({ type: 'custom', name }, []);
    valid(first); valid(providerFormId({ type: 'custom', name }, [first]));
    assert.notEqual(providerFormId({ type: 'custom', name }, [first]), first);
  }
});

test('editing retains the existing identity even when its name or type changes', () => {
  assert.equal(providerFormId({ type: 'custom', name: 'Renamed research server', existingId: 'ollama' }, ['ollama']), 'ollama');
  assert.equal(providerFormId({ type: 'openrouter', name: 'Different display name', existingId: 'my-original-api' }, ['my-original-api']), 'my-original-api');
});

test('retry after a refreshed configuration generates a new free key instead of overwriting the competing connection', () => {
  const identity = { type: 'custom', name: 'Research' };
  const versionOneIds = ['api-old'];
  const first = providerFormId(identity, versionOneIds);
  const refreshedIds = [...versionOneIds, first];
  const retry = providerFormId(identity, refreshedIds);
  assert(!refreshedIds.includes(retry)); assert.equal(retry, `${first}-2`);
});

test('generated IDs pass the actual provider writer while stale versions leave form credentials intact', () => {
  const draft = { type: 'custom', name: 'Research', baseUrl: 'https://example.invalid/v1', secret: 'fixture-only-key' };
  const current = { version: 'v2', write: { available: true }, providers: [{ id: 'api-research', editable: true }] };
  const body = { version: 'v1', id: providerFormId(draft, current.providers.map(provider => provider.id)), name: draft.name,
    baseUrl: draft.baseUrl, credential: { action: 'replace', value: draft.secret } };
  assert.throws(() => providerEdits(body, current), /changed in another client/);
  assert.equal(draft.secret, 'fixture-only-key'); assert.equal(body.credential.value, 'fixture-only-key');
  const edits = providerEdits({ ...body, version: current.version }, current);
  assert.equal(body.id, 'api-research-2');
  assert(edits.every(edit => edit.keyPath.startsWith('model_providers.api-research-2.')));
  assert.deepEqual(current.providers, [{ id: 'api-research', editable: true }]);
});

test('editing keeps the original writer target and preserving a credential writes no key replacement', () => {
  const current = { version: 'v1', write: { available: true }, providers: [{ id: 'ollama', editable: true }] };
  const id = providerFormId({ type: 'custom', name: 'New visible name', existingId: 'ollama' }, ['ollama']);
  const edits = providerEdits({ version: current.version, id, name: 'New visible name', baseUrl: 'http://127.0.0.1:11434/v1', credential: { action: 'preserve' } }, current);
  assert(edits.every(edit => edit.keyPath.startsWith('model_providers.ollama.')));
  assert(!edits.some(edit => /experimental_bearer_token|env_key/.test(edit.keyPath)));
});
