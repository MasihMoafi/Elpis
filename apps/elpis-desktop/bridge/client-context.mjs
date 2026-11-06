import { BridgeError, object, text, threadId } from './validate.mjs';
import { CONTEXT_SWITCH_KEYS, cacheUse, contextLedger, contextSwitchesSnapshot, restoredTokenUsage, rolloutShares, rolloutTurnModels } from './elpis-features.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { sessionContextFiles } from './session-context.mjs';
import { internal_decorate } from './client-thread-list.mjs';
import { internal_mutate } from './client-mutation.mjs';
import { internal_rpc } from './client-connection.mjs';

/** Context sources and admission use the same engine functions as the TUI Ledger. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_contextFiles(clientState, id) {
    threadId(id);
    return internal_rpc.call(this, clientState, 'thread/contextFiles/list', { threadId: id });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_goal(clientState, id) {
    threadId(id);
    return internal_rpc.call(this, clientState, 'thread/goal/get', { threadId: id });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_setGoal(clientState, id, input) {
    threadId(id); object(input, ['objective', 'clear']);
    if (input.clear !== undefined && (input.clear !== true || input.objective !== undefined)) throw new BridgeError('Choose a goal or clear it');
    if (input.clear !== true) text(input.objective, 'goal', 32000);
    return internal_mutate.call(this, clientState, id, async () => {
      const { thread } = await internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false });
      if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
      if (!internal_decorate.call(this, clientState, thread).desktopAccess.writable) throw new BridgeError('Only this agent’s parent can change its goal.', 409);
      return input.clear ? internal_rpc.call(this, clientState, 'thread/goal/clear', { threadId: id }) : internal_rpc.call(this, clientState, 'thread/goal/set', { threadId: id, objective: input.objective.trim(), status: 'active' });
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_sessionContext(clientState, id) {
    threadId(id);
    const [{ thread }, sources, { goal }] = await Promise.all([
      internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false }), this.contextFiles(id), this.goal(id),
    ]);
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    return { ...await sessionContextFiles(thread, sources.files), ...(sources.note ? { note: sources.note } : {}), goal, writable: internal_decorate.call(this, clientState, thread).desktopAccess.writable };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_createSessionIntent(clientState, id, input) {
    threadId(id); object(input, []);
    return internal_mutate.call(this, clientState, id, async () => {
      const { thread } = await internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false });
      if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
      if (!internal_decorate.call(this, clientState, thread).desktopAccess.writable) throw new BridgeError('Only this agent’s parent can create its session intent.', 409);
      if (typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) throw new BridgeError('Open a project folder first.');
      const file = path.join(await fs.promises.realpath(thread.cwd), 'ES.md');
      let handle;
      try {
        handle = await fs.promises.open(file, 'wx', 0o600);
        await handle.writeFile('# Session intent\n\n');
      } catch (error) {
        if (error.code === 'EEXIST') throw new BridgeError('ES.md already exists. Open it to edit the current intent.', 409);
        throw error;
      } finally { await handle?.close(); }
      return { path: file };
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_setContextFile(clientState, id, input) {
    threadId(id); object(input, ['path', 'included']);
    text(input.path, 'context file path');
    if (typeof input.included !== 'boolean') throw new BridgeError('Choose included or excluded');
    return internal_rpc.call(this, clientState, 'thread/contextFiles/set', { threadId: id, path: input.path, included: input.included });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_context(clientState, id) {
    threadId(id);
    const { thread } = await internal_rpc.call(this, clientState, 'thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    const { desktopAccess } = internal_decorate.call(this, clientState, thread);
    const snapshot = clientState.context.get(id) ?? {};
    // Before this connection has live usage, the last usage the chat's rollout recorded (what a cold resume restores).
    const restored = snapshot.tokenUsage ? null : await internal_restoredUsage.call(this, clientState, thread.path);
    const tokenUsage = snapshot.tokenUsage ?? restored;
    // The TUI has the shares only once its own process has seen a request; for a chat this app has not seen run, the saved transcript stands in.
    const saved = tokenUsage && !tokenUsage.contextAttribution ? await internal_savedShares.call(this, clientState, thread.path) : null;
    return {
      threadId: id, tokenUsage, smartPrune: snapshot.smartPrune ?? null, ledger: contextLedger(tokenUsage, saved), cache: cacheUse(tokenUsage),
      // The ledger's Compact session, as the terminal's /compact: only a chat that is idle and takes turns here.
      compact: thread.status?.type === 'active' ? { available: false, reason: 'Available when Elpis finishes this turn' }
        : desktopAccess.mode === 'continue' ? { available: false, reason: 'Only this agent\'s parent can compact it' } : { available: true },
      availability: { tokenUsage: snapshot.tokenUsage ? 'live' : restored ? 'restored' : 'unavailable', smartPrune: snapshot.smartPrune ? 'live' : 'unavailable' },
      reason: 'Live usage comes from events this app connection receives; before them, the last usage the chat\'s rollout recorded. Until the engine reports its category shares for a request, they are estimated from the chat\'s saved transcript.',
    };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
async function internal_savedShares(clientState, file) {
    const stat = typeof file === 'string' ? await fs.promises.stat(file).catch(() => null) : null;
    if (!stat?.isFile()) return null;
    const key = `${stat.size}:${stat.mtimeMs}`, cached = clientState.shares.get(file);
    if (cached?.key === key) return cached.value;
    const value = await rolloutShares(file);
    clientState.shares.set(file, { key, value });
    return value;
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function internal_withTurnModels(clientState, file, entries) {
    if (!Array.isArray(entries) || !entries.length) return entries;
    const stat = typeof file === 'string' ? await fs.promises.stat(file).catch(() => null) : null;
    if (!stat?.isFile()) return entries;
    const key = `${stat.size}:${stat.mtimeMs}`, cached = clientState.turnModels.get(file);
    const models = cached?.key === key ? cached.value : await rolloutTurnModels(file);
    if (cached?.key !== key) clientState.turnModels.set(file, { key, value: models });
    return entries.map(entry => {
      const model = models.get(entry.turnId);
      return model ? { ...entry, model } : entry;
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
async function internal_restoredUsage(clientState, file) {
    const stat = typeof file === 'string' ? await fs.promises.stat(file).catch(() => null) : null;
    if (!stat?.isFile()) return null;
    const key = `${stat.size}:${stat.mtimeMs}`, cached = clientState.restored.get(file);
    if (cached?.key === key) return cached.value;
    const value = await restoredTokenUsage(file);
    clientState.restored.set(file, { key, value });
    return value;
  }

/** The Context Ledger's Smart Prune, Subagents and RAG switches (elpis-features.mjs `contextSwitchesSnapshot`). */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_contextSwitches(clientState) { return contextSwitchesSnapshot(await internal_rpc.call(this, clientState, 'config/read', { includeLayers: true })); }

