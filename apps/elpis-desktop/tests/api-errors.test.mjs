import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/api.ts';

test('renderer API errors include the bridge code and request ID', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Application request failed', code: 'ELPIS_REQUEST_FAILED', requestId: 'f75cbfaa-b800-48a7-a1a8-a829067c5120' }) });
  await assert.rejects(api('/models'), /Application request failed.*ELPIS_REQUEST_FAILED.*f75cbfaa-b800-48a7-a1a8-a829067c5120/);
});

test('unknown delivery text and old bridge errors remain readable', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'The request outcome is unknown. No automatic retry was made.', code: 'ELPIS_RUNTIME_UNAVAILABLE' }) });
  await assert.rejects(api('/models'), /outcome is unknown\. No automatic retry was made\..*ELPIS_RUNTIME_UNAVAILABLE/);
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'Settings changed elsewhere' }) });
  await assert.rejects(api('/models'), { message: 'Settings changed elsewhere' });
});
