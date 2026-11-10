import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCharacters } from './custom-characters.mts';
import { discoverPortraitSources, generatePortrait } from './character-portraits.mts';
import { CHARACTER_LIMITS } from '../lib/custom-character-types.mts';

const image = async () => `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 4, background: '#7c5cbf' } }).png().toBuffer()).toString('base64')}`;
const draft = { name: 'Lyra', description: 'A patient astronomer', personality: 'Ask one clear question. Explain through stars.', themeId: null, portrait: { builtin: 'palette-violet' } };

test('characters persist private, bounded local portraits and delete without accepting arbitrary paths', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-character-store-'));
  try {
    const store = createCharacters(home);
    assert.deepEqual(await store.list(), []);
    const saved = await store.save({ ...draft, portrait: { dataUrl: await image() } });
    assert.match(saved.id, /^custom-/);
    assert.ok('url' in saved.portrait && saved.portrait.url.startsWith('/api/characters/'));
    assert.equal(saved.themeId, null, 'keeping the theme is durable');
    const reopened = createCharacters(home);
    assert.deepEqual(await reopened.list(), [saved]);
    const bytes = await reopened.portrait(saved.id);
    assert.ok(bytes.length <= CHARACTER_LIMITS.portraitBytes);
    assert.equal((await sharp(bytes).metadata()).format, 'png');
    assert.equal((await fs.stat(path.join(home, 'characters', `${saved.id}.png`))).mode & 0o777, 0o600);
    await assert.rejects(reopened.portrait('../../auth'), /character/i);
    await reopened.delete(saved.id);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(reopened.portrait(saved.id), /character|portrait/i);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('character uploads reject malformed, active, oversized and decompression-sized content; concurrent saves do not lose characters', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-character-validation-'));
  try {
    const store = createCharacters(home);
    for (const portrait of [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, { dataUrl: 'data:image/png;base64,YWJj' }, { dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(CHARACTER_LIMITS.imageBytes / 3) * 4 + 4)}` }, { builtin: '../../auth.json' }]) {
      await assert.rejects(store.save({ ...draft, portrait }), /image|portrait|large/i);
    }
    await assert.rejects(store.save({ ...draft, name: 'x'.repeat(61) }), /name/i);
    await assert.rejects(store.save({ ...draft, themeId: '../../theme' }), /theme/i);
    const [a, b] = await Promise.all([store.save(draft), store.save({ ...draft, name: 'Orion' })]);
    assert.deepEqual(new Set((await store.list()).map(row => row.id)), new Set([a.id, b.id]));
    const png = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#fff' } }).png().toBuffer();
    await assert.rejects(store.save({ ...draft, portrait: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } }), /image|pixels/i);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('image sources come from connection catalogues, preserve image-only models and fall back to the next route', async () => {
  const connections = [
    { id: 'first', name: 'First', definition: { base_url: 'http://127.0.0.1:19001/v1', wire_api: 'responses' } },
    { id: 'second', name: 'Second', definition: { base_url: 'http://127.0.0.1:19002/v1', wire_api: 'responses' } },
  ];
  const posts: string[] = [];
  const fetchImpl: typeof fetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (options?.method !== 'POST') return Response.json({ data: [{ id: 'artist-custom-7', architecture: { output_modalities: ['image'] }, supported_parameters: [] }, { id: 'plain-chat', architecture: { output_modalities: ['text'] } }] });
    posts.push(url);
    return url.includes('19001') ? Response.json({ error: { message: 'Model temporarily unavailable' } }, { status: 503 }) : Response.json({ data: [{ b64_json: (await image()).split(',')[1] }] });
  };
  const listed = await discoverPortraitSources(connections, { fetchImpl });
  assert.deepEqual(listed.sources.map(source => source.provider), ['first', 'second']);
  assert.ok(listed.sources.every(source => source.model === 'artist-custom-7'));
  const result = await generatePortrait('astronomer', listed.sources, connections, { fetchImpl });
  assert.equal(result.source.provider, 'second');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /temporarily unavailable/);
  assert.equal(posts.length, 2);
  posts.length = 0;
  const chosen = await generatePortrait('astronomer', listed.sources, connections, { fetchImpl, sourceId: listed.sources[1]!.id });
  assert.equal(chosen.source.provider, 'second');
  assert.equal(posts.length, 1, 'the explicit choice leads');
  assert.deepEqual((await discoverPortraitSources([], { fetchImpl })).sources, []);
});

test('Stop aborts the provider request and never falls through into another generation', async () => {
  const connection = { id: 'local', name: 'Local', definition: { base_url: 'http://127.0.0.1:19003/v1', wire_api: 'responses' } };
  let aborted = false, posts = 0;
  const fetchImpl: typeof fetch = async (_input, options) => {
    if (options?.method !== 'POST') return Response.json({ data: [{ id: 'pixel-artist', architecture: { output_modalities: ['image'] } }] });
    posts++;
    return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true }));
  };
  const { sources } = await discoverPortraitSources([connection], { fetchImpl });
  const stop = new AbortController();
  const pending = generatePortrait('astronomer', sources, [connection], { fetchImpl, signal: stop.signal });
  await new Promise(resolve => setImmediate(resolve)); stop.abort();
  await assert.rejects(pending, /stop|abort/i);
  assert.equal(aborted, true);
  assert.equal(posts, 1);
});
