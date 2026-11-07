import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeError, DesktopClient, elpisHome, object } from './client.mts';
import { profileEnvironment } from './profile-env.mts';
import { LOVE_SPOT_AUDIO } from '../lib/love-spot-audio.mts';
import { createExperimentLab } from './experiment-lab.mts';
import { createSchedule } from './schedule.mts';
import { createTools } from './tools.mts';
import { createTranscription } from './transcription.mts';
import { createVoice } from './voice.mts';
import { createKokoro } from './kokoro.mts';
import { createReadAloudProvider } from './read-aloud-provider.mts';
import { createImportChats } from './import-chats.mts';
import { createTrash } from './trash.mts';
import { createLoveSpot } from './love-spot-store.cts';
import { createLoveSpotTalk } from './love-spot-talk.mts';
import { createMatildaCompanion } from './matilda-companion.mjs';
import { createLoveAgents } from './love-agents.mts';
import { createDevServers } from './dev-servers.mts';
import { createImprovements } from './improve.mts';
import { createSettingsFiles } from './settings-files.mts';
import { createThreadTitles } from './thread-titles.mts';
import { COOKIE, ERROR_AREAS, applyFrameHeaders, applySecurityHeaders, body, json, requestDiagnostics, same, sendRequestError, serveStaticAsset } from './server-http.mts';
import { handleLoveSpotRoutes } from './server-love-spot.mts';
import { handleVoiceRoutes } from './server-voice.mts';
import { handleFileRoutes } from './server-files.mts';
import { handleSettingsRoutes } from './server-settings.mts';
import { createWorkflowDispatcher, handleWorkflowRoutes } from './server-workflows.mts';
import { createHistoryCursors, handleThreadRoutes } from './server-threads.mts';
import { MotherAgent } from './router/mother-agent.mts';

type DesktopServerOptions = {
  client?: DesktopClient;
  socketPath?: string;
  elpisHome?: string;
  trashFile?: string;
  staticDir?: string;
  loveSpot?: Parameters<typeof createLoveSpot>[0];
  loveSpotAudio?: Parameters<typeof createLoveSpotTalk>[0]['audio'];
  loveAgents?: { env?: NodeJS.ProcessEnv } & Record<string, unknown>;
  workflowClaimWait?: number;
  automationsFile?: string;
  automations?: boolean;
  improvements?: Record<string, unknown>;
  tools?: ReturnType<typeof createTools>;
  kokoro?: Parameters<typeof createReadAloudProvider>[0]['kokoro'] & { defaultVoice?: string; close: () => void };
  readAloudFetch?: typeof fetch;
  codexHome?: string;
  port?: number;
};

/** Starts only this UI server; connects to an existing Elpis runtime and never starts/stops it. `trashFile` keeps the
 * chats deleted from the sidebar until they are deleted for good (bridge/trash.mts): what a crash left is deleted now.
 * @param {Record<string, unknown>} [rawOptions] */
