const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const TIMEOUT_MS = 8000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization',
  'proxy-connection', 'proxy-authenticate', 'cookie', 'set-cookie', 'upgrade', 'te', 'trailer', 'keep-alive']);

class CatalogueError extends Error {}
const unavailable = message => new CatalogueError(message);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function endpoint(definition) {
  if (!record(definition)) throw unavailable('This connection has no valid model configuration.');
  const wire = definition.wire_api === undefined ? 'responses' : definition.wire_api;
  if (!['responses', 'chat'].includes(wire)) throw unavailable('Model browsing is not available for this connection protocol.');
  if (definition.auth != null || definition.aws != null || definition.gateway_oauth != null || definition.requires_openai_auth) {
    throw unavailable('Model browsing is not available for this connection authentication method.');
  }
  if (definition.query_params != null && (!record(definition.query_params) || Object.keys(definition.query_params).length)) {
    throw unavailable('Model browsing is not available for connections with configured query parameters.');
  }
  for (const field of ['http_headers', 'env_http_headers']) {
    const headers = definition[field];
    if (headers != null && !record(headers)) throw unavailable('This connection has invalid HTTP header configuration.');
    if (headers && Object.keys(headers).some(name => name.toLowerCase().startsWith('x-elpis-'))) {
      throw unavailable('Model browsing is not available through an internal provider gateway.');
    }
  }
  const input = typeof definition.base_url === 'string' ? definition.base_url.trim() : '';
  if (!/^https?:\/\/[^/\\\s]/i.test(input) || /[\x00-\x20\x7f\\?#]/.test(input)) {
    throw unavailable('This connection needs a valid API base URL without credentials, query parameters or fragments.');
  }
  let url;
  try { url = new URL(input); }
  catch { throw unavailable('This connection has an invalid API base URL.'); }
  const authority = input.slice(input.indexOf('://') + 3).split('/')[0];
  if (url.username || url.password || authority.includes('@')) throw unavailable('API base URLs cannot contain credentials.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw unavailable('This connection requires HTTPS; HTTP is allowed only for a loopback address.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url.href;
}

function environmentValue(name, env) {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) throw unavailable('This connection has an invalid credential environment reference.');
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw unavailable(`Set ${name} for Elpis, then refresh this connection's models.`);
  return value;
}

function requestHeaders(definition, env) {
  const headers = new Headers({ accept: 'application/json' });
  function set(name, value) {
    if (!HEADER_NAME.test(name) || BLOCKED_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('sec-')
      || typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
      throw unavailable('This connection has an invalid or unsupported HTTP header.');
    }
    try { headers.set(name, value); }
    catch { throw unavailable('This connection has an invalid HTTP header.'); }
  }
  for (const [name, value] of Object.entries(definition.http_headers || {})) set(name, value);
  for (const [name, variable] of Object.entries(definition.env_http_headers || {})) set(name, environmentValue(variable, env));
  // Native provider auth gives its explicit environment key precedence over a stored bearer.
  const token = definition.env_key != null ? environmentValue(definition.env_key, env) : definition.experimental_bearer_token;
  if (token != null) {
    if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\x00-\x1f\x7f]/.test(token)) {
      throw unavailable('This connection has an invalid API credential.');
    }
    set('authorization', `Bearer ${token.trim()}`);
  }
  return headers;
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(Error('Request aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function cancelBody(response) {
  try { response.body?.cancel().catch(() => {}); } catch { /* The failed response is never consumed. */ }
}

async function readCatalogue(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
    cancelBody(response); throw unavailable('The model list is too large (maximum 2 MiB).');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw unavailable('This connection returned no valid model list.');
  const reader = response.body.getReader();
  const body = new Uint8Array(MAX_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw unavailable('This connection returned an invalid model list.');
      if (bytes + value.byteLength > MAX_BYTES) throw unavailable('The model list is too large (maximum 2 MiB).');
      body.set(value, bytes);
      bytes += value.byteLength;
    }
  } catch (error) {
    try { reader.cancel().catch(() => {}); } catch { /* The failed stream is never consumed. */ }
    throw error;
  } finally { try { reader.releaseLock(); } catch { /* Cancellation may still be finishing. */ } }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes))); }
  catch { throw unavailable('This connection did not return a valid JSON model list.'); }
}

function label(value, length) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, length) : '';
}

function choices(catalogue) {
  if (!record(catalogue) || !Array.isArray(catalogue.data)) throw unavailable('This connection did not return an OpenAI-compatible model list.');
  if (catalogue.data.length > MAX_ROWS) throw unavailable('This connection returned too many models (maximum 2000).');
  const seen = new Set();
  const data = [];
  for (const row of catalogue.data) {
    if (!record(row) || typeof row.id !== 'string' || !MODEL_ID.test(row.id) || /^(claude|agy|antigravity)\//i.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    const displayName = [row.name, row.display_name, row.displayName].map(value => label(value, 200)).find(Boolean) || row.id;
    const description = label(row.description, 1000);
    data.push({ id: row.id, model: row.id, displayName, ...(description ? { description } : {}) });
  }
  if (catalogue.data.length && !data.length) throw unavailable('This connection did not return any supported model IDs.');
  return { data, nextCursor: null };
}

/** List one server-owned configured OpenAI-compatible connection; never changes configuration or resolves external auth. */
export async function providerModels(definition, { env = process.env, fetchImpl = fetch, signal } = {}) {
  const url = endpoint(definition);
  const headers = requestHeaders(definition, env);
  if (signal?.aborted) throw unavailable('Model loading was cancelled.');
  const timeout = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await withAbort(fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: requestSignal }), requestSignal);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response); throw unavailable('This connection tried to redirect its model request. Redirects are not supported.');
    }
    if (!response.ok) {
      cancelBody(response);
      if ([401, 403].includes(response.status)) throw unavailable('Access to this model list was denied. Check the connection API key.');
      if (response.status === 404) throw unavailable('This connection does not offer a compatible models endpoint.');
      if (response.status === 429) throw unavailable('This connection is rate limiting model requests. Try again later.');
      throw unavailable(`This connection could not list models (HTTP ${Number.isInteger(response.status) ? response.status : 'error'}).`);
    }
    return choices(await readCatalogue(response, requestSignal));
  } catch (error) {
    if (signal?.aborted) throw unavailable('Model loading was cancelled.');
    if (timeout.signal.aborted) throw unavailable('The connection took too long to list models. Try again.');
    if (error instanceof CatalogueError) throw error;
    throw unavailable('Could not load models from this connection. Check its address and try again.');
  } finally { clearTimeout(timer); }
}
