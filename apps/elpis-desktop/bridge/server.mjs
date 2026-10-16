import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeError, DesktopClient, object } from './client.mjs';
import { createTools } from './tools.mjs';
import { createTranscription } from './transcription.mjs';
import { ATTACHMENT_BODY_LIMIT, AttachmentError, extractPdf } from './attachments.mjs';

const COOKIE = 'elpis_desktop';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function pageQuery(url, ancestor = false, models = false) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!['limit', 'cursor', ...(ancestor ? ['ancestorThreadId', 'archived', 'searchTerm'] : []), ...(models ? ['provider'] : [])].includes(key) || result[key] !== undefined) throw new BridgeError('Unsupported query parameter');
    if (key === 'searchTerm') {
      if (!value.trim() || value.length > 200) throw new BridgeError('Search must contain 1 through 200 characters');
      result.searchTerm = value.trim();
    } else if (key === 'archived') {
      if (!['true', 'false'].includes(value)) throw new BridgeError('archived must be true or false');
      result.archived = value === 'true';
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

/** Starts only this UI server; connects to an existing Elpis runtime and never starts/stops it. */
export async function startDesktopServer(options = {}) {
  const client = options.client ?? await DesktopClient.connect({ socketPath: options.socketPath });
  const staticDir = path.resolve(options.staticDir ?? fileURLToPath(new URL('../out', import.meta.url)));
  const capability = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  const listeners = new Set(); let origin; let closed = false;
  const tools = options.tools ?? createTools({ environment: () => client.ragEnvironment() });
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
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('Local application origin required', 403);
      if (!['GET', 'POST'].includes(request.method)) throw new BridgeError('Method is not allowed', 405);
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw new BridgeError('Local application origin required', 403);
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
        if (url.pathname === '/api/tools/transcription') return await transcription(request, response, json);
        if (url.pathname.startsWith('/api/tools/')) return await tools(request, response, url, json);
        if (url.pathname === '/api/health' && method === 'GET') return json(response, 200, { connected: client.connected });
        if (url.pathname === '/api/attachments/extract' && method === 'POST') return json(response, 200, await extractPdf(await body(request, ATTACHMENT_BODY_LIMIT)));
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
        if (url.pathname === '/api/settings' && method === 'GET') return json(response, 200, await client.settings());
        if (url.pathname === '/api/settings' && method === 'POST') return json(response, 200, await client.saveSettings(await body(request)));
        if (url.pathname === '/api/pruner' && method === 'POST') return json(response, 200, await client.savePruner(await body(request)));
        if (url.pathname === '/api/providers') return json(response, 200, method === 'GET' ? await client.providers() : await client.signIn(await body(request)));
        if (url.pathname === '/api/providers/settings') return json(response, 200, method === 'GET' ? await client.providerSettings() : await client.saveProvider(await body(request)));
        if (url.pathname === '/api/providers/key' && method === 'POST') return json(response, 200, await client.saveProviderKey(await body(request)));
        if (url.pathname === '/api/mcp') return json(response, 200, method === 'GET' ? await client.mcp() : await client.saveMcp(await body(request)));
        if (url.pathname === '/api/context/switches') return json(response, 200, method === 'GET' ? await client.contextSwitches() : await client.saveContextSwitches(await body(request)));
        if (url.pathname === '/api/hooks') return json(response, 200, method === 'GET' ? await client.hooks() : await client.saveHook(await body(request)));
        if (url.pathname === '/api/memories/reset' && method === 'POST') return json(response, 200, await client.resetMemories(await body(request)));
        if (url.pathname === '/api/workflows' && method === 'GET') {
          if([...url.searchParams.keys()].some(key=>key!=='threadId')||url.searchParams.getAll('threadId').length!==1)throw new BridgeError('Choose one workflow conversation');
          return json(response,200,await client.workflows(url.searchParams.get('threadId')));
        }
        if (url.pathname === '/api/workflows/run' && method === 'POST') return json(response,200,await client.runWorkflow(await body(request)));
        if (url.pathname === '/api/threads') {
          if (method === 'GET') return json(response, 200, await client.listThreads(pageQuery(url, true)));
          return json(response, 201, await client.createThread(await body(request)));
        }
        const thread = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(turns|steer|interrupt|resume|context|delete|rename|archive|unarchive|revert|fork|compact|review|git|permissions))?$/);
        if (thread) {
          const id = decodeURIComponent(thread[1]);
          if (!thread[2] && method === 'GET') return json(response, 200, await client.readThread(id, pageQuery(url)));
          if (thread[2] === 'context' && method === 'GET') return json(response, 200, await client.context(id));
          if (thread[2] === 'git' && method === 'GET') {
            if ([...url.searchParams.keys()].some(key => key !== 'view')) throw new BridgeError('Unsupported Git query');
            return json(response, 200, await client.git(id, url.searchParams.get('view')));
          }
          if (thread[2] && !['context', 'git'].includes(thread[2]) && method === 'POST') {
            const operation = { turns: 'send', steer: 'steer', interrupt: 'interrupt', resume: 'resume', delete: 'deleteThread', rename: 'renameThread', archive: 'archiveThread', unarchive: 'unarchiveThread', revert: 'revert', fork: 'forkThread', compact: 'compact', review: 'review', permissions: 'setPermissions' }[thread[2]];
            return json(response, 200, await client[operation](id, await body(request, ['send', 'steer'].includes(operation) ? ATTACHMENT_BODY_LIMIT : 65536)));
          }
          throw new BridgeError('Method is not allowed', 405);
        }
        const approval = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)$/);
        if (approval && method === 'POST') return json(response, 200, client.answerApproval(approval[1], await body(request)));
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
      if (!response.headersSent) json(response, error.status ?? (error.code === 'ENOENT' ? 404 : 500), { error: error instanceof BridgeError || error instanceof AttachmentError ? error.message : 'Application request failed' });
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
    async close() {
      if (closed) return; closed = true; clearInterval(heartbeat);
      for (const response of listeners) response.end(); listeners.clear();
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
