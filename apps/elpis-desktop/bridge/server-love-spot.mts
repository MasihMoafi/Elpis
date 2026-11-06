import { BridgeError, object, text } from './client.mts';
import { PORTRAIT_ATTACHMENT_NAME, PORTRAIT_INSTRUCTIONS } from './matilda-face.cjs';
import { body, json } from './server-http.mts';

export async function handleLoveSpotRoutes(state: import('./server-http.mts').ServerState, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, method: string) {
  const { loveSpot, companion, loveTalk, voice, loveAgents, loveStreams } = state;
  if (url.pathname === '/api/love-spot') {
    const value = method === 'GET' ? await loveSpot.read() : await loveSpot.save(await body(request, 64 * 1024 * 1024));
    // A drawing with screenshots can exceed the paginated chat response limit.
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value)); return true;
  }
  if (url.pathname === '/api/love-spot/text' && method === 'POST') { json(response, 200, await loveSpot.saveText(await body(request))); return true; }
  if (url.pathname === '/api/love-spot/pages' && ['GET', 'POST'].includes(method)) {
    const value = method === 'GET' ? await loveSpot.listPages() : await loveSpot.changePage(await body(request));
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value)); return true;
  }
  if (url.pathname === '/api/love-spot/picture' && method === 'POST') { json(response, 200, await loveSpot.picture(await body(request, 32 * 1024 * 1024))); return true; }
  if (url.pathname === '/api/love-spot/screenshots' && ['GET', 'POST'].includes(method)) {
    const value = method === 'GET' ? { screenshots: loveSpot.screenshotsList() } : await loveSpot.chooseScreenshot(await body(request, 32 * 1024 * 1024));
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value)); return true;
  }
  if (url.pathname === '/api/love-spot/companion' && ['GET', 'POST'].includes(method)) {
    json(response, 200, method === 'GET' ? await companion.read(url.searchParams.get('page') ?? '') : await companion.act(await body(request)));
    return true;
  }
  if (url.pathname === '/api/love-spot/matilda') { json(response, 200, method === 'POST' ? await loveTalk.setMatilda(await body(request)) : await loveTalk.matilda()); return true; }
  if (url.pathname === '/api/love-spot/talk/stop' && method === 'POST') { json(response, 200, await loveTalk.stop()); return true; }
  if (url.pathname === '/api/love-spot/talk/new' && method === 'POST') { json(response, 201, await loveTalk.startFresh(await body(request))); return true; }
  if (url.pathname === '/api/love-spot/talk') { json(response, 200, method === 'GET' ? await loveTalk.read() : await loveTalk.send(await body(request))); return true; }
  if (url.pathname === '/api/love-spot/voice/settings' && ['GET', 'POST'].includes(method)) {
    const voiceState = method === 'GET' ? await loveTalk.voice() : await loveTalk.setVoice(await body(request));
    if (method === 'POST') await voice.closeStream();
    json(response, 200, voiceState); return true;
  }
  if (url.pathname === '/api/love-spot/voice' && method === 'POST') { await voice.start(await body(request), response, /** @type {Parameters<typeof voice.start>[2]} */ ({ source: await loveTalk.speech() })); return true; }
  if (url.pathname === '/api/love-spot/voice/call' && method === 'POST') {
    const input = await body(request); object(input, ['sdp', 'persona']);
    if (input.persona !== undefined) text(input.persona, 'persona', 4000);
    await voice.start({ sdp: input.sdp }, response, /** @type {Parameters<typeof voice.start>[2]} */ ({ conversation: await loveTalk.conversation(input.persona as string | undefined) })); return true;
  }
  if (url.pathname === '/api/love-spot/talk/events' && method === 'GET') {
    // Load first so a failed resume still returns a useful HTTP error.
    await loveTalk.read();
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    loveStreams.add(response);
    const stop = await loveTalk.watch((value: unknown) => {
      if (response.writableLength > 1024 * 1024) response.destroy();
      else response.write(`data: ${JSON.stringify(value)}\n\n`);
    });
    response.on('close', () => { stop(); loveStreams.delete(response); }); return true;
  }
  if (url.pathname === '/api/love-spot/agents/run' && method === 'POST') { json(response, 200, await loveAgents.run(await body(request))); return true; }
  if (url.pathname === '/api/love-spot/agents/interview' && method === 'POST') { json(response, 200, await loveAgents.interview(await body(request))); return true; }
  if (url.pathname === '/api/love-spot/agents/permission' && method === 'POST') { json(response, 200, loveAgents.answer(await body(request))); return true; }
  if (url.pathname === '/api/love-spot/events' && method === 'GET') {
    const hint = url.searchParams.get('revision');
    if (hint !== null && (!/^[a-f0-9]{64}$/.test(hint) || url.searchParams.getAll('revision').length > 1)) throw new BridgeError('Invalid drawing revision', 400);
    // Skip only the fresh subscription's already loaded snapshot. All live
    // updates and reconnect snapshots retain the existing reconciliation path.
    let bootstrap = request.headers['last-event-id'] === undefined ? hint : null;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    loveStreams.add(response);
    const stop = await loveSpot.watch((value: { type?: string, revision?: string }) => {
      if (value.type === 'scene') {
        if (bootstrap !== null && value.revision === bootstrap) return;
        bootstrap = null;
      }
      if (response.writableLength > 64 * 1024 * 1024) response.destroy();
      else response.write(`${hint === null ? '' : 'id: love-spot\n'}data: ${JSON.stringify(value)}\n\n`);
    });
    response.on('close', () => { stop(); loveStreams.delete(response); }); return true;
  }
  return false;
}

export async function prepareLoveSpotTurn(loveSpot: import('./server-http.mts').ServerState['loveSpot'], id: string, operation: string, input: Record<string, unknown>) {
  // A normal chat tab uses the same portrait choices as the board, including existing conversations.
  // Writing to her in her own chat turns her on (6 Nov, Masih: "when I directly go to her and message, it should
  // automatically unlock her"); off still keeps her quiet on the board until then.
  if (['send', 'steer'].includes(operation) && await loveSpot.chat() === id && !(await loveSpot.matildaSettings()).replies) await loveSpot.matildaSettings({ replies: true });
  if (['send', 'steer'].includes(operation) && await loveSpot.chat() === id && input && typeof input === 'object' && !Array.isArray(input) && (input.attachments === undefined || Array.isArray(input.attachments))) {
    input.attachments = [...(input.attachments ?? []), { id: 'matilda-portrait', name: PORTRAIT_ATTACHMENT_NAME, type: 'text', mimeType: 'text/plain', text: PORTRAIT_INSTRUCTIONS }];
  }
}
