import { BridgeError, object, text, threadId } from './validate.mts';
import { MOTHER_MODEL } from './workflow-presets.mts';
import { createChatWorktree, isChatWorktreePath, releaseChatWorktree, restoreChatWorktree, undoChatWorktree } from './git.mjs';
import { defaultPermissionMode } from './elpis-features.mjs';
import { isAgentRun } from '../lib/agent-runs.mts';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PERMISSIONS, modeOf, permissionMode, permissionSetting } from './client-permissions.mts';
import { SOURCE_KINDS, internal_decorate, internal_forget, internal_itemsPage } from './client-thread-list.mts';
import { internal_browserOptions, internal_rpc } from './client-connection.mts';
import { internal_current } from './client-rewind.mts';
import { internal_folderOf } from './client-changes.mts';
import { internal_mutate } from './client-mutation.mts';
import { internal_providerModel } from './client-context.mts';
import type { DesktopClient } from './client.mts';
import type { ClientState } from './client-state.mts';

/** `agents`: the chat runs the agents canvas's graph, so the multi-agent runtime is on for it alone; the Ledger's
   * SUBAGENTS switch (features.multi_agent) keeps deciding whether a model may delegate in every other chat. */
export async function impl_createThread(this: DesktopClient, clientState: ClientState, raw?: unknown) {
    const body = object(raw, ['cwd', 'model', 'provider', 'name', 'instructions', 'permissions', 'worktree', 'agents', 'automatic']) as Record<string, unknown>;
    if (body.automatic !== undefined && typeof body.automatic !== 'boolean') throw new BridgeError('automatic must be true or false');
    if (body.worktree !== undefined && typeof body.worktree !== 'boolean') throw new BridgeError('worktree must be true or false');
    if (body.agents !== undefined && typeof body.agents !== 'boolean') throw new BridgeError('agents must be true or false');
    if (body.worktree && body.cwd === undefined) throw new BridgeError('A worktree needs the project\'s folder');
    // A chat started without a mode gets the default one explicitly (Settings > Default permissions; Full access when
    // the config names no approval policy), so the engine's own fallback, which asks, never decides it.
    const permissions = permissionMode(body.permissions) ?? await internal_defaultPermissions.call(this, clientState, body.cwd);
    const name = body.name === undefined ? undefined : text(body.name, 'agent name', 120).trim();
    const ownInstructions = body.instructions === undefined ? undefined : text(body.instructions, 'agent instructions', 32000);
    if (body.cwd !== undefined && !path.isAbsolute(text(body.cwd, 'working directory', 4096))) throw new BridgeError('Working directory must be absolute');
    let differentProvider = false;
    if (body.provider !== undefined) {
      text(body.provider, 'provider', 200);
      const settings = await this.settings();
      if (!settings.providers.some(provider => provider.id === body.provider)) throw new BridgeError('Choose an existing configured provider');
      if (settings.managed.modelProvider && settings.managed.modelProvider !== body.provider) throw new BridgeError('This provider is restricted by managed settings', 403);
      differentProvider = body.provider !== settings.main.provider;
    }
    if (differentProvider) text(body.model, 'model for this provider', 200);
    if (body.agents && body.model === undefined && !clientState.models.has(MOTHER_MODEL)) await this.models();
    const model = await internal_providerModel.call(this, clientState, body.model ?? (body.agents ? MOTHER_MODEL : undefined), body.provider);
    const instructions = [ownInstructions, await clientState.githubConnector.instructions()].filter(Boolean).join('\n\n');
    // Claude's "Start with worktree": the chat works in its own worktree on a new branch; if it does not start, the
    // worktree goes again.
    const made = body.worktree ? await createChatWorktree(body.cwd) : null, cwd = made?.cwd ?? body.cwd;
    const browserSession = `pending-${randomUUID()}`;
    const config = { ...internal_browserOptions.call(this, clientState, browserSession).config, ...(body.agents ? { 'features.multi_agent': true } : {}) };
    let result;
    try {
      result = await internal_rpc(this, clientState, 'thread/start', { ...(cwd ? { cwd } : {}), ...(model ? { model } : {}),
        ...(body.provider ? { modelProvider: body.provider } : {}), ...(instructions ? { developerInstructions: instructions } : {}), ...permissionSetting(permissions),
        elpisPermissionSource: body.permissions ? 'chat' : body.agents || body.automatic ? 'automatic' : 'default',
        ...(Object.keys(config).length ? { config } : {}) });
      threadId(result.thread?.id);
    } catch (error) { clientState.browserConfig?.close?.(browserSession); if (made) await undoChatWorktree(made); throw error; }
    clientState.browserConfig?.bind?.(browserSession, result.thread.id);
    clientState.owned.add(result.thread.id);
    if (name) { await internal_rpc(this, clientState, 'thread/name/set', { threadId: result.thread.id, name }); result.thread.name = name; }
    return { ...result, thread: internal_decorate.call(this, clientState, result.thread), permissions: modeOf(result), ...(made ? { worktree: { path: made.root, branch: made.branch } } : {}) };
  }