export async function startDesktopServer(rawOptions: Record<string, unknown> = {}) {
  const options = rawOptions as DesktopServerOptions;
  const client = options.client ?? await DesktopClient.connect({ ...(options.socketPath ? { socketPath: options.socketPath } : {}), ...(options.elpisHome ? { home: options.elpisHome } : {}) });
  const trash = await createTrash({ client, file: options.trashFile });
  // The last session's deleted chats go for good once the runtime is reachable, which may be after the window opened.
  const purge = () => trash.purge().catch(() => {});
  if (client.connected === false) client.on('event', function connected(value: { type?: string; data?: { connected?: boolean } }) { if (value.type === 'connection' && value.data?.connected) { client.off('event', connected); void purge(); } });
  else await purge();
  const staticDir = path.resolve(options.staticDir ?? fileURLToPath(new URL('../out', import.meta.url)));
  const capability = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  // Chats reach Automations alone through bridge/schedule-mcp.mts with this key; it opens no other route.
  const automationKey = randomBytes(32).toString('hex');
  /** @type {Set<import('node:http').ServerResponse>} */
  const listeners = new Set<http.ServerResponse>();
  let closed = false;
  const loveSpot = createLoveSpot(options.loveSpot);
  await loveSpot.start();
  const companion = createMatildaCompanion({ store: loveSpot });
  const loveTalk = createLoveSpotTalk({ client, store: loveSpot, companion, audio: options.loveSpotAudio ?? LOVE_SPOT_AUDIO });
  // Love Spot's agents run as ACP agent processes (bridge/acp-nodes.mts), not through this Elpis connection.
  const loveAgents = createLoveAgents(loveSpot, { ...options.loveAgents, env: profileEnvironment(options.elpisHome, options.loveAgents?.env) });
  const devServers = createDevServers();
  const experimentLab = createExperimentLab({ client, ...(options.elpisHome ? { file: path.join(options.elpisHome, 'experiment-lab', 'latest.json') } : {}) } as Parameters<typeof createExperimentLab>[0]);
  /** @param {{ type: string, data: unknown }} value */
  const event = (value: { type: string; data: unknown }) => {
    const bytes = `event: ${value.type}\ndata: ${JSON.stringify(value.data)}\n\n`;
    for (const response of listeners) {
      if (response.writableLength > 1024 * 1024) { response.destroy(); listeners.delete(response); }
      else response.write(bytes);
    }
  };
  const workflowDispatcher = createWorkflowDispatcher({ event, claimWait: options.workflowClaimWait ?? 60_000 });
  // Automations (bridge/schedule.mjs) run only where the caller asks for them: the app passes `automations: true`, a test
  // its own `automationsFile`; otherwise the routes say they are off, so no test touches his tasks.
  const automationsFile = options.automationsFile ?? (options.automations ? path.join(options.elpisHome ?? elpisHome(), 'automations', 'tasks.json') : null);
  const automations = automationsFile ? createSchedule({ client, file: automationsFile, dispatchWorkflow: (job: object) => workflowDispatcher.dispatch(job as import('./server-workflows.mts').ScheduledWorkflowJob) }) : null;
  /** @type {Set<import('node:http').ServerResponse>} */
  const loveStreams = new Set<http.ServerResponse>();
  /** @type {Promise<Awaited<ReturnType<typeof createImprovements>>> | undefined} */
  let improvementStore: Promise<Awaited<ReturnType<typeof createImprovements>>> | undefined;
  const improvements = () => improvementStore ??= createImprovements({ client, ...options.improvements } as Parameters<typeof createImprovements>[0]);
  const tools = options.tools ?? createTools({ environment: () => client.ragEnvironment() });
  const diagnose = requestDiagnostics(options.elpisHome ?? elpisHome());
  const settingsFiles = createSettingsFiles(options.elpisHome ?? elpisHome());
  const mother = new MotherAgent({ client, home: options.elpisHome ?? elpisHome(), ...(options.socketPath ? { socketPath: options.socketPath } : {}) });
  const motherConnection = (value: { type: string; data?: { connected?: boolean } }) => { if (value.type === 'connection' && value.data?.connected) void mother.start(); };
  client.on('event', motherConnection);
  void mother.start();
  const historyCursors = createHistoryCursors();
  const transcription = createTranscription({ definition: () => client.transcriptionDefinition(), environment: () => client.transcriptionEnvironment() });
  const voice = createVoice(client);
  const kokoro = options.kokoro ?? createKokoro();
  const readAloud = createReadAloudProvider({ home: options.elpisHome ?? elpisHome(), kokoro, provider: (id: unknown) => client.readAloudProvider(id), ...(options.readAloudFetch ? { fetchImpl: options.readAloudFetch } : {}) });
  const importChats = createImportChats({ client, elpisHome: options.elpisHome ?? elpisHome(), ...(options.codexHome ? { codexHome: options.codexHome } : {}) });
  client.on('event', event);
  // A chat Masih starts is named from its first message, as the TUI names it.
  const titles = createThreadTitles(client);
  client.on('event', (value: { type?: string; data?: unknown }) => { if (value.type === 'message') void titles.event(value.data as Parameters<typeof titles.event>[0]); });
  /** @type {import('./server-http.mts').ServerState} */
  const state: import('./server-http.mts').ServerState = {
    client, options, trash, loveSpot, companion, loveTalk, loveAgents, loveStreams,
    devServers, experimentLab, automations, workflowDispatcher, improvements, tools,
    settingsFiles, mother, historyCursors, transcription, voice, kokoro, readAloud, importChats,
  };
  let origin = '';
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const handleRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const requestId = randomUUID();
    let area = 'other';
    applySecurityHeaders(response, requestId);
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('Local application origin required', 403);
      if (!request.method || !['GET', 'POST', 'PUT'].includes(request.method)) throw new BridgeError('Method is not allowed', 405);
      const url = new URL(request.url ?? '/', origin);
      const requestedArea = url.pathname.split('/')[2] ?? '';
      if (ERROR_AREAS.has(requestedArea)) area = requestedArea;
      if (url.origin !== origin) throw new BridgeError('Local application origin required', 403);
      applyFrameHeaders(url, response);
      const key = request.headers['x-elpis-automations'];
      const automationTool = typeof key === 'string' && same(key, automationKey) && /^\/api\/automations(?:\/|$)/.test(url.pathname);
      if (request.method !== 'GET' && !automationTool && request.headers.origin !== origin) throw new BridgeError('Same-origin request required', 403);
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const submitted = object(await body(request), ['token']) as { token?: unknown };
        if (!same(submitted.token, capability)) throw new BridgeError('Invalid application capability', 403);
        response.setHeader('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/api`);
        return json(response, 200, { authenticated: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim());
        if (!automationTool && !cookies.some(value => same(value, `${COOKIE}=${session}`))) throw new BridgeError('Open the application using its private launch URL', 401);
        const method = request.method;
        if (url.pathname === '/api/health' && method === 'GET') return json(response, 200, { connected: client.connected, ...(client.connectionError ? { error: client.connectionError } : {}) });
        if (url.pathname === '/api/events' && method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          listeners.add(response); response.write(`event: connection\ndata: ${JSON.stringify({ connected: client.connected })}\n\n`);
          for (const pending of client.pendingApprovals) response.write(`event: approval\ndata: ${JSON.stringify(pending)}\n\n`);
          request.on('close', () => listeners.delete(response)); return;
        }
        if (await handleLoveSpotRoutes(state, request, response, url, method)) return;
        if (await handleVoiceRoutes(state, request, response, url, method)) return;
        if (await handleFileRoutes(state, request, response, url, method)) return;
        if (url.pathname.startsWith('/api/mother/')) { await mother.handle(request, response, new URL(origin).port); return; }
        if (await handleSettingsRoutes(state, request, response, url, method)) return;
        if (await handleWorkflowRoutes(state, request, response, url, method)) return;
        if (await handleThreadRoutes(state, request, response, url, method)) return;
        throw new BridgeError('Unknown application operation', 404);
      }
      await serveStaticAsset(staticDir, url, request, response);
    } catch (error) {
      await sendRequestError(error, request, response, requestId, area, diagnose);
    }
  };
  const server = http.createServer((request, response) => { void handleRequest(request, response); });
  server.requestTimeout = 35000; server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => resolve()); });
  } catch (error) { await mother.close(); await loveSpot.close(); client.off('event', event); client.off('event', motherConnection); client.close(); throw error; }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  const heartbeat = setInterval(() => { for (const response of listeners) response.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  return {
    url: `${origin}/#token=${capability}`,
    /** What bridge/schedule-mcp.mts needs to reach Automations, or null when they are off. */
    get automationAccess() { return automations ? { url: origin, key: automationKey } : null; },
    /** Chats and their agents run in the background service, which outlives this window, so they keep running across
     * an update restart; only work this process runs itself (voice, Love Spot, Lab, local workflow runs) waits. */
    canRestart() {
      return Promise.resolve(!(voice.busy() || loveTalk.busy() || loveAgents.busy() || experimentLab.busy() || automations?.busy() || client.hasLocalActivity?.()));
    },
    async close() {
      if (closed) return; closed = true; clearInterval(heartbeat);
      client.off('event', motherConnection); await mother.close();
      await voice.close(); kokoro.close();
      workflowDispatcher.close();
      await experimentLab.close(); await automations?.close();
      if (improvementStore) (await improvementStore).close();
      await devServers.close();
      loveTalk.close(); await loveTalk.idle(); await loveAgents.close(); await loveSpot.close(); for (const response of loveStreams) response.end(); loveStreams.clear();
      for (const response of listeners) response.end(); listeners.clear();
      // Quitting deletes the sidebar's deleted chats for good; what does not finish in time goes at the next start.
      await Promise.race([trash.purge().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
      client.off('event', event); client.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDesktopServer({ port: process.env.ELPIS_APP_PORT ? Number(process.env.ELPIS_APP_PORT) : 0 }).then(app => {
    process.stdout.write(`${app.url}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
