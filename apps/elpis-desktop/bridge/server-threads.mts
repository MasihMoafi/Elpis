import { createHash } from 'node:crypto';
import { BridgeError, object } from './validate.mts';
import { ATTACHMENT_BODY_LIMIT } from './attachments.mts';
import { smartPruneDetail } from './smart-prune.mts';
import { body, json, pageQuery } from './server-http.mts';
import { prepareLoveSpotTurn } from './server-love-spot.mts';

/** Provider continuations include consumed native item IDs and can exceed the HTTP
 * query limit. Keep that engine state here; the renderer gets a short, chat-bound
 * continuation. The prompt index uses the engine directly and cannot evict these. */
export function createHistoryCursors() {
  const historyCursors = new Map<string, { id: string, cursor: string }>();
  return {
    expose(id: string, cursor: unknown) {
      if (typeof cursor !== 'string' || cursor.length <= 4096) return cursor;
      const token = 'desktop-page:' + createHash('sha256').update(id).update('\0').update(cursor).digest('base64url');
      historyCursors.delete(token);
      historyCursors.set(token, { id, cursor });
      const oldest = historyCursors.keys().next().value;
      if (historyCursors.size > 256 && oldest !== undefined) historyCursors.delete(oldest);
      return token;
    },
    resolve(id: string, cursor: string | undefined) {
      if (!cursor?.startsWith('desktop-page:')) return cursor;
      const saved = historyCursors.get(cursor);
      if (!saved || saved.id !== id) throw new BridgeError('This conversation history page has expired. Reopen the chat and try again.');
      historyCursors.delete(cursor); historyCursors.set(cursor, saved);
      return saved.cursor;
    },
  };
}

const THREAD_POST_OPS: Record<string, 'send' | 'steer' | 'interrupt' | 'resume' | 'continueThread' | 'deleteThread' | 'renameThread' | 'archiveThread' | 'unarchiveThread' | 'revert' | 'rewind' | 'versions' | 'forkThread' | 'compact' | 'review' | 'setPermissions' | 'setEffort' | 'setServiceTier' | 'setFolder'> = {
  turns: 'send', steer: 'steer', interrupt: 'interrupt', resume: 'resume', continue: 'continueThread',
  delete: 'deleteThread', rename: 'renameThread', archive: 'archiveThread', unarchive: 'unarchiveThread',
  revert: 'revert', rewind: 'rewind', versions: 'versions', fork: 'forkThread', compact: 'compact',
  review: 'review', permissions: 'setPermissions', effort: 'setEffort', 'service-tier': 'setServiceTier', folder: 'setFolder',
};