/** The default mode for a new chat in `cwd`, or nothing when the config combines its settings in another way. */
async function internal_defaultPermissions(this: DesktopClient, clientState: ClientState, cwd: unknown) {
    const mode = defaultPermissionMode(await internal_rpc(this, clientState, 'config/read', { includeLayers: true, ...(typeof cwd === 'string' && path.isAbsolute(cwd) ? { cwd } : {}) }));
    return Object.hasOwn(PERMISSIONS, mode) ? mode : undefined;
  }

/** After a chat is archived or deleted: its worktree, when it has one that no open chat still works in, is removed if
   * nothing in it is uncommitted, and kept otherwise (bridge/git.mjs releaseChatWorktree). */
async function internal_releaseWorktree(this: DesktopClient, clientState: ClientState, cwd: unknown) {
    if (!isChatWorktreePath(cwd)) return null;
    const inUse = await internal_rpc(this, clientState, 'thread/list', { cwd, limit: 1, modelProviders: [], sourceKinds: SOURCE_KINDS }).then(result => result.data?.length > 0, () => true);
    return inUse ? null : releaseChatWorktree(cwd);
  }

/** Deletes a chat and its agents. A chat that other chats were forked from cannot be deleted without them (Elpis
   * keeps the history a fork uses), so it is archived instead: it leaves the list and every fork keeps working.
   * 3 Nov, Masih: deleting a chat silently deleted its forks, among them the working Hermes chat. Never again. */
export async function impl_deleteThread(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown): Promise<{ deleted: boolean; archived?: boolean; alsoDeleted: string[]; worktree?: NonNullable<Awaited<ReturnType<typeof releaseChatWorktree>>> }> {
    object(body, []);
    return internal_mutate(clientState, id, async () => {
      const cwd = await internal_folderOf.call(this, clientState, id).catch(() => null);
      try { await internal_rpc(this, clientState, 'thread/delete', { threadId: id }); }
      catch (error) {
        if (!/forked history still references it/.test((error as Error).message)) throw error;
        await internal_rpc(this, clientState, 'thread/archive', { threadId: id });
        internal_forget.call(this, clientState, id as string);
        return { deleted: true, archived: true, alsoDeleted: [] };
      }
      internal_forget.call(this, clientState, id as string);
      const worktree = await internal_releaseWorktree.call(this, clientState, cwd);
      return { deleted: true, alsoDeleted: [], ...(worktree ? { worktree } : {}) };
    }, true);
  }

/** The composer's `!` deliberately uses the engine's user shell command, not a model turn. */
export async function impl_shellCommand(this: DesktopClient, clientState: ClientState, id?: unknown, raw?: unknown) {
    const body = object(raw, ['command']) as { command?: unknown };
    const command = text(body.command, 'shell command');
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('This agent accepts direct input only from its parent.', 409);
      return internal_rpc(this, clientState, 'thread/shellCommand', { threadId: id, command });
    });
  }

