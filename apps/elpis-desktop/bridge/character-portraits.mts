import { providerModels, providerRequest } from './provider-models.mts';
import { BridgeError } from './validate.mts';
import { imageMime } from './attachments.mts';
import { characterImage, portraitDataUrl } from './character-image.mts';
import { CHARACTER_LIMITS, type PortraitSource, type PortraitSources } from '../lib/custom-character-types.mts';

/** Private connection data. Only PortraitSource, which has no credentials or endpoint, goes to the renderer. */
export type PortraitConnection = { id: string; name: string; definition: Record<string, unknown>; savedKey?: string | null; nativeModel?: string };
type Options = { fetchImpl?: typeof fetch; signal?: AbortSignal; sourceId?: string; native?: (source: PortraitSource, prompt: string, signal: AbortSignal) => Promise<string> };
const MAX_RESPONSE = Math.ceil(CHARACTER_LIMITS.imageBytes / 3) * 4 + 128 * 1024;
const sourceId = (provider: string, model: string) => `${provider}:${encodeURIComponent(model)}`;

function reason(error: unknown) { return error instanceof Error ? error.message : 'Image generation failed.'; }
function safeReason(message: string, connection: PortraitConnection) {
  const secrets = [connection.savedKey, connection.definition.experimental_bearer_token,
    ...Object.values(connection.definition.http_headers as Record<string, unknown> ?? {}),
    ...Object.values(connection.definition.env_http_headers as Record<string, unknown> ?? {}).map(key => typeof key === 'string' ? process.env[key] : null),
    typeof connection.definition.env_key === 'string' ? process.env[connection.definition.env_key] : null];
  let safe = message;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 3) safe = safe.replaceAll(secret, '[credential]');
  return safe.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
}

/** Catalogues decide the model IDs. Native sign-in leads, followed by the configured connections in their saved order. */
export async function discoverPortraitSources(connections: PortraitConnection[], { fetchImpl = fetch, signal }: Options = {}): Promise<PortraitSources> {
  const sources: PortraitSource[] = [], unavailable: string[] = [];
  for (const connection of connections.slice(0, 24)) {
    signal?.throwIfAborted();
    if (connection.nativeModel) {
      sources.push({ id: sourceId(connection.id, connection.nativeModel), provider: connection.id, model: connection.nativeModel, label: connection.name });
      continue;
    }
    try {
      const listed = await providerModels(connection.definition, { fetchImpl, savedKey: connection.savedKey ?? null, outputModality: 'image', ...(signal ? { signal } : {}) });
      sources.push(...listed.data.slice(0, 50).map(model => ({ id: sourceId(connection.id, model.id), provider: connection.id, model: model.id, label: `${connection.name} · ${model.displayName}` })));
    } catch (error) {
      signal?.throwIfAborted();
      unavailable.push(`${connection.name}: ${safeReason(reason(error), connection)}`);
    }
  }
  return { sources, unavailable };
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body) {
    await response.body?.cancel(); throw new BridgeError('Image provider response is empty or too large.', 502);
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new BridgeError('Image provider response is too large.', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new BridgeError('Image provider returned invalid JSON.', 502); }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function imageFrom(answer: Record<string, unknown>) {
  if (Array.isArray(answer.data)) {
    const first = record(answer.data[0]);
    if (typeof first.b64_json === 'string') {
      const bytes = Buffer.from(first.b64_json, 'base64'), mime = imageMime(bytes);
      if (mime) return `data:${mime};base64,${first.b64_json}`;
    }
  }
  if (Array.isArray(answer.candidates)) for (const candidate of answer.candidates) {
    const parts = record(record(candidate).content).parts;
    if (Array.isArray(parts)) for (const part of parts) {
      const inline = record(record(part).inlineData ?? record(part).inline_data);
      if (typeof inline.data === 'string' && typeof inline.mimeType === 'string') return `data:${inline.mimeType};base64,${inline.data}`;
    }
  }
  if (Array.isArray(answer.predictions)) {
    const prediction = record(answer.predictions[0]);
    if (typeof prediction.bytesBase64Encoded === 'string') return `data:${typeof prediction.mimeType === 'string' ? prediction.mimeType : 'image/png'};base64,${prediction.bytesBase64Encoded}`;
  }
  if (Array.isArray(answer.choices)) {
    const images = record(record(answer.choices[0]).message).images;
    if (Array.isArray(images)) {
      const url = record(record(images[0]).image_url).url;
      if (typeof url === 'string' && url.startsWith('data:')) return url;
    }
  }
  // Never fetch provider-supplied URLs: only inline bytes enter the private portrait decoder.
  throw new BridgeError('Image provider returned no inline portrait. Choose another source or an image file.', 502);
}

async function fromConnection(connection: PortraitConnection, source: PortraitSource, prompt: string, fetchImpl: typeof fetch, signal: AbortSignal) {
  const { modelsUrl, headers } = providerRequest(connection.definition, { savedKey: connection.savedKey ?? null });
  const base = new URL(modelsUrl); base.search = ''; base.pathname = base.pathname.replace(/\/models$/, '');
  const gemini = connection.definition.wire_api === 'gemini_generate_content', imagen = gemini && /(?:^|\/)imagen[\w.-]*/i.test(source.model);
  const openrouter = base.hostname === 'openrouter.ai';
  let payload: Record<string, unknown>;
  if (gemini) {
    base.pathname += `/models/${encodeURIComponent(source.model)}:${imagen ? 'predict' : 'generateContent'}`;
    payload = imagen ? { instances: [{ prompt }], parameters: { sampleCount: 1 } }
      : { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } };
  } else {
    base.pathname += openrouter ? '/images' : '/images/generations';
    payload = { model: source.model, prompt, n: 1, ...(openrouter ? { output_format: 'png' } : /(?:^|\/)gpt-image/.test(source.model) ? {} : { response_format: 'b64_json' }) };
  }
  headers.set('content-type', 'application/json');
  const response = await fetchImpl(base.href, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal });
  const answer = await boundedJson(response, signal);
  if (!response.ok) {
    const detail = record(answer.error);
    throw new BridgeError(`Image provider failed (HTTP ${response.status})${typeof detail.message === 'string' ? `: ${safeReason(detail.message, connection)}` : '.'}`, 502);
  }
  return imageFrom(answer);
}

