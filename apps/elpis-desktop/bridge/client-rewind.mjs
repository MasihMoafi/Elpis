import { BridgeError, object, text, threadId } from './validate.mjs';
import { ragMessage } from './rag-command.mjs';
import { randomUUID } from 'node:crypto';
import { replacementEligibility } from '../lib/turn-replacement.ts';
import { archivedSession } from './client-protocol.mjs';
import { modeOf } from './client-permissions.mjs';
import { internal_attach, internal_decorate, internal_forgetSubscription, internal_itemsPage } from './client-thread-list.mjs';
import { internal_chatModel } from './client-context.mjs';
import { internal_mutate } from './client-mutation.mjs';
import { internal_rpc } from './client-connection.mjs';

const SUBAGENT_POLICY = {
  enabled: 'Subagents are enabled and optional. Any earlier instructions requiring delegation or restricting delegation to explicit requests no longer apply. Use your judgment to work directly or delegate when useful; enabling this option never requires spawning an agent. Honor explicit user requests and applicable instructions about whether to delegate.',
  disabled: 'Subagents are disabled. Any earlier instructions enabling delegation no longer apply. Do all work in this thread. Do not start, resume, or delegate to other agents, even when a user request, AGENTS.md, or skill asks for delegation. This includes shell-launched agents (claude, codex, agy, elpis, gemini), scripts, wrappers, background processes, agent tools, and MCP delegate tools such as elpis-agents. Do not bypass this switch through another tool or executable path. The user must enable Subagents before delegation can resume.',
};

const EFFORT = /^[a-z]{2,16}$/;

/** Edit-and-resend and regenerate: Elpis drops the given turn and every later one (thread/revert), then the new text starts a turn.
   * Without `text` it is Rewind to here: the turns are dropped and nothing else happens. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_revert(clientState, id, raw) {
    const body = /** @type {Record<string, unknown>} */ (raw);
    const rewind = body?.text === undefined && body?.model === undefined && body?.effort === undefined;
    object(body, rewind ? ['beforeTurnId'] : ['beforeTurnId', 'text', 'model', 'effort']);
    const beforeTurnId = text(body.beforeTurnId, 'turn ID', 200);
    const typed = rewind || (typeof body.text === 'string' && !body.text.trim()) ? [] : [{ type: 'text', text: ragMessage(text(body.text, 'message')), text_elements: [] }];
    const effort = internal_effort.call(this, clientState, body.effort);
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Elpis takes turns for this agent only from its parent, so its earlier messages cannot be replaced here.', 409);
      if (thread.status?.type === 'active') throw new BridgeError('Stop the running turn before replacing an earlier message.', 409);
      if (rewind) { await internal_rpc.call(this, clientState, 'thread/revert', { threadId: id, beforeTurnId }); return { rewound: true, beforeTurnId }; }
      const model = await internal_chatModel.call(this, clientState, body.model, thread.modelProvider);
      const entries = [], cursors = new Set();
      /** @type {string | null | undefined} */ let cursor;
      let complete = false;
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const page = await internal_itemsPage.call(this, clientState, { threadId: id, turnId: beforeTurnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data) || page.data.some(/** @param {{ turnId?: unknown } | null} entry */ entry => entry?.turnId !== beforeTurnId)) throw new BridgeError('Elpis could not verify the original input for this turn. Nothing was replaced.', 409);
        entries.push(...page.data);
        if (page.nextCursor === null) { complete = true; break; }
        if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) throw new BridgeError('Elpis could not read the complete turn. Nothing was replaced.', 409);
        cursor = page.nextCursor; cursors.add(cursor);
      }
      if (!complete) throw new BridgeError('This turn is too large to verify for replacement in this app. Nothing was replaced.', 409);
      const eligibility = replacementEligibility(entries, beforeTurnId, { historyComplete: true });
      if (!eligibility.allowed) throw new BridgeError(eligibility.reason, 409);
      // The edited text goes first; the message's files, images and quoted replies go with it, unchanged.
      const input = [...typed, ...eligibility.kept];
      if (!input.length) throw new BridgeError('Write a message');
      // As ChatGPT does, the chat as it was stays one click away (‹ 1/2 ›): an archived copy keeps it.
      const moved = await internal_turnIdsFrom.call(this, clientState, id, beforeTurnId);
      const copy = await internal_keepVersion.call(this, clientState, thread);
      try { await internal_rpc.call(this, clientState, 'thread/revert', { threadId: id, beforeTurnId }); }
      catch (error) { await internal_rpc.call(this, clientState, 'thread/delete', { threadId: copy }).catch(() => {}); throw error; }
      let started, sendError;
      try { started = await internal_startTurn.call(this, clientState, thread, { threadId: id, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }); }
      catch (error) { sendError = `Conversation was rewound, but its replacement message was not confirmed: ${error instanceof Error ? error.message : String(error)}`; }
      await clientState.versions.record(id, beforeTurnId, copy, started?.turn?.id, moved);
      return sendError ? { rewound: true, beforeTurnId, sendError } : started;
    });
  }

