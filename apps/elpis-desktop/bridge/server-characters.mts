import { body, json } from './server-http.mts';
import { object } from './validate.mts';

export async function handleCharacterRoutes(state: Pick<import('./server-http.mts').ServerState, 'characters'>, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, method: string) {
  const { characters } = state;
  if (url.pathname === '/api/characters' && method === 'GET') { json(response, 200, { characters: await characters.list() }); return true; }
  const portrait = url.pathname.match(/^\/api\/characters\/(custom-[a-f0-9-]+)\/portrait$/);
  if (portrait && method === 'GET') {
    const png = await characters.portrait(portrait[1]);
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' }); response.end(png); return true;
  }
  if (url.pathname === '/api/characters/delete' && method === 'POST') {
    const input = object(await body(request), ['id']); json(response, 200, await characters.delete(input.id)); return true;
  }
  if (url.pathname === '/api/characters/personality' && method === 'POST') {
    const input = object(await body(request), ['id', 'personality']); json(response, 200, { character: await characters.personality(input.id, input.personality) }); return true;
  }
  return false;
}