/** Automatic fallback uses each route once. Explicit choice moves it to the front; Stop ends all work. */
export async function generatePortrait(description: string, sources: PortraitSource[], connections: PortraitConnection[], { fetchImpl = fetch, signal, sourceId: chosen, native }: Options = {}) {
  if (chosen && !sources.some(source => source.id === chosen)) throw new BridgeError('That image source is no longer available. Refresh the sources.');
  if (!sources.length) throw new BridgeError('No image generation source is available. Add a connection in Settings → Models & accounts, choose a built-in portrait, or choose an image file.', 409);
  const ordered = chosen ? [...sources.filter(source => source.id === chosen), ...sources.filter(source => source.id !== chosen)] : sources;
  const warnings: string[] = [];
  const prompt = `Create one character portrait for a small desktop companion. Crisp 32-bit era pixel art, clearly visible square pixel clusters, limited colours, careful dithering, expressive head and shoulders facing the viewer. Centered square composition, uncluttered background. No writing, borders, logos or watermark. The portrait must read on both dark and light surfaces. Character description:\n${description}`;
  for (const source of ordered) {
    signal?.throwIfAborted();
    const connection = connections.find(item => item.id === source.provider);
    if (!connection) continue;
    const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    try {
      const image = connection.nativeModel && native ? await native(source, prompt, attemptSignal) : await fromConnection(connection, source, prompt, fetchImpl, attemptSignal);
      attemptSignal.throwIfAborted();
      return { image: portraitDataUrl(await characterImage(image)), source, warnings };
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`${source.label}: ${safeReason(attemptSignal.aborted ? 'Image generation timed out.' : reason(error), connection)}`);
    }
  }
  throw new BridgeError(warnings.join('\n').slice(0, 2000) || 'No image source could generate a portrait.', 502);
}
