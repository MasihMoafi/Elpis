import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeError, DesktopClient, elpisHome, object } from './client.mjs';
import { planCanvas } from './canvas-plan.mjs';
import { createExperimentLab } from './experiment-lab.mjs';
import { listDirectory, listFiles, readFile, searchFiles, writeFile } from './files.mjs';
import { listFolders, projectDirectory } from './folders.mjs';
import { isRepository } from './git.mjs';
import { createTools } from './tools.mjs';
import { createTranscription } from './transcription.mjs';
import { ATTACHMENT_BODY_LIMIT, AttachmentError, PDF_BODY_LIMIT, extractPdf } from './attachments.mjs';
import { createTrash } from './trash.mjs';
import { smartPruneDetail } from './smart-prune.mjs';
import { createLoveSpot } from './love-spot-store.cjs';
import { createLoveSpotTalk } from './love-spot-talk.mjs';
import { createLoveAgents } from './love-agents.mjs';
import { createDevServers, devServerRequest } from './dev-servers.mjs';
import { createImprovements } from './improve.mjs';
import { dismissPersonalTip, openPersonal, personalStatus } from './personal.mjs';

const COOKIE = 'elpis_desktop';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ERROR_CAUSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);
const ERROR_AREAS = new Set(['session', 'health', 'models', 'threads', 'settings', 'providers', 'approvals', 'workflows', 'files', 'file', 'folders', 'repository', 'tools', 'context', 'customize', 'mcp', 'hooks', 'events', 'dev-servers', 'love-spot']);
/** Only fixed categories and numeric runtime codes enter this bounded log. Never serialize an error or request. */
function requestDiagnostics(home) {
  const directory = path.join(home, 'logs'), file = path.join(directory, 'desktop-requests.jsonl');
  let writing = Promise.resolve();
  return record => {
    writing = writing.catch(() => {}).then(async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await fs.open(file, 'a', 0o600);
      try {
        await handle.chmod(0o600);
        if ((await handle.stat()).size >= 1024 * 1024) await handle.truncate(0);
        await handle.writeFile(JSON.stringify(record) + '\n');
      } finally { await handle.close(); }
    });
    // An unwritable diagnostics directory must not replace the original response.
    return writing.catch(() => { process.stderr.write(JSON.stringify({ ...record, diagnostics: 'unavailable' }) + '\n'); });
  };
}
/** The one `cwd` a project-folder request names (and, for the Files pane, the other fields it may carry). */
function cwdOf(url, ...others) {
  if ([...url.searchParams.keys()].some(key => key !== 'cwd' && !others.includes(key)) || url.searchParams.getAll('cwd').length !== 1 || others.some(key => url.searchParams.getAll(key).length > 1)) throw new BridgeError('Provide exactly one cwd');
  return url.searchParams.get('cwd');
}
function pageQuery(url, ancestor = false, models = false) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!['limit', 'cursor', ...(ancestor ? ['ancestorThreadId', 'archived', 'searchTerm', 'includeAgentRuns'] : []), ...(models ? ['provider'] : [])].includes(key) || result[key] !== undefined) throw new BridgeError('Unsupported query parameter');
    if (key === 'searchTerm') {
      if (!value.trim() || value.length > 200) throw new BridgeError('Search must contain 1 through 200 characters');
      result.searchTerm = value.trim();
    } else if (key === 'archived' || key === 'includeAgentRuns') {
      if (!['true', 'false'].includes(value)) throw new BridgeError(`${key} must be true or false`);
      result[key] = value === 'true';
    } else if (key === 'limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new BridgeError('Limit must be 1 through 100');
      result.limit = Number(value);
    } else {
      if (!value || value.length > 4096) throw new BridgeError('Invalid cursor or ancestor ID');
      result[key] = value;
    }
  }
  return result;
}
async function body(request, limit = 65536) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new BridgeError('JSON content type required', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > limit) throw new BridgeError('Request is too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BridgeError('Invalid JSON'); }
}
function json(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 8 * 1024 * 1024) return json(response, 413, { error: 'Response is too large; request a smaller page' });
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length }); response.end(bytes);
}

