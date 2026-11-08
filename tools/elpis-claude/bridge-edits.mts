import { createProviderHistory } from "./bridge-history.mts";
import { Acp } from "./bridge-acp.mts";
import type { EngineCall,BridgeError,RequestId,BridgeMessage,StartPick,LiveSession,SavedSession,ProviderAgent,BridgeResponses,ThreadRequest } from "./bridge-types.mts";
import type { BridgeEnvironment } from "./bridge-server.mts";

type Dependencies = Pick<BridgeEnvironment, "agentOf" | "claudeAccounts" | "log" | "storeChain" | "loadStoreSnapshot" | "updateStore" | "startingProviders"> & {
  claudeModel: Map<string, string>;
  threadCwd: Map<string, string>;
  ensureAcp: (agent: ProviderAgent) => Promise<Acp>;
  engine: { stdin: { write: (data: string) => unknown } };
  engineCall: EngineCall;
  claudeTurnsOf: ReturnType<typeof createProviderHistory>["claudeTurnsOf"];
  pendingStart: Map<RequestId, StartPick>;
  connectionId: string;
  sessions: Map<string, LiveSession>;
  toTui: (message: BridgeMessage) => void;
};

/** Keep provider history aligned when a person forks or rewinds a chat. */
export function createProviderEdits({ agentOf, claudeModel, claudeAccounts, ensureAcp, threadCwd, log, storeChain, loadStoreSnapshot, claudeTurnsOf, engineCall, pendingStart, engine, startingProviders, connectionId, toTui, updateStore, sessions }: Dependencies) {
  // Esc-Esc "edit a previous message": revert drops a turn and every later one. Claude's turns
  // live in the bridge's store and Claude's own session, which the engine cannot see, so the
  // bridge drops them, gives Claude a fresh session seeded from the kept history, and has the
  // engine revert its own turns from the same point.
  async function forkClaudeAfter(threadId: string, entry: SavedSession | undefined, messageId: string | null | undefined) {
    const agent = agentOf(claudeModel.get(threadId));
    const saved = entry?.session;
    if (!messageId || !saved || agent?.key !== "claude" || (entry.agent ?? "claude") !== "claude"
      || (entry.claudeAccountId ?? "default") !== claudeAccounts.activeId()) return null;
    const acp = await ensureAcp(agent);
    const fork = { version: 1, messageId };
    const { sessionId } = await acp.call("session/fork", { sessionId: saved, cwd: threadCwd.get(threadId) ?? process.cwd(), mcpServers: [], _meta: { jetbrains: { air: { fork } } } });
    log(`rewind of ${threadId} forked Claude session ${saved} after ${messageId} -> ${sessionId}`);
    return sessionId ?? null;
  }
  // Fork chat from here, Rewind and Edit's kept version on a provider chat. Its turns live in the store, so the
  // engine knows none of their ids: a boundary naming one becomes the engine's own (its first native turn after
  // the cut, or none), and the fork gets its own copy of the kept turns, which a later edit of the source cannot drop.
  async function forkProviderChat(msg: ThreadRequest) {
    const { threadId, beforeTurnId, lastTurnId } = msg.params;
    try {
      await storeChain();
      const parent = claudeTurnsOf(await loadStoreSnapshot(), threadId);
      const mark = beforeTurnId ?? lastTurnId, at = mark ? parent.findIndex((t) => t.id === mark) : -1;
      const params = { ...msg.params };
      if (at >= 0) {
        delete params.beforeTurnId; delete params.lastTurnId;
        const cut = parent[beforeTurnId ? at : at + 1];
        if (cut) {
          const native = (await engineCall("thread/turns/list", { threadId, limit: 200, sortDirection: "asc", itemsView: "notLoaded" }).catch(() => ({ data: [] }))).data ?? [];
          const engineCut = native.find((t) => (t.startedAt ?? 0) >= (cut.startedAt ?? 0));
          if (engineCut?.id) params.beforeTurnId = engineCut.id;
        }
      }
      const pick = pendingStart.get(msg.id);
      if (pick && (!mark || at >= 0)) pick.forkTurns = structuredClone(at >= 0 ? parent.slice(0, beforeTurnId ? at : at + 1) : parent);
      engine.stdin.write(JSON.stringify({ ...msg, params }) + "\n");
    } catch (e) {
      pendingStart.delete(msg.id); startingProviders.get(`${connectionId}:${msg.id}`)?.resolve(); startingProviders.delete(`${connectionId}:${msg.id}`);
      toTui({ id: msg.id, error: { code: -32603, message: `fork failed: ${(e as BridgeError)?.message ?? JSON.stringify(e)}` } });
    }
  }
  async function revertThread(msg: ThreadRequest) {
    const { threadId, beforeTurnId } = msg.params ?? {};
    await storeChain();
    const entry = (await loadStoreSnapshot())[threadId];
    const stored = entry?.turns ?? [];
    if (!stored.length) { engine.stdin.write(JSON.stringify(msg) + "\n"); return; }
    try {
      const engineTurns = (await engineCall("thread/turns/list", { threadId, limit: 200, sortDirection: "asc", itemsView: "notLoaded" }).catch(() => ({ data: [] }))).data ?? [];
      const cutAt = (stored.find((t) => t.id === beforeTurnId) ?? engineTurns.find((t) => t.id === beforeTurnId))?.startedAt;
      if (cutAt == null) { engine.stdin.write(JSON.stringify(msg) + "\n"); return; }
      // A143: as Codex's rollback keeps the native history up to the cut, Claude keeps its own: its
      // session is forked after the last kept reply (fx and CloudRoom fork the same way), so the
      // next request resends the same prefix and the prompt cache still holds. A turn without a
      // recorded reply id (older chats) falls back to a fresh session seeded from the kept turns.
      // Saved turns start on whole seconds, so a stored turn is cut by its place, not its time.
      const at = stored.findIndex((t) => t.id === beforeTurnId);
      const kept = at >= 0 ? stored.slice(0, at) : stored.filter((t) => (t.startedAt ?? 0) < cutAt);
      const keptIds = new Set(kept.map((t) => t.id));
      const forked = await forkClaudeAfter(threadId, entry, kept.at(-1)?.claudeMessageId)
        .catch((e) => { log(`rewind fork failed, fresh session instead: ${e?.message ?? JSON.stringify(e)}`); return null; });
      await updateStore((st) => { const e = st[threadId] ?? {}; e.turns = (e.turns ?? []).filter((t) => keptIds.has(t.id)); delete e.sessions; if (forked) e.session = forked; else delete e.session; st[threadId] = e; });
      sessions.delete(threadId);
      const engineCut = engineTurns.find((t) => (t.startedAt ?? 0) >= cutAt);
      const result = engineCut
        ? await engineCall("thread/revert", { threadId, beforeTurnId: engineCut.id })
        : { thread: (await engineCall("thread/read", { threadId })).thread, turnsBackwardsCursor: null };
      log(`reverted thread ${threadId} before ${beforeTurnId} (${stored.length - kept.length} Claude turns dropped${engineCut ? ", engine reverted too" : ""})`);
      toTui({ id: msg.id, result });
    } catch (e) {
      toTui({ id: msg.id, error: { code: -32603, message: `revert failed: ${(e as BridgeError)?.message ?? JSON.stringify(e)}` } });
    }
  }

  return { forkProviderChat, revertThread };
}
