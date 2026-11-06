import { AGENT_RUN_NOTICE } from '../lib/agent-runs.mts';
import { BridgeError, object, text, threadId } from './validate.mts';
import { attachmentInput } from './attachments.mts';
import { fastServiceTier } from '../lib/service-tier.mts';
import fs from 'node:fs';
import { grantedPermissions } from './client-approvals.mjs';
import path from 'node:path';
import { ragMessage } from './rag-command.mts';
import { randomUUID } from 'node:crypto';
import { archivedSession } from './client-protocol.mts';
import { collaborationMode, modeOf, permissionMode, permissionSetting, reviewTarget } from './client-permissions.mjs';
import { internal_attach, internal_decorate } from './client-thread-list.mjs';
import { internal_browserOptions, internal_rpc } from './client-connection.mjs';
import { internal_chatModel } from './client-context.mjs';
import { internal_current, internal_effort, internal_startTurn } from './client-rewind.mjs';
import { internal_mutate } from './client-mutation.mjs';

/** Writing in an archived chat brings it back first (with the agents archived with it), as a reply brings an archived mail thread back to the inbox. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} body */
export async function impl_send(clientState, id, body) {
    try { return await internal_send.call(this, clientState, id, body); }
    catch (error) {
      if (!archivedSession(error)) throw error;
      await this.unarchiveThread(id, {});
      return internal_send.call(this, clientState, id, body);
    }
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
async function internal_send(clientState, id, raw) {
    const body = /** @type {Record<string, unknown>} */ (object(raw, ['text', 'model', 'effort', 'continueAs', 'attachments', 'mentions', 'permissions', 'mode', 'automatic']));
    if (body.automatic !== undefined && typeof body.automatic !== 'boolean') throw new BridgeError('automatic must be true or false');
    const input = attachmentInput(typeof body.text === 'string' && body.text.trim() ? ragMessage(text(body.text, 'message')) : body.text, /** @type {Parameters<typeof attachmentInput>[1]} */ (body.attachments), body.mentions);
    const effort = internal_effort.call(this, clientState, body.effort), permissions = permissionMode(body.permissions);
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (!thread.desktopAccess.writable && !body.continueAs) throw new BridgeError(`${AGENT_RUN_NOTICE}. Choose Continue here after it finishes (continued conversation name required).`, 409);
      if (!thread.desktopAccess.writable && !thread.desktopAccess.canContinue) throw new BridgeError('Wait for this background run to finish before continuing here.', 409);
      const model = await internal_chatModel.call(this, clientState, body.model, thread.modelProvider);
      const overrides = { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...permissionSetting(permissions), ...(permissions ? { elpisPermissionSource: 'chat' } : body.automatic ? { elpisPermissionSource: 'automatic' } : {}), ...collaborationMode(body.mode, model ?? thread.model, effort ?? thread.reasoningEffort) };
      if (thread.desktopAccess.mode === 'continue') {
        // The agent's own thread refuses direct turns; a fork carries its whole history and recorded model.
        const name = text(body.continueAs, 'continued conversation name', 200).trim();
        const browserSession = `pending-${randomUUID()}`;
        const fork = await internal_rpc.call(this, clientState, 'thread/fork', { threadId: id, model: model ?? thread.model ?? undefined, modelProvider: thread.modelProvider, ...internal_browserOptions.call(this, clientState, browserSession) }).catch(error => { clientState.browserConfig?.close?.(browserSession); throw error; });
        threadId(fork.thread?.id); clientState.browserConfig?.bind?.(browserSession, fork.thread.id); clientState.owned.add(fork.thread.id);
        const continued = { thread: internal_decorate.call(this, clientState, fork.thread), continuedFrom: id };
        try { await internal_rpc.call(this, clientState, 'thread/name/set', { threadId: fork.thread.id, name }); }
        catch (error) {
          return { ...continued, sendError: `Conversation created, but its name could not be confirmed: ${error instanceof Error ? error.message : String(error)} Your message was not sent.` };
        }
        continued.thread.name = name;
        try {
          const started = await internal_startTurn.call(this, clientState, fork.thread, { threadId: fork.thread.id, input, ...overrides });
          return { ...started, ...continued };
        } catch (error) {
          // The fork is acknowledged even when the first send fails or its outcome is unknown.
          // Return it so the app can inspect that conversation instead of creating another fork.
          return { ...continued, sendError: `Conversation created, but its first message was not confirmed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (thread.status?.type === 'active') throw new BridgeError('This conversation is running. Use Steer with its active turn ID.', 409);
      return internal_startTurn.call(this, clientState, thread, { threadId: id, input, ...overrides });
    }, true);
  }

/** Changes a chat's permission mode now, as the terminal's /permissions does: the engine applies it to
   * the running turn and later ones, and a bridged (Claude, Antigravity) chat follows the engine's
   * thread/settings/updated. Returns the mode the engine reports, never the one asked for. */
  /** Change the current chat's speed through the engine; this never starts a model turn. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_setServiceTier(clientState, id, raw) {
    const body = /** @type {{ enabled?: unknown }} */ (object(raw, ['enabled']));
    if ('enabled' in body && typeof body.enabled !== 'boolean') throw new BridgeError('Choose Fast on or off');
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (!thread.desktopAccess.writable) throw new BridgeError("Only this agent's parent can change its speed.", 409);
      const current = await internal_rpc.call(this, clientState, 'thread/resume', { threadId: id, excludeTurns: true });
      if (current.modelProvider !== 'openai') throw new BridgeError('/fast is available for OpenAI models.', 409);
      const enabled = body.enabled ?? !['fast', 'priority'].includes(current.serviceTier);
      let fastTier;
      if (enabled) {
        const models = await this.models();
        const model = models.data?.find(/** @param {{ model?: unknown }} model */ model => model.model === current.model);
        fastTier = fastServiceTier(model);
        if (!fastTier) throw new BridgeError(`${current.model} does not offer Fast on this account.`, 409);
      }
      const serviceTier = enabled ? fastTier : 'default';
      // Capture the running turn before saving: a turn that ends during this change is never retargeted.
      const turnId = thread.status?.type === 'active'
        ? (await internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress')?.id
        : null;
      await internal_rpc.call(this, clientState, 'thread/settings/update', { threadId: id, serviceTier });
      const applied = await internal_rpc.call(this, clientState, 'thread/resume', { threadId: id, excludeTurns: true });
      if (applied.serviceTier !== serviceTier) throw new BridgeError('Elpis did not apply the requested speed. Try again.', 409);
      if (turnId) {
        try {
          const live = await internal_rpc.call(this, clientState, 'turn/settings/update', { threadId: id, turnId, serviceTier });
          if (live?.status === 'applied') return { serviceTier, activeTurnApplied: true };
          if (live?.status !== 'targetUnavailable') throw new Error('Elpis did not confirm the running turn’s speed.');
        } catch (error) {
          const reason = error instanceof Error ? /** @type {Error & { engineMessage?: string }} */ (error).engineMessage || error.message : String(error);
          return { serviceTier, activeTurnApplied: false, warning: `${enabled ? 'Fast' : 'Standard speed'} is saved for later turns, but the running turn could not change speed. ${reason.slice(0, 1000)}` };
        }
      }
      return { serviceTier, activeTurnApplied: false };
    });
  }

/** Saves a chat's reasoning effort the moment it is picked, so later turns and a restart keep it (the engine records
   * it; the Claude bridge stores it). A running native turn takes it now; a Claude turn from its next request. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_setEffort(clientState, id, raw) {
    const body = /** @type {{ effort?: unknown }} */ (object(raw, ['effort']));
    const effort = internal_effort.call(this, clientState, body.effort);
    if (!effort) throw new BridgeError('Choose a reasoning effort offered by the model');
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (!thread.desktopAccess.writable) throw new BridgeError("Only this agent's parent can change its effort.", 409);
      await internal_rpc.call(this, clientState, 'thread/settings/update', { threadId: id, effort });
      if (thread.status?.type === 'active' && !/^(?:claude|agy)\//.test(thread.model ?? '')) {
        const turnId = (await internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress')?.id;
        // A turn that ended meanwhile needs nothing: the next one starts with the saved effort.
        if (turnId) await internal_rpc.call(this, clientState, 'turn/settings/update', { threadId: id, turnId, effort }).catch(() => {});
      }
      return { reasoningEffort: effort };
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_setPermissions(clientState, id, raw) {
    const body = /** @type {{ permissions?: unknown }} */ (object(raw, ['permissions']));
    const mode = permissionMode(body.permissions);
    if (!mode) throw new BridgeError('Choose a permission mode: ask, auto, full or bypass');
    return internal_mutate(clientState, id, async () => {
      await internal_current.call(this, clientState, id);
      let resolveApplied;
      const applied = new Promise(resolve => { resolveApplied = resolve; });
      const waiters = clientState.settingsWaiters.get(id) ?? new Set();
      waiters.add(resolveApplied); clientState.settingsWaiters.set(id, waiters);
      let timer;
      try {
        await internal_rpc.call(this, clientState, 'thread/settings/update', { threadId: id, ...permissionSetting(mode), elpisPermissionSource: 'chat' });
        // The engine publishes settings only when they change; an unchanged mode is read back instead.
        const settings = await Promise.race([applied, new Promise(resolve => { timer = setTimeout(resolve, clientState.settingsConfirmMs, null); })])
          ?? await internal_rpc.call(this, clientState, 'thread/resume', { threadId: id, excludeTurns: true });
        const now = modeOf(settings);
        if (now !== mode) throw new BridgeError(`Elpis did not apply ${mode} permissions to this chat; it is in ${now ?? 'an unknown'} mode.`, 409);
        if (now === 'full' || now === 'bypass') internal_allowWaiting.call(this, clientState, id);
        return { permissions: now };
      } finally {
        clearTimeout(timer); waiters.delete(resolveApplied);
        if (!waiters.size) clientState.settingsWaiters.delete(id);
      }
    });
  }

/** Moves a chat to another folder for later turns through the engine's thread/settings/update `cwd`. The running turn
   * keeps its captured environment. Only an existing folder is accepted. Returns the folder the engine reports. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_setFolder(clientState, id, raw) {
    const body = /** @type {{ cwd?: unknown }} */ (object(raw, ['cwd']));
    if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd)) throw new BridgeError('Choose a folder by its full path');
    let cwd;
    try { cwd = await fs.promises.realpath(body.cwd); if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error('not a folder'); }
    catch { throw new BridgeError('That folder does not exist'); }
    return internal_mutate(clientState, id, async () => {
      await internal_current.call(this, clientState, id);
      await internal_rpc.call(this, clientState, 'thread/settings/update', { threadId: id, cwd });
      const { thread: now } = await internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false });
      if (now?.cwd !== cwd) throw new BridgeError(`Elpis did not move this chat to ${cwd}.`, 409);
      return { cwd };
    });
  }

/** Full access and Bypass permissions never ask, so what this chat was already asking when the person chose one
   * is answered as the new mode would have: allowed, once. Questions (forms, request_user_input) still wait for
   * the person, as do other chats' requests; "Approve for me" leaves requests already put to the person to them. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id */
function internal_allowWaiting(clientState, id) {
    for (const [key, pending] of [...clientState.approvals]) {
      if (pending.params?.threadId !== id) continue;
      let body;
      if (pending.method === 'item/commandExecution/requestApproval' || pending.method === 'item/fileChange/requestApproval') body = { decision: 'accept' };
      else if (pending.method === 'mcpServer/elicitation/request' && pending.params._meta?.codex_approval_kind === 'mcp_tool_call') body = { action: 'accept', content: null, _meta: null };
      else if (pending.method === 'item/permissions/requestApproval') body = { permissions: grantedPermissions(pending.params.permissions ?? {}), scope: 'turn' };
      else continue;
      // Only a decision the request offers is sent (answerApproval checks); anything else stays on its card.
      try { this.answerApproval(key, body); } catch {}
    }
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw @param {{ fallback?: unknown }} [options] */
export async function impl_steer(clientState, id, raw, { fallback = true } = {}) {
    const body = /** @type {Record<string, unknown>} */ (object(raw, ['text', 'expectedTurnId', 'attachments', 'mentions']));
    const input = attachmentInput(typeof body.text === 'string' && body.text.trim() ? ragMessage(text(body.text, 'message')) : body.text, /** @type {Parameters<typeof attachmentInput>[1]} */ (body.attachments), body.mentions);
    const params = { threadId: id, expectedTurnId: text(body.expectedTurnId, 'turn ID', 200), input };
    return internal_mutate(clientState, id, async () => {
      const thread = await internal_current.call(this, clientState, id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Wait for this agent to finish; a message then continues it in a new conversation.', 409);
      await clientState.workflowRuns.noteManualSteer(id);
      try { return await internal_rpc.call(this, clientState, 'turn/steer', params); }
      catch (error) {
        const failure = /** @type {{ code?: unknown, engineMessage: string }} */ (error);
        // A compaction cannot take a message (codex-rs turn_processor.rs): the app queues it for the compaction's end.
        if (fallback && failure.code === -32600 && /^cannot steer a compact turn/.test(failure.engineMessage ?? '')) return { compacting: true };
        // The turn the app saw has ended or another replaced it: the message joins the running
        // turn, or starts a new one, as in the terminal, instead of failing.
        if (!fallback || failure.code !== -32600 || !/^(no active turn to steer|expected active turn id)/.test(failure.engineMessage)) throw error;
        const running = (await internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress')?.id;
        if (running && running !== params.expectedTurnId) return internal_rpc.call(this, clientState, 'turn/steer', { ...params, expectedTurnId: running });
        if (running) throw error;
        return internal_startTurn.call(this, clientState, thread, { threadId: id, input });
      }
    });
  }

/** Stops the given turn, or the agent's running turn when the caller has not seen its start. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_interrupt(clientState, id, raw) {
    const body = /** @type {{ turnId?: unknown }} */ (object(raw, ['turnId']));
    threadId(id);
    if(clientState.workflowRuns.cancel(id))return { interrupted: true };
    return internal_mutate(clientState, id, async () => {
      // A Claude subagent's thread is read-only (the bridge refuses to resume it), yet Stop reaches it.
      await internal_attach.call(this, clientState, id).catch(/** @param {unknown} error */ error => { if (!/read-only/.test(/** @type {Error} */ (error).message)) throw error; });
      let turnId = body.turnId === undefined ? null : text(body.turnId, 'turn ID', 200);
      turnId ??= (await internal_rpc.call(this, clientState, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(/** @param {{ status?: string }} turn */ turn => turn.status === 'inProgress')?.id;
      if (!turnId) throw new BridgeError('This agent is not running', 409);
      return internal_rpc.call(this, clientState, 'turn/interrupt', { threadId: id, turnId });
    });
  }

/** The chat, once it may take a command that runs its model: idle, and writable here (agents answer only to their parent). */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {string} action @param {string} gerund */
async function internal_idleChat(clientState, id, action, gerund) {
    const thread = await internal_current.call(this, clientState, id);
    if (thread.desktopAccess.mode === 'continue') throw new BridgeError(`Only this agent's parent can ${action} it.`, 409);
    if (thread.status?.type === 'active') throw new BridgeError(`Wait for the current turn to finish before ${gerund}.`, 409);
    return thread;
  }

/** The terminal's /compact: the engine summarizes the chat's history now; `instructions` guides the summary. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_compact(clientState, id, raw) {
    const body = /** @type {{ instructions?: unknown }} */ (object(raw, ['instructions']));
    const instructions = body.instructions === undefined ? undefined : text(body.instructions, 'compaction instructions', 32000).trim();
    return internal_mutate(clientState, id, async () => {
      await internal_idleChat.call(this, clientState, id, 'compact', 'compacting');
      return internal_rpc.call(this, clientState, 'thread/compact/start', { threadId: id, ...(instructions ? { instructions } : {}) });
    });
  }

/** The terminal's /review: an inline review turn of one of its four targets. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} raw */
export async function impl_review(clientState, id, raw) {
    const body = /** @type {{ target?: unknown }} */ (object(raw, ['target']));
    const target = reviewTarget(body.target);
    return internal_mutate(clientState, id, async () => {
      await internal_idleChat.call(this, clientState, id, 'review', 'starting a review');
      return internal_rpc.call(this, clientState, 'review/start', { threadId: id, target, delivery: 'inline' });
    });
  }
