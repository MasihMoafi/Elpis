import fs from 'node:fs/promises';
import { BridgeError, object } from './client.mts';
import { ATTACHMENT_BODY_LIMIT, PDF_BODY_LIMIT, extractPdf } from './attachments.mts';
import { devServerRequest } from './dev-servers.mjs';
import { listDirectory, listFiles, readFile, readFileAsset, searchFiles, writeFile } from './files.mts';
import { listFolders, projectDirectory } from './folders.mts';
import { isRepository } from './git.mjs';
import { dismissPersonalTip, openPersonal, personalStatus } from './personal.mts';
import { body, cwdOf, json } from './server-http.mjs';

/** @param {import('./server-http.mjs').ServerState} state @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {URL} url @param {string} method */
export async function handleFileRoutes(state, request, response, url, method) {
  const { client, options, devServers, importChats, improvements } = state;
  if (url.pathname === '/api/dev-servers' || url.pathname.startsWith('/api/dev-servers/')) {
    json(response, 200, await devServerRequest(devServers, method, url, method === 'POST' ? await body(request) : undefined));
    return true;
  }
  if (url.pathname === '/api/import-chats' && method === 'GET') { json(response, 200, await importChats.list()); return true; }
  if (url.pathname === '/api/import-chats' && method === 'POST') { json(response, 200, await importChats.run(await body(request))); return true; }
  // Observability (5 Nov): the selected chat's rollout projected as the TUI's /dashboard does (bridge/trajectory-projection.mts).
  if (url.pathname === '/api/trajectory' && method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'thread') || url.searchParams.getAll('thread').length !== 1) throw new BridgeError('Open a chat to see its trajectory.', 400);
    const thread = await client.readThreadMetadata(url.searchParams.get('thread'));
    if (typeof thread.path !== 'string' || !thread.path) throw new BridgeError('This chat has no recorded history yet.', 404);
    const { project } = await import('./trajectory-projection.mts');
    json(response, 200, project(await fs.readFile(thread.path, 'utf8'))); return true;
  }
  if (url.pathname === '/api/improvements/source') {
    const store = await improvements();
    if (method === 'GET') { json(response, 200, await store.source()); return true; }
    if (method === 'POST') { json(response, 200, await store.setSource(await body(request))); return true; }
  }
  if (url.pathname === '/api/improvements') {
    const store = await improvements();
    json(response, method === 'POST' ? 201 : 200, method === 'POST' ? await store.start(await body(request, ATTACHMENT_BODY_LIMIT)) : { data: store.list() });
    return true;
  }
  const improvement = url.pathname.match(/^\/api\/improvements\/([a-f0-9-]+)(?:\/(check))?$/);
  if (improvement) {
    const store = await improvements();
    if (method === 'GET' && !improvement[2]) { json(response, 200, await store.get(improvement[1])); return true; }
    if (method === 'POST' && improvement[2] === 'check') { object(await body(request), []); json(response, 200, await store.check(improvement[1])); return true; }
    throw new BridgeError('Method is not allowed', 405);
  }
  if (url.pathname === '/api/personal' && method === 'GET') { json(response, 200, await personalStatus(options.elpisHome)); return true; }
  if (url.pathname === '/api/personal' && method === 'POST') {
    const input = /** @type {{ action?: string }} */ (object(await body(request), ['action']));
    if (!input.action || !['open', 'dismiss'].includes(input.action)) throw new BridgeError('Choose open or dismiss');
    json(response, 200, await (input.action === 'open' ? openPersonal : dismissPersonalTip)(options.elpisHome)); return true;
  }
  if (url.pathname === '/api/attachments/extract' && method === 'POST') { json(response, 200, await extractPdf(await body(request, PDF_BODY_LIMIT))); return true; }
  if (url.pathname === '/api/folders' && method === 'GET') { json(response, 200, await listFolders(cwdOf(url))); return true; }
  if (url.pathname === '/api/files' && method === 'GET') { json(response, 200, await listFiles(cwdOf(url))); return true; }
  // The Files pane: a folder's entries, a file's text and saving it, a search of the contents.
  if (url.pathname === '/api/files/dir' && method === 'GET') { json(response, 200, await listDirectory(cwdOf(url, 'dir', 'hidden'), url.searchParams.get('dir') ?? '', url.searchParams.get('hidden') === '1')); return true; }
  if (url.pathname === '/api/files/search' && method === 'GET') { json(response, 200, await searchFiles(cwdOf(url, 'q'), url.searchParams.get('q') ?? '')); return true; }
  if (url.pathname === '/api/file/asset' && method === 'GET') {
    const asset = await readFileAsset(cwdOf(url, 'path'), url.searchParams.get('path') ?? '');
    // Only these validated passive assets may be framed by the private app. Other routes retain DENY.
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
    const filename = encodeURIComponent(asset.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    response.writeHead(200, { 'Content-Type': asset.mimeType, 'Content-Length': asset.bytes.length, 'Content-Disposition': `inline; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store' });
    response.end(asset.bytes); return true;
  }
  if (url.pathname === '/api/file' && method === 'GET') { json(response, 200, await readFile(cwdOf(url, 'path'), url.searchParams.get('path') ?? '')); return true; }
  if (url.pathname === '/api/file' && method === 'POST') {
    const edit = /** @type {{ cwd?: unknown, path?: unknown, content?: unknown, mtimeMs?: unknown }} */ (object(await body(request, 3 * 1024 * 1024), ['cwd', 'path', 'content', 'mtimeMs']));
    json(response, 200, await writeFile(edit.cwd, edit.path, edit.content, edit.mtimeMs)); return true;
  }
  // Whether the project is a Git repository with a commit: the canvas asks for worktree isolation only then.
  if (url.pathname === '/api/repository' && method === 'GET') { json(response, 200, { repository: await isRepository(await projectDirectory(cwdOf(url))) }); return true; }
  return false;
}