/** The turn IDs from `fromTurnId` to the end, oldest first: what a replacement moves into the kept version. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {string} fromTurnId */
async function internal_turnIdsFrom(clientState, id, fromTurnId) {
    const ids = [], seen = new Set();
    /** @type {string | null | undefined} */ let cursor;
    for (let page = 0; page < 50; page++) {
      const result = await internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 100, sortDirection: 'asc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) });
      ids.push(...(result.data ?? []).map(/** @param {{ id: string }} turn */ turn => turn.id));
      if (!(cursor = result.nextCursor) || seen.has(cursor)) break;
      seen.add(cursor);
    }
    const at = ids.indexOf(fromTurnId);
    return at < 0 ? [fromTurnId] : ids.slice(at);
  }

/** An archived copy of the whole chat, under the same name; its ID. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {{ id: string, model?: unknown, modelProvider?: unknown, name?: string | null, preview?: string | null }} thread */
async function internal_keepVersion(clientState, thread) {
    const fork = await internal_rpc.call(this, clientState, 'thread/fork', { threadId: thread.id, ...(thread.model ? { model: thread.model } : {}), ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}) });
    const copy = threadId(fork.thread?.id);
    if (copy === thread.id) throw new BridgeError('Could not keep the earlier version of this chat. Nothing was replaced.', 502);
    try {
      const name = thread.name?.trim() || /** @type {string} */ (String(thread.preview ?? '').split('\n')[0]).trim().slice(0, 120);
      if (name) await internal_rpc.call(this, clientState, 'thread/name/set', { threadId: copy, name });
      await internal_rpc.call(this, clientState, 'thread/archive', { threadId: copy }); internal_forgetSubscription.call(this, clientState, copy);
    } catch (error) { await internal_rpc.call(this, clientState, 'thread/delete', { threadId: copy }).catch(() => {}); throw new BridgeError(`Could not keep the earlier version of this chat. Nothing was replaced. ${/** @type {Error} */ (error).message ?? ''}`.trim(), 502); }
    return copy;
  }

/** ChatGPT's ‹ 1/2 › under an edited message. `{ action: 'list' }` gives this chat's versions; `{ action: 'switch', threadId }`
   * shows another version of one of its messages in its place: that chat comes back and this one is archived. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw @returns {Promise<{ versions?: Awaited<ReturnType<import('./message-versions.mjs').MessageVersions['of']>>, thread?: ReturnType<typeof internal_decorate> }>} */
export async function impl_versions(clientState, id, raw) {
    const body = /** @type {{ action?: unknown, threadId?: unknown }} */ (object(raw, ['action', 'threadId']));
    if (body.action === 'list') return { versions: await clientState.versions.of(threadId(id)) };
    if (body.action !== 'switch') throw new BridgeError('Choose a version action.');
    const target = threadId(body.threadId);
    if (!(await clientState.versions.of(/** @type {string} */ (id))).some(/** @param {{ previous?: unknown, next?: unknown }} version */ version => version.previous === target || version.next === target)) throw new BridgeError('That version is no longer linked to this chat.', 409);
    return internal_mutate(clientState, id, async () => {
      const current = await internal_current.call(this, clientState, id);
      if (current.status?.type === 'active') throw new BridgeError('Stop the running turn before showing another version.', 409);
      const result = await internal_rpc.call(this, clientState, 'thread/unarchive', { threadId: target });
      try { await internal_rpc.call(this, clientState, 'thread/archive', { threadId: id }); internal_forgetSubscription.call(this, clientState, id); }
      catch (error) { await internal_rpc.call(this, clientState, 'thread/archive', { threadId: target }).catch(() => {}); throw error; }
      await clientState.versions.list(id, false); await clientState.versions.list(target, true);
      await internal_attach.call(this, clientState, target);
      return { thread: internal_decorate.call(this, clientState, result.thread) };
    });
  }

