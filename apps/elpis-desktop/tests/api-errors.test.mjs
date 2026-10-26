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

let authCase = 0;
async function authApi(t, respond) {
  const originals = new Map(['fetch', 'location', 'history'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const requests = [], replacements = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#token=original-launch-token', pathname: '/', search: '?session=restored' } });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: (...args) => replacements.push(args) } });
  globalThis.fetch = async (url, options) => {
    const request = { url, body: options?.body && JSON.parse(options.body) }; requests.push(request);
    return respond(request, requests);
  };
  return { ...await import(`../lib/api.ts?auth-case=${++authCase}`), requests, replacements };
}
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('transient launch authentication retries once for all readers and never replays a refused action', async t => {
  for (const failure of ['network', 503]) await t.test(String(failure), async t => {
    let release;
    const f = await authApi(t, (request, requests) => {
      if (request.url !== '/api/session') return reply(200, { data: [] });
      if (requests.length === 1) { if (failure === 'network') throw Error('fixture unavailable'); return reply(failure, { error: 'Starting up' }); }
      return new Promise(resolve => { release = () => resolve(reply(200)); });
    });
    await assert.rejects(f.sessionReady(), error => f.retryableSessionError(error));
    await assert.rejects(f.api('/threads/restored/turns', { text: 'Do not replay' }), error => f.retryableSessionError(error));
    assert.equal(f.requests.length, 1, 'failed authentication prevents an unauthenticated send');
    globalThis.location.hash = '#token=changed-after-launch';
    const retry = f.sessionReady(true), concurrent = f.sessionReady(true);
    const read = f.api('/models');
    assert.deepEqual(f.requests.map(request => request.body), [{ token: 'original-launch-token' }, { token: 'original-launch-token' }]);
    release(); await Promise.all([retry, concurrent, read]);
    await f.sessionReady(true);
    assert.deepEqual(f.requests.map(request => request.url), ['/api/session', '/api/session', '/api/models'], 'recovery reads data without replaying the refused mutation');
    assert.deepEqual(f.replacements, [[null, '', '/?session=restored']], 'only successful authentication removes the token');
  });
});

test('an invalid launch token remains actionable without automatic authentication or action retries', async t => {
  const f = await authApi(t, () => reply(401, { error: 'Invalid token' }));
  const invalid = error => !f.retryableSessionError(error) && /Reopen this window/.test(error.message);
  await assert.rejects(f.sessionReady(), invalid);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(f.sessionReady(true), invalid);
  await assert.rejects(f.api('/threads/restored/turns', { text: 'Never sent' }), invalid);
  assert.equal(f.requests.length, 1);
  assert.equal(f.replacements.length, 0);
});
