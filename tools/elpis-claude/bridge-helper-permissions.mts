import type { BridgeClient,BridgeContext,BridgeResponses,Ceiling,HelperScope,NoticeParams,ProviderTurn,RequestId,SavedHelper,Store } from "./bridge-types.mts";

type Mode = "plan" | "bypassPermissions" | "default" | "auto" | "acceptEdits";
type EngineCall = { <K extends keyof BridgeResponses>(method: K, params: object, timeoutMs?: number): Promise<BridgeResponses[K]>; <T = unknown>(method: string, params: object, timeoutMs?: number): Promise<T> };
type Dependencies = {
  threadAccess: Map<string, { profile: string | undefined; reviewer: string | undefined }>;
  threadPolicy: Map<string, string>;
  UNSANDBOXED: string[];
  AUTHORITY: Record<Mode, number>;
  accessModeOf: (threadId: string, agent: string, ask: boolean) => Mode;
  activeTurns: Map<string, ProviderTurn>;
  notify: (method: string, params: NoticeParams) => void;
  engineCall: EngineCall;
  log: (message: string) => void;
  helperScope: Map<string, HelperScope>;
  engineTurns: Map<string, string>;
  helperConns: WeakSet<BridgeClient>;
  ws: BridgeClient;
  context: BridgeContext;
  engine: { kill: () => void };
  threadSandbox: Map<string, Ceiling>;
  claudeModel: Map<string, string>;
  lowest: (...ceilings: [Ceiling, ...Ceiling[]]) => Ceiling;
  isBridged: (model: unknown) => model is string;
  claimEngineHelper: (threadId: string, helper: HelperScope) => void;
  explicitChatChoices: Set<string>;
  updateStore: (update: (store: Store) => void) => Promise<boolean>;
};