export async function handleThreadRoutes(state: import('./server-http.mts').ServerState, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, method: string) {
  const { client, options, trash, loveSpot, historyCursors } = state;
  const media = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/items\/([^/]+)\/media\/(\d{1,3})$/);
  if (media && method === 'GET') {
    const [threadId, turnId, itemId] = media.slice(1, 4).map(decodeURIComponent);
    const asset = await client.media(threadId, turnId, itemId, Number(media[4]));
    response.writeHead(200, { 'Content-Type': asset.mimeType, 'Content-Length': asset.bytes.length, 'Cache-Control': 'no-store' });
    response.end(asset.bytes); return true;
  }
  const inlinePrune = url.pathname.match(/^\/api\/threads\/([^/]+)\/smart-prune\/([^/]+)\/([^/]+)$/);
  if (inlinePrune && method === 'GET') {
    const [threadId, turnId, itemId] = inlinePrune.slice(1).map(decodeURIComponent);
    json(response, 200, await smartPruneDetail(options.elpisHome, threadId, turnId, itemId)); return true;
  }
  // Sidebar deletion: archived now, Ctrl+Z brings back the newest, quitting deletes for good.
  if (url.pathname === '/api/trash' && method === 'POST') {
    const input = /** @type {{ threadIds?: unknown }} */ (object(await body(request), ['threadIds']));
    json(response, 200, await trash.trash(input.threadIds)); return true;
  }
  if (url.pathname === '/api/trash/undo' && method === 'POST') { object(await body(request), []); json(response, 200, await trash.undo()); return true; }
  if (url.pathname === '/api/threads') {
    if (method === 'GET') {
      const query = pageQuery(url, true), listed = await (query.archived && client.listArchivedThreads ? client.listArchivedThreads(query) : client.listThreads(query));
      // A chat waiting to be deleted is archived, but it is not an archived chat.
      const data = await state.mother.list(query.archived ? listed.data.filter((item: { id: string }) => !trash.has(item.id)) : listed.data, query, trash.has);
      json(response, 200, { ...listed, data });
      return true;
    }
    json(response, 201, await client.createThread(await body(request))); return true;
  }
  const sideChat = url.pathname.match(/^\/api\/side-chats\/([^/]+)\/(turns|close)$/);
  if (sideChat && method === 'POST') {
    const sideId = decodeURIComponent(sideChat[1] ?? '');
    json(response, 200, await (sideChat[2] === 'turns' ? client.sendSideChat(sideId, await body(request)) : client.closeSideChat(sideId, await body(request))));
    return true;
  }
  const contextFiles = url.pathname.match(/^\/api\/threads\/([^/]+)\/context-files$/);
  if (contextFiles) {
    const id = decodeURIComponent(contextFiles[1] ?? '');
    if (method === 'GET') { json(response, 200, await client.contextFiles(id)); return true; }
    if (method === 'POST') { json(response, 200, await client.setContextFile(id, await body(request))); return true; }
  }
  const sessionContext = url.pathname.match(/^\/api\/threads\/([^/]+)\/(goal|session-context|session-intent)$/);
  if (sessionContext) {
    const id = decodeURIComponent(sessionContext[1] ?? ''), action = sessionContext[2];
    if (action === 'goal' && method === 'GET') { json(response, 200, await client.goal(id)); return true; }
    if (action === 'goal' && method === 'POST') { json(response, 200, await client.setGoal(id, await body(request))); return true; }
    if (action === 'session-context' && method === 'GET') { json(response, 200, await client.sessionContext(id)); return true; }
    if (action === 'session-intent' && method === 'POST') { json(response, 201, await client.createSessionIntent(id, await body(request))); return true; }
    throw new BridgeError('Method is not allowed', 405);
  }
  const thread = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(turns|steer|interrupt|resume|continue|context|prompts|delete|rename|archive|unarchive|revert|rewind|versions|fork|compact|review|git|permissions|effort|service-tier|folder|shell|side-chat))?$/);
  if (thread) {
    const id = decodeURIComponent(thread[1] ?? '');
    if (thread[2] === 'shell' && method === 'POST') { json(response, 200, await client.shellCommand(id, await body(request))); return true; }
    if (thread[2] === 'side-chat' && method === 'POST') { json(response, 200, await client.createSideChat(id, await body(request))); return true; }
    if (!thread[2] && method === 'GET') {
      const query = pageQuery(url);
      if (query.cursor) query.cursor = historyCursors.resolve(id, query.cursor);
      const page = await client.readThread(id, query);
      json(response, 200, { ...page, thread: state.mother.decorate(page.thread), nextCursor: historyCursors.expose(id, page.nextCursor) }); return true;
    }
    if (thread[2] === 'prompts' && method === 'GET') { json(response, 200, await client.readPrompts(id)); return true; }
    if (thread[2] === 'context' && method === 'GET') { json(response, 200, await client.context(id)); return true; }
    if (thread[2] === 'git' && method === 'GET') {
      if ([...url.searchParams.keys()].some(key => key !== 'view' && key !== 'path') || url.searchParams.getAll('view').length !== 1 || url.searchParams.getAll('path').length > 1) throw new BridgeError('Unsupported Git query');
      json(response, 200, await client.git(id, url.searchParams.get('view'), url.searchParams.get('path') ?? undefined)); return true;
    }
    if (thread[2] === 'git' && method === 'POST') { json(response, 200, await client.discardChange(id, await body(request, 65536))); return true; }
    const operation = thread[2] ? THREAD_POST_OPS[thread[2]] : undefined;
    if (operation && method === 'POST') {
      const input = await body(request, ['send', 'steer'].includes(operation) ? ATTACHMENT_BODY_LIMIT : 65536);
      if (['send', 'steer'].includes(operation) && state.mother.owns(id)) { json(response, 200, await state.mother.send(id, input)); return true; }
      await prepareLoveSpotTurn(loveSpot, id, operation, input);
      const result = await state.mother.mutate(id, operation, () => client[operation](id, input));
      json(response, 200, operation === 'resume' ? state.mother.resumed(id, result as { thread?: { id: string } }) : result); return true;
    }
    throw new BridgeError('Method is not allowed', 405);
  }
  const approval = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)(\/instead)?$/);
  if (approval && method === 'POST') { json(response, 200, approval[2] ? await client.denyInstead(approval[1], await body(request)) : client.answerApproval(approval[1], await body(request))); return true; }
  return false;
}
