import { elpisHome, object } from './client.mts';
import { recordVoiceCall } from './voice.mjs';
import { body, json } from './server-http.mjs';

/** @param {import('./server-http.mjs').ServerState} state @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {URL} url @param {string} method */
export async function handleVoiceRoutes(state, request, response, url, method) {
  const { client, options, readAloud, kokoro, voice, transcription, tools } = state;
  if (url.pathname === '/api/voice/report' && method === 'POST') { json(response, 200, await recordVoiceCall(options.elpisHome ?? elpisHome(), await body(request))); return true; }
  if (url.pathname === '/api/read-aloud/settings' && method === 'GET') { json(response, 200, await readAloud.read()); return true; }
  if (url.pathname === '/api/read-aloud/settings' && method === 'POST') { json(response, 200, await readAloud.save(await body(request))); return true; }
  if (url.pathname === '/api/read-aloud/voices' && method === 'GET') { json(response, 200, { voices: await kokoro.voices?.() ?? [], defaultVoice: kokoro.defaultVoice }); return true; }
  // Read aloud returns only the chosen source's audio; an API failure never starts Kokoro.
  if (url.pathname === '/api/read-aloud' && method === 'GET') { json(response, 200, await readAloud.status()); return true; }
  if (url.pathname === '/api/read-aloud' && method === 'POST') {
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    try {
      const result = await readAloud.speak(await body(request), controller.signal);
      response.writeHead(200, { 'Content-Type': result.type, 'Cache-Control': 'no-store' }); response.end(result.audio); return true;
    } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
  }
  if (url.pathname === '/api/voice' && method === 'GET') { json(response, 200, await client.voiceStatus()); return true; }
  if (url.pathname === '/api/voice' && method === 'POST') { await voice.start(await body(request), response); return true; }
  if (url.pathname === '/api/voice/read-aloud' && method === 'POST') { await voice.start(await body(request, 8 * 1024 * 1024), response, { readAloud: true }); return true; }
  if (url.pathname === '/api/voice/read-aloud/ready' && method === 'POST') { json(response, 200, voice.ready(await body(request))); return true; }
  if (url.pathname === '/api/voice/read-aloud/more' && method === 'POST') { json(response, 200, voice.more(await body(request, 8 * 1024 * 1024))); return true; }
  if (url.pathname === '/api/voice/read-aloud/warm' && method === 'POST') { const input = await body(request); object(input, ['threadId']); json(response, 200, await client.warmSpeechThread(input.threadId)); return true; }
  if (url.pathname === '/api/voice/choice' && method === 'POST') { json(response, 200, await client.setVoice(await body(request))); return true; }
  if (url.pathname === '/api/tools/transcription') { await transcription(request, response, json); return true; }
  if (url.pathname.startsWith('/api/tools/')) { await tools(request, response, url, json); return true; }
  return false;
}
