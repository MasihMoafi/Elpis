import test from 'node:test';
import assert from 'node:assert/strict';
import { providerModels } from './provider-models.mjs';

const json = (value, init = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const listed = () => json({ data: [{ id: 'gpt-oss:20b', name: 'GPT OSS 20B' }] });
const local = { base_url: 'http://127.0.0.1:1234/v1', wire_api: 'responses' };

test('configured local connection determines the endpoint and exact selected model values', async () => {
  let calls = 0;
  const result = await providerModels({ ...local, base_url: `${local.base_url}/` }, { env: {}, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:1234/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('accept'), 'application/json');
    assert.equal(options.headers.has('authorization'), false);
    assert(options.signal instanceof AbortSignal);
    return json({ data: [
      { id: 'gpt-oss:20b', name: 'GPT OSS 20B', description: 'Local model' },
      { id: 'gpt-oss:20b', name: 'Duplicate entry' },
      { id: 'org/model', display_name: 'Readable provider name' },
      { id: 'second-model', displayName: 'Second model' },
      { id: 'id-only' }, { id: 'bad model id' }, { id: 'claude/opus' }, null, 'not a model',
    ] });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { data: [
    { id: 'gpt-oss:20b', model: 'gpt-oss:20b', displayName: 'GPT OSS 20B', description: 'Local model' },
    { id: 'org/model', model: 'org/model', displayName: 'Readable provider name' },
    { id: 'second-model', model: 'second-model', displayName: 'Second model' },
    { id: 'id-only', model: 'id-only', displayName: 'id-only' },
  ], nextCursor: null });
});

test('hosted connection uses configured headers and the referenced API key before a stored token', async () => {
  const definition = { base_url: 'https://openrouter.ai/api/v1', wire_api: 'chat', env_key: 'PROVIDER_KEY',
    experimental_bearer_token: 'unused-stored-secret', http_headers: { 'HTTP-Referer': 'https://elpis.example', 'X-Title': 'Elpis', Authorization: 'Bearer lower-priority-secret' },
    env_http_headers: { 'X-Organization': 'PROVIDER_ORG' } };
  const result = await providerModels(definition, { env: { PROVIDER_KEY: 'environment-secret', PROVIDER_ORG: 'selected-team' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.equal(options.headers.get('authorization'), 'Bearer environment-secret');
    assert.equal(options.headers.get('http-referer'), 'https://elpis.example');
    assert.equal(options.headers.get('x-title'), 'Elpis');
    assert.equal(options.headers.get('x-organization'), 'selected-team');
    return listed();
  } });
  assert(!JSON.stringify(result).includes('secret'));
});

test('stored keys work without an environment reference and IPv6 loopback remains local', async () => {
  await providerModels({ base_url: 'http://[::1]:11434/v1', experimental_bearer_token: 'stored-secret' }, { env: {}, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://[::1]:11434/v1/models');
    assert.equal(options.headers.get('authorization'), 'Bearer stored-secret');
    return listed();
  } });
  await providerModels({ base_url: 'http://localhost:11434/v1' }, { env: {}, fetchImpl: async (url) => {
    assert.equal(url, 'http://localhost:11434/v1/models'); return listed();
  } });
});

test('missing referenced keys and unsupported authentication stop before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return listed(); };
  await assert.rejects(providerModels({ ...local, env_key: 'MISSING_KEY', experimental_bearer_token: 'do-not-fallback' }, { env: {}, fetchImpl }), /MISSING_KEY/);
  await assert.rejects(providerModels({ ...local, env_http_headers: { 'X-Organization': 'MISSING_ORG' } }, { env: {}, fetchImpl }), /MISSING_ORG/);
  for (const extra of [{ auth: { command: ['never-run-this'] } }, { aws: {} }, { gateway_oauth: {} }, { requires_openai_auth: true },
    { wire_api: 'anthropic_messages' }, { wire_api: 'gemini_generate_content' }, { query_params: { 'api-version': 'required' } },
    { http_headers: { 'x-elpis-gateway-token': 'internal-secret' } }]) {
    await assert.rejects(providerModels({ ...local, ...extra }, { env: {}, fetchImpl }), /not available|not supported|unsupported/i);
  }
  assert.equal(calls, 0);
});

