import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, MAX_BRIDGE_MESSAGE_BYTES } from './client.mjs';
import { AttachmentError } from './attachments.mts';

export const COOKIE = 'elpis_desktop';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
export const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ERROR_CAUSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);
export const ERROR_AREAS = new Set(['session', 'health', 'models', 'threads', 'settings', 'providers', 'approvals', 'workflows', 'files', 'file', 'folders', 'repository', 'tools', 'context', 'customize', 'mcp', 'hooks', 'events', 'dev-servers', 'love-spot', 'import-chats']);

/** Only fixed categories and numeric runtime codes enter this bounded log. Never serialize an error or request. */
export function requestDiagnostics(home) {
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
export function cwdOf(url, ...others) {
  if ([...url.searchParams.keys()].some(key => key !== 'cwd' && !others.includes(key)) || url.searchParams.getAll('cwd').length !== 1 || others.some(key => url.searchParams.getAll(key).length > 1)) throw new BridgeError('Provide exactly one cwd');
  return url.searchParams.get('cwd');
}

export function pageQuery(url, ancestor = false, models = false) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!['limit', 'cursor', ...(ancestor ? ['ancestorThreadId', 'archived', 'searchTerm', 'includeAgentRuns'] : []), ...(models ? ['provider', 'inputModality', 'outputModality', 'refresh'] : [])].includes(key) || result[key] !== undefined) throw new BridgeError('Unsupported query parameter');
    if (key === 'searchTerm') {
      if (!value.trim() || value.length > 200) throw new BridgeError('Search must contain 1 through 200 characters');
      result.searchTerm = value.trim();
    } else if (key === 'archived' || key === 'includeAgentRuns' || key === 'refresh') {
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

export async function body(request, limit = 65536) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new BridgeError('JSON content type required', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > limit) throw new BridgeError('Request is too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BridgeError('Invalid JSON'); }
}

export function json(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BRIDGE_MESSAGE_BYTES) return json(response, 413, { error: 'Response is too large; request a smaller page' });
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length }); response.end(bytes);
}

export function applySecurityHeaders(response, requestId) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

export function applyFrameHeaders(url, response) {
  // The split document and Obsidian plugin panes permit embedding by the local application or Obsidian.
  if ((url.pathname === '/' || url.pathname === '/love-spot.html') && url.searchParams.get('pane') === '1') {
    response.removeHeader('X-Frame-Options');
    response.setHeader('Content-Security-Policy', String(response.getHeader('Content-Security-Policy')).replace("frame-ancestors 'none'", "frame-ancestors 'self' app://obsidian.md"));
  }
  // Observability frames the Trajectory page; only the application itself may embed it.
  if (url.pathname.startsWith('/trajectory/')) {
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Content-Security-Policy', String(response.getHeader('Content-Security-Policy')).replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  }
}

export async function serveStaticAsset(staticDir, url, request, response) {
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
}

export async function sendRequestError(error, request, response, requestId, area, diagnose) {
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
