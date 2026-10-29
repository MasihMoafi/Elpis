const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const TIMEOUT_MS = 8000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization',
  'proxy-connection', 'proxy-authenticate', 'cookie', 'set-cookie', 'upgrade', 'te', 'trailer', 'keep-alive']);

/** Each protocol's model list: its query, as the gateway asks for it (codex-rs/elpis-gateway/src/catalog.rs). */
const LISTINGS = { responses: {}, chat: {}, anthropic_messages: { limit: '1000' }, gemini_generate_content: { pageSize: '1000' } };
const wireOf = definition => definition.wire_api === undefined ? 'responses' : definition.wire_api;

/** Whether the engine serves this provider through its own gateway: config/read then reports the gateway's loopback
 * address and its internal `x-elpis-` headers instead of the vendor's (codex-rs/model-provider-info/src/elpis_gateway.rs). */
export const gatewayRouted = definition => ['http_headers', 'env_http_headers'].some(field => {
  const headers = definition?.[field];
  return headers !== null && typeof headers === 'object' && Object.keys(headers).some(name => name.toLowerCase().startsWith('x-elpis-'));
});

class CatalogueError extends Error {}
const unavailable = message => new CatalogueError(message);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function endpoint(definition) {
  if (!record(definition)) throw unavailable('This connection has no valid model configuration.');
  const wire = wireOf(definition);
  if (!Object.hasOwn(LISTINGS, wire)) throw unavailable('Model browsing is not available for this connection protocol.');
  if (definition.auth != null || definition.aws != null || definition.gateway_oauth != null || definition.requires_openai_auth) {
    throw unavailable('Model browsing is not available for this connection authentication method.');
  }
  if (definition.query_params != null && (!record(definition.query_params) || Object.keys(definition.query_params).length)) {
    throw unavailable('Model browsing is not available for connections with configured query parameters.');
  }
  for (const field of ['http_headers', 'env_http_headers']) {
    const headers = definition[field];
    if (headers != null && !record(headers)) throw unavailable('This connection has invalid HTTP header configuration.');
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
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // The engine's own gateway lists the vendor's models with the key it resolves (elpis-gateway: GET /v1/models);
  // its internal token must never leave this computer.
  if (gatewayRouted(definition) && !loopback) throw unavailable('An internal gateway route must use a loopback address.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw unavailable('This connection requires HTTPS; HTTP is allowed only for a loopback address.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  if (gatewayRouted(definition)) return url.href;
  for (const [name, value] of Object.entries(LISTINGS[wire])) url.searchParams.set(name, value);
  return url.href;
}

function environmentValue(name, env) {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) throw unavailable('This connection has an invalid credential environment reference.');
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw unavailable(`Add an API key for this connection (or set ${name} for Elpis), then refresh its models.`);
  return value;
}

function requestHeaders(definition, env, savedKey) {
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
  // Native provider auth gives its explicit environment key precedence over a stored bearer; a key
  // saved in the Elpis home stands before that variable, as in the gateway (elpis-gateway/src/keys.rs).
  const token = definition.env_key != null ? savedKey || environmentValue(definition.env_key, env) : definition.experimental_bearer_token;
  if (token != null) {
    if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\x00-\x1f\x7f]/.test(token)) {
      throw unavailable('This connection has an invalid API credential.');
    }
    // Anthropic and Gemini take their keys in their own headers.
    const wire = wireOf(definition);
    if (wire === 'anthropic_messages') { set('x-api-key', token.trim()); set('anthropic-version', '2023-06-01'); }
    else if (wire === 'gemini_generate_content') set('x-goog-api-key', token.trim());
    else set('authorization', `Bearer ${token.trim()}`);
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

/** Gemini lists `{models: [{name: "models/…", displayName, inputTokenLimit, supportedGenerationMethods}]}`. */
function geminiRows(catalogue) {
  if (!record(catalogue) || !Array.isArray(catalogue.models)) throw unavailable('This connection did not return a Gemini model list.');
  return catalogue.models.filter(row => record(row) && Array.isArray(row.supportedGenerationMethods) && row.supportedGenerationMethods.includes('generateContent') && typeof row.name === 'string')
    .map(row => ({ id: row.name.replace(/^models\//, ''), name: row.displayName, context_length: row.inputTokenLimit }));
}

/** The gateway answers in the engine's own catalogue shape: `{models: [{slug, display_name, context_window}]}`. */
function gatewayRows(catalogue) {
  if (!record(catalogue) || !Array.isArray(catalogue.models)) throw unavailable('The Elpis gateway did not return a model list.');
  return catalogue.models.filter(record).map(row => ({ id: row.slug, display_name: row.display_name, context_window: row.context_window }));
}

function choices(catalogue, wire = 'responses', inputModality, outputModality) {
  if (wire === 'gemini_generate_content') catalogue = { data: geminiRows(catalogue) };
  if (wire === 'gateway') catalogue = { data: gatewayRows(catalogue) };
  if (!record(catalogue) || !Array.isArray(catalogue.data)) throw unavailable('This connection did not return an OpenAI-compatible model list.');
  if (catalogue.data.length > MAX_ROWS) throw unavailable('This connection returned too many models (maximum 2000).');
  const seen = new Set();
  const data = [];
  for (const row of catalogue.data) {
    if (!record(row) || typeof row.id !== 'string' || !MODEL_ID.test(row.id) || /^(claude|agy|antigravity)\//i.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    const inputModalities = Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities.filter(value => typeof value === 'string') : null;
    // Agent models need tools; transcription models only need to accept audio.
    // Rerankers are listed by what they output and need no tools.
    if (!outputModality && (inputModality ? !inputModalities?.includes(inputModality) : Array.isArray(row.supported_parameters) && !row.supported_parameters.includes('tools'))) continue;
    const displayName = [row.name, row.display_name, row.displayName].map(value => label(value, 200)).find(Boolean) || row.id;
    const context = [row.context_length, row.context_window, row.max_context_length, row.max_input_tokens].find(value => Number.isSafeInteger(value) && value > 0);
    const description = context ? `≈${Math.round(context / 1000)}k context` : label(row.description, 1000);
    data.push({ id: row.id, model: row.id, displayName, ...(description ? { description } : {}), ...(inputModalities ? { architecture: { input_modalities: inputModalities } } : {}) });
  }
  if (!inputModality && catalogue.data.length && !data.length) throw unavailable('This connection did not return any supported model IDs.');
  return { data, nextCursor: null };
}

/** OpenRouter ranks the models most used for programming (`?category=programming`); those lead the list, marked,
 * and the rest follow newest first. Without the ranking the plain list still stands. */
async function codingFirst(models, url, headers, fetchImpl, signal) {
  try {
    const ranked = new URL(url); ranked.searchParams.set('category', 'programming');
    const response = await withAbort(fetchImpl(ranked.href, { method: 'GET', headers, redirect: 'error', signal }), signal);
    if (!response.ok || response.redirected) { cancelBody(response); return models; }
    const order = choices(await readCatalogue(response, signal)).data.map(row => row.id);
    const top = order.flatMap((id, index) => { const row = models.find(model => model.id === id); return row ? [{ ...row, description: [`Top for coding #${index + 1}`, row.description].filter(Boolean).join(' · ') }] : []; });
    return [...top, ...models.filter(model => !order.includes(model.id))];
  } catch { return models; }
}

/** List one server-owned configured OpenAI-compatible connection; never changes configuration or resolves external auth. */
export async function providerModels(definition, { env = process.env, fetchImpl = fetch, signal, savedKey = null, inputModality, outputModality } = {}) {
  const listing = new URL(endpoint(definition));
  // OpenRouter lists its rerankers apart: GET /models?output_modalities=rerank (29 Oct, Masih: "we want real call and showing of real options").
  if (outputModality) listing.searchParams.set('output_modalities', outputModality);
  const url = listing.href;
  const gateway = gatewayRouted(definition);
  // Through the gateway only its own headers go along; it adds the vendor key itself.
  const headers = gateway ? requestHeaders({ ...definition, env_key: null, experimental_bearer_token: null }, env, null) : requestHeaders(definition, env, savedKey);
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
    const listed = choices(await readCatalogue(response, requestSignal), gateway ? 'gateway' : wireOf(definition), inputModality, outputModality);
    return !inputModality && !outputModality && new URL(url).hostname === 'openrouter.ai' ? { ...listed, data: await codingFirst(listed.data, url, headers, fetchImpl, requestSignal) } : listed;
  } catch (error) {
    if (signal?.aborted) throw unavailable('Model loading was cancelled.');
    if (timeout.signal.aborted) throw unavailable('The connection took too long to list models. Try again.');
    if (error instanceof CatalogueError) throw error;
    throw unavailable('Could not load models from this connection. Check its address and try again.');
  } finally { clearTimeout(timer); }
}