/** Writes the switches as the TUI ledger does: one config key each, reloaded so open chats use it from their next turn. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_saveContextSwitches(clientState, input) {
    object(input, ['version', ...Object.keys(CONTEXT_SWITCH_KEYS)]);
    text(input.version, 'settings version', 200);
    const current = await this.contextSwitches();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const edits = [];
    for (const [field, keyPath] of Object.entries(CONTEXT_SWITCH_KEYS)) {
      if (!(field in input)) continue;
      if (typeof input[field] !== 'boolean') throw new BridgeError('Turn each switch on or off');
      if (field === 'rag' && current.rag === null) throw new BridgeError('No rag MCP server is configured. Add one in Settings → MCP servers.', 409);
      edits.push({ keyPath, value: input[field], mergeStrategy: 'replace' });
    }
    if (!edits.length) throw new BridgeError('No switch was changed');
    try { await internal_rpc.call(this, clientState, 'config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: true }); }
    catch (error) {
      if (error.status === 409) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
      throw new BridgeError('The switch could not be saved. Refresh and try again.', error.status ?? 502);
    }
    if ('rag' in input) await internal_rpc.call(this, clientState, 'config/mcpServer/reload', undefined).catch(() => {});
    return this.contextSwitches();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function internal_model(clientState, model) {
    if (model === undefined) return;
    if (!clientState.models.has(model)) throw new BridgeError('Select a model returned by the current Elpis model list');
    return model;
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function internal_providerModel(clientState, model, provider) {
    if (model !== undefined && provider) {
      const current = await this.providerSettings();
      // A custom connection, or the engine's gateway route (e.g. the Anthropic credits), whose models it lists itself.
      if (current.providers.some(entry => entry.id === provider && (entry.editable || entry.gateway))) {
        if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)) throw new BridgeError('Give a model ID supported by this API provider');
        if (/^(claude|agy|antigravity)\//i.test(model)) throw new BridgeError('Subscription model routes cannot be used with an API provider');
        return model;
      }
    }
    return internal_model.call(this, clientState, model);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function internal_chatModel(clientState, model, provider) {
    // An existing chat can switch to a subscription even if its carrier uses an API provider.
    if (typeof model === 'string' && /^(?:claude|agy)\//.test(model)) return internal_model.call(this, clientState, model);
    return internal_providerModel.call(this, clientState, model, provider);
  }