test('invalid URLs and unsafe headers cannot alter the connection or leak credentials', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return listed(); };
  for (const base_url of ['', 'not a URL', 'file:///tmp/models', 'http://example.com/v1', 'http://127.0.0.2/v1',
    'https://user:private-secret@example.com/v1', 'https://@example.com/v1', 'https://example.com/v1?key=private-secret',
    'https://example.com/v1#fragment', 'https://example.com/v1?', 'https:\\example.com\\v1', 'https://example.com/\nmodels']) {
    await assert.rejects(providerModels({ ...local, base_url }, { env: {}, fetchImpl }), error => {
      assert(!error.message.includes('private-secret')); return /address|URL|HTTPS|loopback/i.test(error.message);
    });
  }
  for (const extra of [{ http_headers: { Host: 'other.example' } }, { http_headers: { Cookie: 'private-secret' } },
    { http_headers: { 'X-Test': 'private-secret\r\nInjected: value' } }, { env_key: '../secret' },
    { experimental_bearer_token: 'private-secret\n' }, { http_headers: [] }]) {
    await assert.rejects(providerModels({ ...local, ...extra }, { env: {}, fetchImpl }), error => {
      assert(!error.message.includes('private-secret')); return /header|credential|environment/i.test(error.message);
    });
  }
  assert.equal(calls, 0);
});

test('non-OK and redirected responses never return upstream bodies or silently follow a redirect', async () => {
  for (const [status, pattern] of [[401, /key|access|authentication/i], [403, /key|access|authentication/i], [404, /models endpoint/i],
    [429, /rate|later/i], [500, /HTTP 500/], [302, /redirect/i]]) {
    await assert.rejects(providerModels(local, { fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error'); return new Response('private-secret upstream body', { status });
    } }), error => { assert(!error.message.includes('private-secret')); return pattern.test(error.message); });
  }
  await assert.rejects(providerModels(local, { fetchImpl: async () => ({ ok: true, status: 200, redirected: true }) }), /redirect/i);
  await assert.rejects(providerModels(local, { fetchImpl: async () => { throw Error('private-secret at https://user:pass@example.com'); } }), error => {
    assert(!/private-secret|example\.com|user:pass/.test(error.message)); return /could not|unavailable|connect/i.test(error.message);
  });
});

test('malformed catalogues and excessive row counts produce clear unavailable errors', async () => {
  for (const body of ['not JSON', 'null', '[]', '{}', '{"data":{}}']) {
    await assert.rejects(providerModels(local, { fetchImpl: async () => new Response(body) }), /valid|compatible|model list/i);
  }
  await assert.rejects(providerModels(local, { fetchImpl: async () => json({ data: Array.from({ length: 2001 }, (_, i) => ({ id: `model-${i}` })) }) }), /too many|2000/i);
  await assert.rejects(providerModels(local, { fetchImpl: async () => json({ data: [{ id: 'not supported here' }] }) }), /supported model/i);
  assert.deepEqual(await providerModels(local, { fetchImpl: async () => json({ data: [] }) }), { data: [], nextCursor: null });
});

test('streamed size limits apply with or without an honest Content-Length', async () => {
  let cancelled = 0;
  const huge = () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled++; } });
  await assert.rejects(providerModels(local, { fetchImpl: async () => new Response(huge()) }), /too large|2 MiB/i);
  await assert.rejects(providerModels(local, { fetchImpl: async () => new Response(huge(), { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) }), /too large|2 MiB/i);
  assert.equal(cancelled, 2);
});

test('caller cancellation interrupts a pending fetch or response body', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(providerModels(local, { signal: before.signal, fetchImpl: async () => { calls++; return listed(); } }), /cancel/i);
  assert.equal(calls, 0);
  const during = new AbortController();
  const request = providerModels(local, { signal: during.signal, fetchImpl: () => new Promise(() => {}) });
  during.abort();
  await assert.rejects(request, /cancel/i);
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const body = new AbortController();
  const loading = providerModels(local, { signal: body.signal, fetchImpl: async () => new Response(new ReadableStream({ pull() { reading(); } })) });
  await started; body.abort();
  await assert.rejects(loading, /cancel/i);
});

test('the complete request has an eight-second timeout even if the fetch implementation does not reject', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loading = providerModels(local, { fetchImpl: () => new Promise(() => {}) });
  t.mock.timers.tick(8000);
  await assert.rejects(loading, /timed out|too long/i);
});

test('the timeout also bounds a response body that never finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const loading = providerModels(local, { fetchImpl: async () => new Response(new ReadableStream({ pull() { reading(); } })) });
  await started;
  t.mock.timers.tick(8000);
  await assert.rejects(loading, /timed out|too long/i);
});
