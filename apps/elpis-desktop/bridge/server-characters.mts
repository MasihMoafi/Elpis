import { body, json } from './server-http.mts';
import { CHARACTER_LIMITS } from '../lib/custom-character-types.mts';
import { object } from './validate.mts';
import { characterImage, portraitDataUrl } from './character-image.mts';

export async function handleCharacterRoutes(state: import('./server-http.mts').ServerState, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, method: string) {
  const { characters, characterGeneration } = state;
  if (url.pathname === '/api/characters' && method === 'GET') { json(response, 200, { characters: await characters.list() }); return true; }
  if (url.pathname === '/api/characters' && method === 'POST') { json(response, 200, { character: await characters.save(await body(request, Math.ceil(CHARACTER_LIMITS.imageBytes / 3) * 4 + 32000)) }); return true; }
  if (url.pathname === '/api/characters/portrait' && method === 'POST') {
    const input = object(await body(request, Math.ceil(CHARACTER_LIMITS.imageBytes / 3) * 4 + 100), ['dataUrl']);
    json(response, 200, { image: portraitDataUrl(await characterImage(input.dataUrl)) }); return true;
  }
  const portrait = url.pathname.match(/^\/api\/characters\/(custom-[a-f0-9-]+)\/portrait$/);
  if (portrait && method === 'GET') {
    const png = await characters.portrait(portrait[1]);
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' }); response.end(png); return true;
  }
  if (url.pathname === '/api/characters/delete' && method === 'POST') {
    const input = object(await body(request), ['id']); json(response, 200, await characters.delete(input.id)); return true;
  }
  if (url.pathname === '/api/characters/stop' && method === 'POST') {
    const input = object(await body(request), ['id']); json(response, 200, characterGeneration.stop(input.id)); return true;
  }
  if (url.pathname === '/api/characters/personality' && method === 'POST') {
    const input = object(await body(request), ['id', 'personality']); json(response, 200, { character: await characters.personality(input.id, input.personality) }); return true;
  }
  if (url.pathname === '/api/characters/sources' && method === 'GET' || url.pathname === '/api/characters/generate' && method === 'POST') {
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    try {
      const result = method === 'GET' ? await characterGeneration.sources(controller.signal) : await characterGeneration.generate(await body(request), controller.signal);
      if (!controller.signal.aborted) json(response, 200, result);
    } finally { response.off('close', disconnect); }
    return true;
  }
  return false;
}