/** A side question inherits the current history but is never materialized as a saved session. */
export async function impl_createSideChat(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown) {
    object(body, []);
    const thread = await internal_current.call(this, clientState, id);
    const result = await internal_rpc(this, clientState, 'thread/fork', { threadId: id, ephemeral: true, excludeTurns: true,
      ...(thread.model ? { model: thread.model } : {}), ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
      approvalPolicy: 'never', permissions: ':danger-full-access' });
    const sideId = threadId(result.thread?.id);
    clientState.side.add(sideId);
    if (result.thread.ephemeral !== true) {
      try { await this.sideRpc('thread/delete', { threadId: sideId }); }
      finally { await this.sideRpc('thread/unsubscribe', { threadId: sideId }).catch(() => {}); }
      throw new BridgeError('The runtime did not create an ephemeral side chat. Update Elpis and try again.', 502);
    }
    clientState.sideChats.set(sideId, { turnId: null, starting: false, pending: null, closing: false });
    return { threadId: sideId };
  }

export async function impl_sendSideChat(this: DesktopClient, clientState: ClientState, id?: unknown, raw?: unknown) {
    const body = object(raw, ['text']) as { text?: unknown };
    const prompt = text(body.text, 'side question'), chat = clientState.sideChats.get(threadId(id));
    if (!chat) throw new BridgeError('Side chat is no longer available.', 404);
    if (chat.starting || chat.pending || chat.turnId || chat.closing) throw new BridgeError('A side reply is already running or closing.', 409);
    chat.starting = true;
    try {
      chat.pending = this.sideRpc('turn/start', { threadId: id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      const result = await chat.pending;
      // Completion can arrive before the acknowledgement; do not revive an already completed turn.
      if (chat.starting) chat.turnId = result.turn?.id;
      return result;
    } finally { chat.starting = false; chat.pending = null; }
  }

export async function impl_closeSideChat(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown) {
    object(body, []);
    const chat = clientState.sideChats.get(threadId(id));
    if (!chat) throw new BridgeError('Side chat is no longer available.', 404);
    chat.closing = true;
    if (chat.pending) await chat.pending.catch(() => {});
    try { if (chat.turnId) await this.sideRpc('turn/interrupt', { threadId: id, turnId: chat.turnId }); }
    finally { await this.sideRpc('thread/unsubscribe', { threadId: id }); }
    clientState.sideChats.delete(id);
    return { closed: true };
  }

/** The Claude Code chats the engine would import: its own detection (the last 30 days, up to 50, none already imported). */
export async function impl_externalSessions(this: DesktopClient, clientState: ClientState) {
    const result = await internal_rpc(this, clientState, 'externalAgentConfig/detect', { includeHome: true, source: 'claude' });
    return (result.items ?? []).filter((item: { itemType?: unknown }) => item.itemType === 'SESSIONS').flatMap((item: { details?: { sessions?: { path?: unknown; cwd?: unknown; title?: unknown }[] } }) => (item.details?.sessions ?? []).map(({ path, cwd, title }) => ({ path, cwd, title })));
  }

/** Registers a Codex rollout already copied into Elpis's sessions folder, so it lists, opens and forks like a chat Elpis made. */
export async function impl_registerRollout(this: DesktopClient, clientState: ClientState, rollout?: unknown) {
    text(rollout, 'rollout', 4096);
    return (await internal_rpc(this, clientState, 'thread/register', { path: rollout })).thread;
  }

/** Imports Claude Code chats as Elpis chats and resolves when the engine has finished them: { imported, skipped: [reasons] }. */
export async function impl_importExternalSessions(this: DesktopClient, clientState: ClientState, sessions?: unknown) {
    if (!Array.isArray(sessions) || !sessions.length) return { imported: 0, skipped: [] };
    const { importId } = await internal_rpc(this, clientState, 'externalAgentConfig/import', { source: 'claude', migrationItems: [{ itemType: 'SESSIONS', description: 'Claude Code chats', cwd: null, details: { sessions } }] });
    for (let wait = 0; wait < 600; wait++) {
      const { data = [] } = await internal_rpc(this, clientState, 'externalAgentConfig/import/readHistories');
      const done = data.find((item: { importId?: unknown }) => item.importId === importId);
      if (done) return { imported: done.successes.length, skipped: done.failures.map((failure: { message?: unknown }) => failure.message) };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new BridgeError('The import is taking longer than expected. It carries on in the background; look again in a minute.', 504);
  }

export async function impl_forkThread(this: DesktopClient, clientState: ClientState, id?: unknown, raw?: unknown) {
    const body = object(raw, ['lastTurnId', 'lastItemId']) as { lastTurnId?: unknown; lastItemId?: unknown };
    const lastTurnId = body.lastTurnId === undefined ? undefined : text(body.lastTurnId, 'turn ID', 200);
    const lastItemId = body.lastItemId === undefined ? undefined : text(body.lastItemId, 'message ID', 200);
    if (lastItemId && !lastTurnId) throw new BridgeError('Choose the turn containing this message');
    const thread = await internal_current.call(this, clientState, id);
    if (isAgentRun(thread) && !thread.desktopAccess.canContinue) throw new BridgeError('Wait for this background run to finish before continuing here.', 409);
    try { return await internal_forkChat.call(this, clientState, thread, lastTurnId); }
    catch (error) {
      const failure = error as { engineMessage?: string; message?: string };
      if (!lastTurnId || !/turn not found|lastTurnId .*was not found/i.test(failure.engineMessage ?? failure.message ?? '')) throw error;
      // A rendered message can retain a live turn ID after history is reconciled.
      // Recover only by the exact saved message, never by the latest turn.
      if (lastItemId) {
        let cursor: string | null | undefined;
        const seen = new Set();
        for (let page = 0; page < 20; page++) {
          const items = await internal_itemsPage.call(this, clientState, { threadId: id, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
          const entry = items.data?.find((row: { item?: { id?: unknown; type?: unknown } }) => row.item?.id === lastItemId && row.item.type === 'agentMessage');
          if (entry?.turnId && entry.turnId !== lastTurnId) return internal_forkChat.call(this, clientState, thread, entry.turnId);
          if (entry || !items.nextCursor || seen.has(items.nextCursor)) break;
          cursor = items.nextCursor; seen.add(cursor);
        }
      }
      throw new BridgeError('That message no longer has a saved fork point. Refresh this conversation and fork from the saved reply.', 409);
    }
  }

async function internal_forkChat(this: DesktopClient, clientState: ClientState, thread: { id: string; model?: unknown; modelProvider?: unknown; name?: string | null | undefined; preview?: string | null | undefined }, lastTurnId: unknown, suffix = 'fork', model: Record<string, unknown> = {}) {
    const browserSession = `pending-${randomUUID()}`;
    const fork = await internal_rpc(this, clientState, 'thread/fork', { threadId: thread.id, ...(lastTurnId ? { lastTurnId } : {}), ...(thread.model ? { model: thread.model } : {}), ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}), ...model, ...internal_browserOptions.call(this, clientState, browserSession) }).catch(error => { clientState.browserConfig?.close?.(browserSession); throw error; });
    threadId(fork.thread?.id); clientState.browserConfig?.bind?.(browserSession, fork.thread.id); clientState.owned.add(fork.thread.id);
    await clientState.versions.list(fork.thread.id, true).catch(() => {});
    const name = `${(thread.name?.trim() || (String(thread.preview ?? '').split('\n')[0] as string).trim() || 'Chat').slice(0, 110)} (${suffix})`;
    try { await internal_rpc(this, clientState, 'thread/name/set', { threadId: fork.thread.id, name }); fork.thread.name = name; } catch { /* The fork stands; it keeps its default title. */ }
    return { thread: internal_decorate.call(this, clientState, fork.thread) };
  }

/** Explicitly continue a finished agent history in a user-owned chat, without starting a turn. */
export async function impl_continueThread(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown) {
    object(body, []);
    return internal_mutate(clientState, id, async () => {
      // A completed child can be read and forked even if its parent is not loaded; attaching it would fail.
      const result = await internal_rpc(this, clientState, 'thread/read', { threadId: threadId(id), includeTurns: false });
      if (result.thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
      const thread = internal_decorate.call(this, clientState, result.thread);
      if (thread.desktopAccess.writable) throw new BridgeError('This is already a normal chat.', 409);
      if (!thread.desktopAccess.canContinue) throw new BridgeError('Wait for this background run to finish before continuing here.', 409);
      return internal_forkChat.call(this, clientState, thread, undefined, 'continued');
    });
  }

export async function impl_renameThread(this: DesktopClient, clientState: ClientState, id?: unknown, raw?: unknown) {
    const body = object(raw, ['name']) as { name?: unknown }; const name = text(body.name, 'name', 120).trim();
    if (!name) throw new BridgeError('Enter a name');
    return internal_mutate(clientState, id, async () => {
      await internal_rpc(this, clientState, 'thread/name/set', { threadId: threadId(id), name });
      return { thread: { ...(await internal_current.call(this, clientState, id)), name } };
    });
  }

/** The IDs of every chat listed under this one that is not archived: its agents and the chats it made. */
async function internal_listedUnder(this: DesktopClient, _clientState: ClientState, id: unknown) {
    const ids = [];
    let cursor: string | null | undefined;
    for (;;) {
      const page = await this.listThreads({ ancestorThreadId: id, limit: 100, ...(cursor ? { cursor } : {}) }).catch(() => ({ data: [], nextCursor: null }));
      ids.push(...page.data.map((thread: { id: string }) => thread.id));
      if (!page.nextCursor || page.nextCursor === cursor) return ids;
      cursor = page.nextCursor;
    }
  }

/** Archives a chat and, natively, the agents it spawned; Elpis announces each with thread/archived. The agents archived
   * with it are kept in its archive record, so Unarchive brings them back with it. */
export async function impl_archiveThread(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown) {
    object(body, []);
    const agents = await internal_listedUnder.call(this, clientState, id);
    const archived = await internal_mutate(clientState, id, async () => {
      const cwd = await internal_folderOf.call(this, clientState, threadId(id)).catch(() => null);
      await clientState.archiveHistory.record(id as string, 'Archived by you.', agents);
      try { await internal_rpc(this, clientState, 'thread/archive', { threadId: id }); }
      catch (error) { await clientState.archiveHistory.forget(id as string); throw error; }
      await clientState.rewindHistory.hide(id as string, true);
      internal_forget.call(this, clientState, id as string);
      const worktree = await internal_releaseWorktree.call(this, clientState, cwd);
      return { archived: true, ...(worktree ? { worktree } : {}) };
    }, true);
    // The engine archives its own spawn tree with the chat (codex thread_archive_response). Archive everything else listed under
    // the chat too (the chats it made with create_thread, anything the engine left), so deleting it leaves nothing behind.
    for (const child of await internal_listedUnder.call(this, clientState, id)) await this.archiveThread(child, {}).catch(() => {});
    return archived;
  }

/** Brings a chat and its archived agents back, restoring a removed worktree. `restored` names the agents. */
export async function impl_unarchiveThread(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown): Promise<{ thread: ReturnType<typeof internal_decorate>; worktree?: NonNullable<Awaited<ReturnType<typeof restoreChatWorktree>>>; restored?: string[] }> {
    object(body, []);
    const { agents, ...back } = await internal_mutate(clientState, id, async () => {
      const saved = await clientState.archiveHistory.read(threadId(id)).catch(() => null);
      const result = await internal_rpc(this, clientState, 'thread/unarchive', { threadId: id });
      if (result.thread?.id !== id) throw new BridgeError('Elpis restored another thread', 502);
      await clientState.archiveHistory.forget(id as string);
      await clientState.rewindHistory.hide(id as string, false);
      const worktree = isChatWorktreePath(result.thread.cwd) ? await restoreChatWorktree(result.thread.cwd) : null;
      return { thread: internal_decorate.call(this, clientState, result.thread), ...(worktree ? { worktree } : {}), agents: Array.isArray(saved?.agents) ? saved.agents : [] };
    });
    const restored: string[] = [];
    for (const agent of agents) {
      if (restored.includes(agent)) continue;
      // An agent already back, or deleted since, has nothing to restore.
      try { const result = await this.unarchiveThread(agent, {}); restored.push(agent, ...(result.restored ?? []).filter(other => !restored.includes(other))); } catch { /* see above */ }
    }
    return { ...back, ...(restored.length ? { restored } : {}) };
  }