/** Enforce each helper's permission ceiling and delay turns until confirmation. */
export function createHelperPermissions({ threadAccess, threadPolicy, UNSANDBOXED, AUTHORITY, accessModeOf, activeTurns, notify, engineCall, log, helperScope, engineTurns, helperConns, ws, context, engine, threadSandbox, claudeModel, lowest, isBridged, claimEngineHelper, explicitChatChoices, updateStore }: Dependencies) {
  // Providers may edit without callbacks in Accept edits, Auto, or Bypass. Stop a running turn
  // whose authority a restriction reduces; its next prompt applies the confirmed restricted mode.
  // Full access keeps the provider's normal mode, so compare the confirmed profile too.
  const authorityOf = (tid: string) => {
    const profile = threadAccess.get(tid)?.profile;
    if (threadPolicy.get(tid) === 'never' && UNSANDBOXED.includes(profile as string)) return profile === ':bypass-permissions' ? 4 : 3;
    return AUTHORITY[accessModeOf(tid, 'claude', threadPolicy.get(tid) !== 'never')];
  };
  const stopIfReduced = (tid: string, previousAuthority: number) => {
    const running = activeTurns.get(tid);
    if (!running || authorityOf(tid) >= previousAuthority) return;
    running.cancelled = true;
    if (running.sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId: running.sessionId } });
    notify("warning", { threadId: tid, message: "Stopped the active turn to apply restricted permissions. Send a message to continue." });
  };
  // Sets a helper's profile on this connection's engine; true once the engine confirms it,
  // false if the engine refuses it or does not confirm it in time.
  const confirmations = new Map<string, Set<(profile: string | undefined) => void>>(); // thread id -> what waits for the profiles its engine confirms
  const HELPER_RESTRICT_MS = 5000;
  const applyProfile = (tid: string, profile: string) => new Promise<boolean>((resolve) => {
    if (threadAccess.get(tid)?.profile === profile && threadPolicy.get(tid) === 'never') { resolve(true); return; }
    const confirm = (confirmed: string | undefined) => { if (confirmed === profile && threadPolicy.get(tid) === 'never') settle(true); };
    const settle = (ok: boolean, why?: string) => { clearTimeout(timer); confirmations.get(tid)?.delete(confirm); if (!ok) log(`helper ${tid} not set to ${profile}: ${why}`); resolve(ok); };
    const timer = setTimeout(() => settle(false, "no confirmation"), HELPER_RESTRICT_MS);
    if (!confirmations.has(tid)) confirmations.set(tid, new Set());
    (confirmations.get(tid) as Set<(profile: string | undefined) => void>).add(confirm);
    engineCall("thread/settings/update", { threadId: tid, approvalPolicy: 'never', approvalsReviewer: 'user', permissions: profile }).catch((e) => settle(false, e?.message ?? JSON.stringify(e)));
  });
  type OwnHelper = { applying: Promise<boolean> | null; waiting: RequestId[]; nativeWaiting: Set<RequestId>; failed: boolean };
  const ownHelpers = new Map<string, OwnHelper>(); // helper thread id open on this connection -> { applying, waiting, failed }
  const releaseHelpers = () => {
    for (const tid of ownHelpers.keys()) {
      const h = helperScope.get(tid);
      h?.owners.delete(restrictHelper);
      if (h?.activeOwner === restrictHelper) h.activeOwner = null;
    }
  };
  // A helper this connection's engine runs, which could not be restricted, stops. A delegate
  // connection serves only its helper: its tool hears that the turn failed, and its engine ends.
  // A TUI's engine also runs the user's other chats: only the helper's turn is interrupted, and
  // the helper runs again only once its restriction applies.
  const failHelper = async (tid: string, reason: string) => {
    log(`helper ${tid} stopped: ${reason}`);
    const error = { code: -32600, message: `The helper was stopped: ${reason}.` };
    for (const id of ownHelpers.get(tid)?.waiting.splice(0) ?? []) ws.send(JSON.stringify({ id, error }));
    const turnId = engineTurns.get(tid);
    if (helperConns.has(ws)) {
      if (turnId) ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: tid, turn: { id: turnId, items: [], status: "failed", error: { message: error.message } } } }));
      context.failed = true;
      ws.close();
      engine.kill();
      return;
    }
    if (turnId) {
      const interrupted = engineCall("turn/interrupt", { threadId: tid, turnId }).catch((e) => log(`helper ${tid} interrupt: ${e?.message ?? JSON.stringify(e)}`));
      await Promise.race([interrupted, new Promise((resolve) => setTimeout(resolve, HELPER_RESTRICT_MS))]);
    }
    notify("warning", { threadId: tid, message: `${error.message} It runs again once they apply.` });
  };
  // Apply a helper's current default scope; its turns wait for engine confirmation.
  const enforceHelper = (tid: string) => {
    const own = ownHelpers.get(tid) as OwnHelper;
    const profile = { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[(helperScope.get(tid) as HelperScope)?.ceiling];
    const applying = own.applying = applyProfile(tid, profile).then(async (ok) => {
      own.failed = !ok;
      if (ok) own.waiting.length = 0;
      else await failHelper(tid, "its chat's restricted permissions could not be applied");
      if (own.applying === applying) own.applying = null;
      return ok;
    });
    return applying;
  };
  // Update each connection holding a helper. Provider tools follow the confirmed
  // bridge policy; native tools follow the engine's confirmed settings.
  const restrictHelper = (tid: string) => {
    const previousAuthority = authorityOf(tid);
    const ceiling = helperScope.get(tid)?.ceiling ?? 'read-only';
    threadSandbox.set(tid, ceiling);
    stopIfReduced(tid, previousAuthority);
    if (claudeModel.has(tid)) return applyProfile(tid, { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[ceiling]);
    return enforceHelper(tid);
  };
  // Opens a helper on this connection, under the lower of its known ceiling and `ceiling`.
  const openHelper = (tid: string, d: SavedHelper, ceiling: Ceiling) => {
    let h = helperScope.get(tid);
    if (!h) helperScope.set(tid, h = { parentThreadId: d.parentThreadId, requested: d.requested, ceiling, owners: new Set() });
    h.ceiling = lowest(h.ceiling, ceiling);
    h.model = d.model ?? h.model;
    h.owners.add(restrictHelper);
    ownHelpers.set(tid, { applying: null, waiting: [], nativeWaiting: new Set(), failed: false });
    threadSandbox.set(tid, h.ceiling);
    if (helperConns.has(ws) && !isBridged(h.model)) claimEngineHelper(tid, h);
    return h;
  };
  // A request for a helper's thread asks for no more than its ceiling: a read-only helper is
  // asked to be read-only, and only a Full Access one is given Full Access, never Bypass. `field` is the request's sandbox field.
  const boundAccess = (p: { permissions?: string; sandbox?: string; sandboxPolicy?: string | { type?: string } }, ceiling: Ceiling, field: "sandbox" | "sandboxPolicy") => {
    if (ceiling === "danger-full-access") { if (p.permissions === ":bypass-permissions") p.permissions = ":danger-full-access"; return; }
    const wide = UNSANDBOXED.includes(p.permissions as string) || p[field] === "danger-full-access" || ["dangerFullAccess", "externalSandbox"].includes((p[field] as { type?: string } | undefined)?.type as string);
    if (ceiling === "workspace-write" && !wide) return;
    delete p.permissions; delete p[field];
    if (field === "sandbox") p.sandbox = ceiling;
    else p.permissions = ceiling === "read-only" ? ":read-only" : ":workspace";
  };
  // A reopened helper (resumeThread bounded its request): its ceiling, saved if it fell, and its
  // engine checked to be within it. False if the engine could not be brought within it.
  async function adoptHelper(tid: string, r: SavedHelper & { stored: Ceiling }, bridged: boolean) {
    const h = openHelper(tid, r, r.ceiling);
    if (explicitChatChoices.has(tid)) return true;
    if (h.ceiling !== r.stored) updateStore((st) => { if (st._delegations?.[tid]) st._delegations[tid].ceiling = h.ceiling; });
    const profile = threadAccess.get(tid)?.profile;
    const want = h.ceiling === "read-only" ? ":read-only" : h.ceiling === "workspace-write" ? (UNSANDBOXED.includes(profile as string) ? ":workspace" : null)
      : profile === ":bypass-permissions" ? ":danger-full-access" : null;
    if (!want || profile === want) return true;
    if (bridged) { applyProfile(tid, want); return true; }
    const ok = await applyProfile(tid, want);
    (ownHelpers.get(tid) as OwnHelper).failed = !ok;
    return ok;
  }
  return { authorityOf, stopIfReduced, confirmations, ownHelpers, releaseHelpers, failHelper, enforceHelper, restrictHelper, openHelper, boundAccess, adoptHelper };
}