/** Claude's restore scopes. File checkpoints are bridge-owned; native forks keep Undo/Redo lossless. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_rewind(clientState, id, raw) {
    const body = /** @type {{ action?: unknown, beforeTurnId?: unknown, mode?: unknown, version?: unknown }} */ (object(raw, ['action', 'beforeTurnId', 'mode', 'version']));
    if (!['preview', 'status', 'restore', 'undo', 'redo'].includes(/** @type {string} */ (body.action))) throw new BridgeError('Choose a rewind action.');
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Only this agent’s parent can rewind its conversation.', 409);
      if (thread.status?.type === 'active') throw new BridgeError('Rewind is unavailable while Elpis is working.', 409);
      try {
        if (body.action === 'status') return await clientState.rewindHistory.status(id);
        if (body.action === 'undo' || body.action === 'redo') {
          const result = await clientState.rewindHistory.toggle(id, body.action); await internal_attach.call(this, clientState, result.thread.id);
          return { ...result, thread: internal_decorate.call(this, clientState, result.thread) };
        }
        const turn = text(body.beforeTurnId, 'turn ID', 200);
        if (body.action === 'preview') return await clientState.rewindSnapshots.preview(id, turn, thread.cwd);
        if (!['both', 'conversation', 'code'].includes(/** @type {string} */ (body.mode))) throw new BridgeError('Choose what to restore.');
        /** @param {unknown} [forkId] */
        const files = async forkId => {
          if (body.mode !== 'conversation') await clientState.rewindSnapshots.restore(id, turn, thread.cwd, text(body.version, 'file preview version', 64));
          if (forkId) await clientState.rewindSnapshots.inherit(id, forkId);
        };
        if (body.mode === 'code') { await files(); return { rewound: true, mode: body.mode }; }
        const result = await clientState.rewindHistory.restore(thread, turn, files); clientState.owned.add(result.thread.id);
        return { ...result, thread: internal_decorate.call(this, clientState, result.thread), rewound: true, mode: body.mode };
      } catch (error) { throw error instanceof BridgeError ? error : new BridgeError(/** @type {Error} */ (error).message, 409); }
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {{ id: string, cwd?: string, model?: unknown }} thread @param {Record<string, unknown> & { model?: unknown, additionalContext?: Record<string, unknown> }} params */
export async function internal_startTurn(clientState, thread, params) {
    // Application context reaches already-loaded chats; resume config overrides do not.
    const { config } = await internal_rpc.call(this, clientState, 'config/read', { includeLayers: false });
    const policy = config?.features?.multi_agent === false ? SUBAGENT_POLICY.disabled : SUBAGENT_POLICY.enabled;
    // Refresh even when unchanged: a model/effort change may add a new native mode hint.
    params = { ...params, additionalContext: { ...params.additionalContext, 'elpis.subagents': { kind: 'application', value: `${policy}\nApplies to turn request ${randomUUID()}.` } } };
    // Snapshot before turn/start can execute tools. Non-Git or oversized folders still support conversation rewind.
    const pending = `pending-${randomUUID()}`; let snapshot = false;
    try { await clientState.rewindSnapshots.capture(thread.id, pending, thread.cwd); snapshot = true; } catch { /* Preview reports unavailable. */ }
    const result = await internal_rpc.call(this, clientState, 'turn/start', params);
    const model = typeof params.model === 'string' && params.model.trim() ? params.model : thread.model;
    if (result.turn?.id && typeof model === 'string' && model.trim()) clientState.liveTurnModels.set(`${thread.id}:${result.turn.id}`, model);
    await clientState.rewindHistory.invalidate(thread.id);
    if (snapshot && result.turn?.id) await clientState.rewindSnapshots.alias(thread.id, pending, result.turn.id).catch(() => {});
    return result;
  }