/** Starts only this UI server; connects to an existing Elpis runtime and never starts/stops it. `trashFile` keeps the
 * chats deleted from the sidebar until they are deleted for good (bridge/trash.mjs): what a crash left is deleted now. */
export async function startDesktopServer(options = {}) {
  const client = options.client ?? await DesktopClient.connect({ socketPath: options.socketPath });
  const trash = await createTrash({ client, file: options.trashFile });
  await trash.purge().catch(() => {});
  const staticDir = path.resolve(options.staticDir ?? fileURLToPath(new URL('../out', import.meta.url)));
  const capability = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  const listeners = new Set(); let origin; let closed = false;
  const loveSpot = createLoveSpot(options.loveSpot);
  const loveTalk = createLoveSpotTalk({ client, store: loveSpot });
  // Love Spot's agents run as ACP agent processes (bridge/acp-nodes.mjs), not through this Elpis connection.
  const loveAgents = createLoveAgents(loveSpot, { ...(options.elpisHome ? { env: { ...process.env, ELPIS_HOME: options.elpisHome } } : {}), ...options.loveAgents });
  const devServers = createDevServers();
  const experimentLab = createExperimentLab({ client, ...(options.elpisHome ? { file: path.join(options.elpisHome, 'experiment-lab', 'latest.json') } : {}) });
  const loveStreams = new Set();
  let improvementStore;
  const improvements = () => improvementStore ??= createImprovements({ client, ...options.improvements });
  const tools = options.tools ?? createTools({ environment: () => client.ragEnvironment() });
  const diagnose = requestDiagnostics(options.elpisHome ?? elpisHome());
  const transcription = createTranscription({ definition: () => client.transcriptionDefinition(), environment: () => client.transcriptionEnvironment() });
  const event = value => {
    const bytes = `event: ${value.type}\ndata: ${JSON.stringify(value.data)}\n\n`;
    for (const response of listeners) {
      if (response.writableLength > 1024 * 1024) { response.destroy(); listeners.delete(response); }
      else response.write(bytes);
    }
  };
  client.on('event', event);
  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    let area = 'other';
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('Local application origin required', 403);
      if (!['GET', 'POST'].includes(request.method)) throw new BridgeError('Method is not allowed', 405);
      const url = new URL(request.url, origin);
      const requestedArea = url.pathname.split('/')[2];
      if (ERROR_AREAS.has(requestedArea)) area = requestedArea;
      if (url.origin !== origin) throw new BridgeError('Local application origin required', 403);
      // Only the split document permits embedding by the app itself.
      if (url.pathname === '/' && url.searchParams.get('pane') === '1') {
        response.setHeader('X-Frame-Options', 'SAMEORIGIN');
        response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      }
      if (request.method === 'POST' && request.headers.origin !== origin) throw new BridgeError('Same-origin request required', 403);
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const submitted = object(await body(request), ['token']);
        if (!same(submitted.token, capability)) throw new BridgeError('Invalid application capability', 403);
        response.setHeader('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/api`);
        return json(response, 200, { authenticated: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim());
        if (!cookies.some(value => same(value, `${COOKIE}=${session}`))) throw new BridgeError('Open the application using its private launch URL', 401);
        const method = request.method;
        if (url.pathname === '/api/dev-servers' || url.pathname.startsWith('/api/dev-servers/')) return json(response, 200, await devServerRequest(devServers, method, url, method === 'POST' ? await body(request) : undefined));
        if (url.pathname === '/api/love-spot') {
          const value = method === 'GET' ? await loveSpot.read() : await loveSpot.save(await body(request, 64 * 1024 * 1024));
          // A drawing with screenshots can exceed the paginated chat response limit.
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return response.end(JSON.stringify(value));
        }
        if (url.pathname === '/api/love-spot/pages' && ['GET', 'POST'].includes(method)) {
          const value = method === 'GET' ? await loveSpot.listPages() : await loveSpot.changePage(await body(request));
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return response.end(JSON.stringify(value));
        }
        if (url.pathname === '/api/love-spot/picture' && method === 'POST') return json(response, 200, await loveSpot.picture(await body(request, 32 * 1024 * 1024)));
        if (url.pathname === '/api/love-spot/screenshots' && ['GET', 'POST'].includes(method)) {
          const value = method === 'GET' ? { screenshots: loveSpot.screenshotsList() } : await loveSpot.chooseScreenshot(await body(request, 32 * 1024 * 1024));
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return response.end(JSON.stringify(value));
        }
        if (url.pathname === '/api/love-spot/talk') return json(response, 200, method === 'GET' ? await loveTalk.read() : await loveTalk.send(await body(request)));
        if (url.pathname === '/api/love-spot/talk/events' && method === 'GET') {
          // Load first so a failed resume still returns a useful HTTP error.
          await loveTalk.read();
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          loveStreams.add(response);
          const stop = await loveTalk.watch(value => {
            if (response.writableLength > 1024 * 1024) response.destroy();
            else response.write(`data: ${JSON.stringify(value)}\n\n`);
          });
          response.on('close', () => { stop(); loveStreams.delete(response); }); return;
        }
        if (url.pathname === '/api/love-spot/agents/run' && method === 'POST') return json(response, 200, await loveAgents.run(await body(request)));
        if (url.pathname === '/api/love-spot/agents/permission' && method === 'POST') return json(response, 200, loveAgents.answer(await body(request)));
        if (url.pathname === '/api/love-spot/events' && method === 'GET') {
          const hint = url.searchParams.get('revision');
          if (hint !== null && (!/^[a-f0-9]{64}$/.test(hint) || url.searchParams.getAll('revision').length > 1)) throw new BridgeError('Invalid drawing revision', 400);
          // Skip only the fresh subscription's already loaded snapshot. All live
          // updates and reconnect snapshots retain the existing reconciliation path.
          let bootstrap = request.headers['last-event-id'] === undefined ? hint : null;
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          loveStreams.add(response);
          const stop = await loveSpot.watch(value => {
            if (value.type === 'scene') {
              if (bootstrap !== null && value.revision === bootstrap) return;
              bootstrap = null;
            }
            if (response.writableLength > 64 * 1024 * 1024) response.destroy();
            else response.write(`${hint === null ? '' : 'id: love-spot\n'}data: ${JSON.stringify(value)}\n\n`);
          });
          response.on('close', () => { stop(); loveStreams.delete(response); }); return;
        }
        if (url.pathname === '/api/tools/transcription') return await transcription(request, response, json);
        if (url.pathname.startsWith('/api/tools/')) return await tools(request, response, url, json);
        if (url.pathname === '/api/health' && method === 'GET') return json(response, 200, { connected: client.connected });
        if (url.pathname === '/api/improvements') {
          const store = await improvements();
          return json(response, method === 'POST' ? 201 : 200, method === 'POST' ? await store.start(await body(request, ATTACHMENT_BODY_LIMIT)) : { data: store.list() });
        }
        const improvement = url.pathname.match(/^\/api\/improvements\/([a-f0-9-]+)(?:\/(check|keep))?$/);
        if (improvement) {
          const store = await improvements();
          if (method === 'GET' && !improvement[2]) return json(response, 200, await store.get(improvement[1]));
          if (method === 'POST' && improvement[2]) { object(await body(request), []); return json(response, 200, await store[improvement[2]](improvement[1])); }
          throw new BridgeError('Method is not allowed', 405);
        }
        if (url.pathname === '/api/personal' && method === 'GET') return json(response, 200, await personalStatus(options.elpisHome));
        if (url.pathname === '/api/personal' && method === 'POST') {
          const input = object(await body(request), ['action']);
          if (!['open', 'dismiss'].includes(input.action)) throw new BridgeError('Choose open or dismiss');
          return json(response, 200, await (input.action === 'open' ? openPersonal : dismissPersonalTip)(options.elpisHome));
        }
        if (url.pathname === '/api/attachments/extract' && method === 'POST') return json(response, 200, await extractPdf(await body(request, PDF_BODY_LIMIT)));
        const media = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/items\/([^/]+)\/media\/(\d{1,3})$/);
        if (media && method === 'GET') {
          const asset = await client.media(...media.slice(1, 4).map(decodeURIComponent), Number(media[4]));
          response.writeHead(200, { 'Content-Type': asset.mimeType, 'Content-Length': asset.bytes.length, 'Cache-Control': 'no-store' });
          return response.end(asset.bytes);
        }
        if (url.pathname === '/api/events' && method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          listeners.add(response); response.write(`event: connection\ndata: ${JSON.stringify({ connected: client.connected })}\n\n`);
          for (const pending of client.pendingApprovals) response.write(`event: approval\ndata: ${JSON.stringify(pending)}\n\n`);
          request.on('close', () => listeners.delete(response)); return;
        }
        if (url.pathname === '/api/models' && method === 'GET') return json(response, 200, await client.models(pageQuery(url, false, true)));
        if (url.pathname === '/api/folders' && method === 'GET') return json(response, 200, await listFolders(cwdOf(url)));
        if (url.pathname === '/api/files' && method === 'GET') return json(response, 200, await listFiles(cwdOf(url)));
        // The Files pane: a folder's entries, a file's text and saving it, a search of the contents.
        if (url.pathname === '/api/files/dir' && method === 'GET') return json(response, 200, await listDirectory(cwdOf(url, 'dir', 'hidden'), url.searchParams.get('dir') ?? '', url.searchParams.get('hidden') === '1'));
        if (url.pathname === '/api/files/search' && method === 'GET') return json(response, 200, await searchFiles(cwdOf(url, 'q'), url.searchParams.get('q') ?? ''));
        if (url.pathname === '/api/file' && method === 'GET') return json(response, 200, await readFile(cwdOf(url, 'path'), url.searchParams.get('path') ?? ''));
        if (url.pathname === '/api/file' && method === 'POST') {
          const edit = object(await body(request, 3 * 1024 * 1024), ['cwd', 'path', 'content', 'mtimeMs']);
          return json(response, 200, await writeFile(edit.cwd, edit.path, edit.content, edit.mtimeMs));
        }
        // Whether the project is a Git repository with a commit: the canvas asks for worktree isolation only then.
        if (url.pathname === '/api/repository' && method === 'GET') return json(response, 200, { repository: await isRepository(await projectDirectory(cwdOf(url))) });
        if (url.pathname === '/api/canvas/plan' && method === 'POST') return json(response, 200, await planCanvas(client, await body(request)));
        if (url.pathname === '/api/experiment-lab') {
          if (method === 'GET') return json(response, 200, { record: await experimentLab.read() });
          const input = await body(request);
          if (input?.action === 'stop') { object(input, ['action']); return json(response, 200, { record: await experimentLab.stop() }); }
          return json(response, 200, { record: await experimentLab.start(input) });
        }
        if (url.pathname === '/api/settings' && method === 'GET') return json(response, 200, await client.settings());
        if (url.pathname === '/api/settings' && method === 'POST') return json(response, 200, await client.saveSettings(await body(request)));
        if (url.pathname === '/api/pruner' && method === 'POST') return json(response, 200, await client.savePruner(await body(request)));
        if (url.pathname === '/api/providers') return json(response, 200, method === 'GET' ? await client.providers() : await client.signIn(await body(request)));
        if (url.pathname === '/api/providers/settings') return json(response, 200, method === 'GET' ? await client.providerSettings() : await client.saveProvider(await body(request)));
        if (url.pathname === '/api/providers/key' && method === 'POST') return json(response, 200, await client.saveProviderKey(await body(request)));
        if (url.pathname === '/api/mcp') return json(response, 200, method === 'GET' ? await client.mcp() : await client.saveMcp(await body(request)));
        const inlinePrune = url.pathname.match(/^\/api\/threads\/([^/]+)\/smart-prune\/([^/]+)\/([^/]+)$/);
        if (inlinePrune && method === 'GET') return json(response, 200, await smartPruneDetail(options.elpisHome, ...inlinePrune.slice(1).map(decodeURIComponent)));
        if (url.pathname === '/api/customize' && method === 'GET') return json(response, 200, await client.customize(url.searchParams.get('cwd') || undefined));
        if (url.pathname === '/api/customize/skill' && method === 'POST') return json(response, 200, await client.setSkill(await body(request)));
        if (url.pathname === '/api/customize/skill/delete' && method === 'POST') return json(response, 200, await client.deleteSkill(await body(request)));
        if (url.pathname === '/api/customize/skill/undo' && method === 'POST') return json(response, 200, await client.undoSkillDelete(await body(request)));
        if (url.pathname === '/api/customize/github' && method === 'POST') return json(response, 200, await client.setGithubConnector(await body(request)));
        if (url.pathname === '/api/context/switches') return json(response, 200, method === 'GET' ? await client.contextSwitches() : await client.saveContextSwitches(await body(request)));
        if (url.pathname === '/api/hooks') return json(response, 200, method === 'GET' ? await client.hooks() : await client.saveHook(await body(request)));
        if (url.pathname === '/api/memories/reset' && method === 'POST') return json(response, 200, await client.resetMemories(await body(request)));
        if (url.pathname === '/api/workflows' && method === 'GET') {
          if([...url.searchParams.keys()].some(key=>key!=='threadId')||url.searchParams.getAll('threadId').length!==1)throw new BridgeError('Choose one workflow conversation');
          return json(response,200,await client.workflows(url.searchParams.get('threadId')));
        }
        if (url.pathname === '/api/workflows/run' && method === 'POST') return json(response,200,await client.runWorkflow(await body(request)));
        // Sidebar deletion: archived now, Ctrl+Z brings back the newest, quitting deletes for good.
        if (url.pathname === '/api/trash' && method === 'POST') return json(response, 200, await trash.trash(object(await body(request), ['threadIds']).threadIds));
        if (url.pathname === '/api/trash/undo' && method === 'POST') { object(await body(request), []); return json(response, 200, await trash.undo()); }
        if (url.pathname === '/api/threads') {
          if (method === 'GET') {
            const query = pageQuery(url, true), listed = await client.listThreads(query);
            // A chat waiting to be deleted is archived, but it is not an archived chat.
            return json(response, 200, query.archived ? { ...listed, data: listed.data.filter(thread => !trash.has(thread.id)) } : listed);
          }
          return json(response, 201, await client.createThread(await body(request)));
        }
        const sideChat = url.pathname.match(/^\/api\/side-chats\/([^/]+)\/(turns|close)$/);
        if (sideChat && method === 'POST') return json(response, 200, await client[sideChat[2] === 'turns' ? 'sendSideChat' : 'closeSideChat'](decodeURIComponent(sideChat[1]), await body(request)));
        const contextFiles = url.pathname.match(/^\/api\/threads\/([^/]+)\/context-files$/);
        if (contextFiles) {
          const id = decodeURIComponent(contextFiles[1]);
          if (method === 'GET') return json(response, 200, await client.contextFiles(id));
          if (method === 'POST') return json(response, 200, await client.setContextFile(id, await body(request)));
        }
        const thread = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(turns|steer|interrupt|resume|continue|context|delete|rename|archive|unarchive|revert|rewind|fork|compact|review|git|permissions|shell|side-chat))?$/);
        if (thread) {
          const id = decodeURIComponent(thread[1]);
          if (thread[2] === 'shell' && method === 'POST') return json(response, 200, await client.shellCommand(id, await body(request)));
          if (thread[2] === 'side-chat' && method === 'POST') return json(response, 200, await client.createSideChat(id, await body(request)));
          if (!thread[2] && method === 'GET') return json(response, 200, await client.readThread(id, pageQuery(url)));
          if (thread[2] === 'context' && method === 'GET') return json(response, 200, await client.context(id));
          if (thread[2] === 'git' && method === 'GET') {
            if ([...url.searchParams.keys()].some(key => key !== 'view' && key !== 'path')) throw new BridgeError('Unsupported Git query');
            return json(response, 200, await client.git(id, url.searchParams.get('view'), url.searchParams.get('path') ?? undefined));
          }
          if (thread[2] === 'git' && method === 'POST') return json(response, 200, await client.discardChange(id, await body(request, 65536)));
          if (thread[2] && !['context', 'git'].includes(thread[2]) && method === 'POST') {
            const operation = { turns: 'send', steer: 'steer', interrupt: 'interrupt', resume: 'resume', continue: 'continueThread', delete: 'deleteThread', rename: 'renameThread', archive: 'archiveThread', unarchive: 'unarchiveThread', revert: 'revert', rewind: 'rewind', fork: 'forkThread', compact: 'compact', review: 'review', permissions: 'setPermissions' }[thread[2]];
            return json(response, 200, await client[operation](id, await body(request, ['send', 'steer'].includes(operation) ? ATTACHMENT_BODY_LIMIT : 65536)));
          }
          throw new BridgeError('Method is not allowed', 405);
        }
        const approval = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)(\/instead)?$/);
        if (approval && method === 'POST') return json(response, 200, approval[2] ? await client.denyInstead(approval[1], await body(request)) : client.answerApproval(approval[1], await body(request)));
        throw new BridgeError('Unknown application operation', 404);
      }
      if (request.method !== 'GET') throw new BridgeError('Method is not allowed', 405);
      let relative = decodeURIComponent(url.pathname);
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) throw new BridgeError('Invalid asset path', 400);
      if (relative.endsWith('/')) relative += 'index.html';
      const candidate = path.resolve(staticDir, `.${relative}`);
      const [root, real] = await Promise.all([fs.realpath(staticDir), fs.realpath(candidate)]);
      if (!real.startsWith(`${root}${path.sep}`)) throw new BridgeError('Asset is outside the application', 403);
      const type = MIME[path.extname(real)]; if (!type) throw new BridgeError('Unsupported asset', 404);
      const file = await fs.readFile(real);
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(file);
    } catch (error) {
      const known = error instanceof BridgeError || error instanceof AttachmentError || error?.loveSpot === true;
      const status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : error?.code === 'ENOENT' ? 404 : 500;
      const runtimeCode = error instanceof BridgeError && Number.isSafeInteger(error.code) ? error.code : undefined;
      const code = runtimeCode === -32601 ? 'ELPIS_RUNTIME_UNSUPPORTED' : runtimeCode !== undefined ? 'ELPIS_RUNTIME_ERROR'
        : status === 503 ? 'ELPIS_RUNTIME_UNAVAILABLE' : status >= 500 ? 'ELPIS_REQUEST_FAILED' : 'ELPIS_REQUEST_REJECTED';
      if (status >= 500) {
        await diagnose({ at: new Date().toISOString(), requestId, method: ['GET', 'POST'].includes(request.method) ? request.method : 'OTHER',
          area, status, code, ...(runtimeCode !== undefined ? { runtimeCode } : {}),
          cause: error instanceof BridgeError ? 'BridgeError' : ERROR_CAUSES.has(error?.name) ? error.name : 'Error' });
      }
      if (!response.headersSent) json(response, status, { error: known ? error.message : 'Application request failed', code, requestId, ...(runtimeCode !== undefined ? { runtimeCode } : {}) });
      else response.destroy();
    }
  });
  server.requestTimeout = 35000; server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  } catch (error) { client.off('event', event); client.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => { for (const response of listeners) response.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  return {
    url: `${origin}/#token=${capability}`,
    improvements,
    async close() {
      if (closed) return; closed = true; clearInterval(heartbeat);
      await experimentLab.close();
      if (improvementStore) (await improvementStore).close();
      await devServers.close();
      loveTalk.close(); await loveTalk.idle(); loveSpot.close(); for (const response of loveStreams) response.end(); loveStreams.clear();
      for (const response of listeners) response.end(); listeners.clear();
      // Quitting deletes the sidebar's deleted chats for good; what does not finish in time goes at the next start.
      await Promise.race([trash.purge().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
      client.off('event', event); client.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDesktopServer({ port: process.env.ELPIS_APP_PORT ? Number(process.env.ELPIS_APP_PORT) : 0 }).then(app => {
    process.stdout.write(`${app.url}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