/** Opens a chat live in this app: subscribes it and reports the turn it is running, if any. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} body */
export async function impl_resume(clientState, id, body) {
    object(body, []);
    const metadata = await this.readThreadMetadata(id);
    if (metadata.canAcceptDirectInput === false || (metadata.status?.type !== 'active' && !metadata.desktopAccess.writable)) {
      const joined = await internal_attach.call(this, clientState, id, metadata);
      clientState.opened = /** @type {string} */ (id); void internal_releaseLeft.call(this, clientState, id);
      const turns = await internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary', notLoaded: true }).catch(() => ({ data: [] }));
      return { thread: internal_decorate.call(this, clientState, joined?.thread ?? metadata), activeTurnId: turns.data?.find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress')?.id ?? null,
        ...(clientState.historyOnly.has(id) ? { followingLive: false } : {}) };
    }
    // A chat already followed (the list follows running ones) is read again, so its mode, Plan and effort still show.
    // An archived chat opens read from the engine, without following it: the engine resumes it only once it is back.
    let archived = false;
    const result = await internal_attach.call(this, clientState, id, metadata).catch(/** @param {unknown} error */ error => { if (!archivedSession(error)) throw error; archived = true; return null; })
      ?? (archived ? null : await internal_rpc.call(this, clientState, 'thread/resume', { threadId: id, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } }).catch(() => null));
    clientState.opened = /** @type {string} */ (id); void internal_releaseLeft.call(this, clientState, id);
    if (result) {
      const active = (result.initialTurnsPage?.data ?? result.thread.turns ?? []).find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress');
      return { thread: internal_decorate.call(this, clientState, { ...result.thread, model: result.model ?? result.thread.model, serviceTier: result.serviceTier ?? null, reasoningEffort: result.reasoningEffort ?? result.thread.reasoningEffort }), activeTurnId: active?.id ?? null, permissions: modeOf(result), planMode: result.collaborationMode?.mode === 'plan' };
    }
    const [{ thread }, turns] = await Promise.all([internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false }),
      internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }).catch(() => ({ data: [] }))]);
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    return { thread: internal_decorate.call(this, clientState, thread), activeTurnId: turns.data?.find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress')?.id ?? null };
  }

/** Stops following the idle chats left behind, so Elpis can unload them and end their tool
   * servers; a chat that is working, changing or awaiting an answer stays followed. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} opened */
async function internal_releaseLeft(clientState, opened) {
    for (const id of [...clientState.owned]) {
      if (id === opened || clientState.attaching.has(id) || clientState.mutating.has(id) || [...clientState.approvals.values()].some(approval => approval.ownerThreadId === id || approval.params.threadId === id)) continue;
      const { thread } = await internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false }).catch(() => ({}));
      if (!thread || thread.status?.type === 'active' || !clientState.owned.has(id) || clientState.mutating.has(id)) continue;
      internal_forgetSubscription.call(this, clientState, id);
      await internal_rpc.call(this, clientState, 'thread/unsubscribe', { threadId: id }).catch(() => {});
    }
  }

/** A Workflows node has ended and its ACP agent has left: stop following its chat unless it is open, so Elpis unloads
   * it and ends its MCP servers (28 Oct: nine finished node chats stayed loaded, 2.9 GB of MCP servers). */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id */
export async function internal_releaseNode(clientState, id) {
    clientState.endedNodes.add(id);
    await clientState.attaching.get(id)?.catch(() => {});
    if (id === clientState.opened || !clientState.owned.has(id) || clientState.mutating.has(id)) return;
    internal_forgetSubscription.call(this, clientState, id);
    await internal_rpc.call(this, clientState, 'thread/unsubscribe', { threadId: id }).catch(() => {});
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id */
export async function internal_current(clientState, id) {
    await internal_attach.call(this, clientState, id);
    const { thread } = await internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    return internal_decorate.call(this, clientState, thread);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} _clientState @param {unknown} value */
export function internal_effort(_clientState, value) {
    if (value === undefined) return;
    if (typeof value !== 'string' || !EFFORT.test(value)) throw new BridgeError('Choose a reasoning effort offered by the model');
    return value;
  }
