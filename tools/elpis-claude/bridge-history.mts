import { plainCommand } from "./bridge-transcript.mts";
import { wireObject } from "./bridge-wire.mts";
import type { BridgeResponses,RequestId,BridgeClient,BridgeError,BridgeMessage,EngineThread,ForkLink,HistoryOptions,HistoryRequest,ProviderOwner,ProviderTurn,ResumeResult,Store,ThreadRequest,TranscriptItem,TranscriptTurn,TurnPage } from "./bridge-types.mts";

type EngineCall = {
  <K extends keyof BridgeResponses>(method: K, params: object, timeoutMs?: number): Promise<BridgeResponses[K]>;
  <T = unknown>(method: string, params: object, timeoutMs?: number): Promise<T>;
};
type Dependencies = {
  forkParent: Map<string, ForkLink>;
  engineCall: EngineCall;
  resumeResults: Map<string, ResumeResult>;
  activeTurns: Map<string, ProviderTurn>;
  childIds: Set<string>;
  storedChildren: (ids: Set<string> | null) => Promise<Map<string, { turns: TranscriptTurn[] }>>;
  threadSeen: Map<string, EngineThread>;
  providerOwners: Map<string, ProviderOwner>;
  forwarded: Map<RequestId, { client: BridgeClient }>;
  ws: BridgeClient;
  toTui: (message: BridgeMessage) => void;
  storeChain: () => Promise<void>;
  loadStore: () => Promise<Store>;
  textOf: (input: import("./bridge-types.mts").PromptInput[] | undefined) => string;
  log: (message: string) => void;
};

/** Merge native and provider history without losing pagination or fork ancestry. */
export function createProviderHistory({ forkParent, engineCall, resumeResults, activeTurns, childIds, storedChildren, threadSeen, providerOwners, forwarded, ws, toTui, storeChain, loadStore, textOf, log }: Dependencies) {
  function claudeTurnsOf(store: Store, threadId: string, depth = 0): TranscriptTurn[] {
    const own = store[threadId]?.turns ?? [];
    const link = forkParent.get(threadId) ?? store[threadId]?.forkOf;
    if (!link || link.copied || depth > 8) return own;
    const parent = claudeTurnsOf(store, link.threadId, depth + 1);
    const at = (id: string | null | undefined) => (id ? parent.find((t) => t.id === id)?.startedAt : undefined);
    const before = at(link.beforeTurnId), last = at(link.lastTurnId);
    const kept = parent.filter((t) => (t.startedAt ?? 0) <= (link.at as number) && (before == null || (t.startedAt ?? 0) < before) && (last == null || (t.startedAt ?? 0) <= last));
    const have = new Set(own.map((t) => t.id));
    return [...kept.filter((t) => !have.has(t.id)), ...own];
  }
  const unrecorded = (error: unknown, method: string) => typeof (error as BridgeError | null | undefined)?.message === "string" && (error as BridgeError & { message: string }).message.includes("is not materialized yet;") && (error as BridgeError & { message: string }).message.includes(`${method} is unavailable before first user message`);
  type ItemRow = { turnId: string; item: TranscriptItem; startedAtMs: number; completedAtMs: number | null };
  type ItemPage = { data?: ItemRow[]; nextCursor?: string | null; backwardsCursor?: string | null };
  function nativeProviderHistory(method: "thread/turns/list", params: HistoryRequest): Promise<TurnPage>;
  function nativeProviderHistory(method: "thread/items/list", params: HistoryRequest): Promise<ItemPage>;
  function nativeProviderHistory(method: string, params: HistoryRequest): Promise<TurnPage | ItemPage>;
  async function nativeProviderHistory(method: string, params: HistoryRequest): Promise<TurnPage | ItemPage> {
    try { return await engineCall<TurnPage | ItemPage>(method, params); }
    catch (error) {
      // A subscription turn can be active before its native carrier has any turns.
      // This known empty-carrier state is distinct from load/permission failures.
      if (unrecorded(error, method)) return { data: [], nextCursor: null, backwardsCursor: null };
      // Until a chat's first turn is recorded the engine has no state row for it and refuses item
      // pages as unsupported (-32601); its turn list names that state, so ask it before reading empty.
      if (method === "thread/items/list" && (error as BridgeError | null | undefined)?.code === -32601) {
        const probe = await engineCall("thread/turns/list", { threadId: params.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }).then(() => null, (e) => e);
        if (unrecorded(probe, "thread/turns/list")) return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw error;
    }
  }
  async function providerHistory(threadId: string, store: Store) {
    const page = await nativeProviderHistory("thread/turns/list", { threadId, limit: 100, sortDirection: "desc", itemsView: "full" });
    const native = page?.data ?? resumeResults.get(threadId)?.thread?.turns ?? [];
    const running = activeTurns.get(threadId);
    const merged = new Map(native.map((t) => [t.id, t]));
    for (const t of [...claudeTurnsOf(store, threadId), ...(running ? [running.snapshot()] : [])]) merged.set(t.id, t);
    return { turns: [...merged.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)), cursor: page?.nextCursor ?? null };
  }
  function turnProjection(turn: TranscriptTurn, view: string) {
    if (view === "full") return turn;
    const items = turn.items ?? [];
    const first = items.find(item => item.type === "userMessage");
    const last = items.findLast(item => item.type === "agentMessage");
    return { ...turn, itemsView: view, items: view === "notLoaded" ? [] : [first, last].filter((item): item is TranscriptItem => Boolean(item)) };
  }
  // Provider records and native records have independent continuations. Never forward
  // these cursors to the engine, or truncate a merged page behind its native cursor.
  type CursorState = { nativeCursor: string | null; nativeSeen: string[]; nativeLimit: number; storedAfter: [number, string] | null; boundary: string | null };
  type HistoryRow = TranscriptTurn | ItemRow;
  async function providerPage(threadId: string, store: Store, kind: "turns" | "items", params: HistoryOptions = {}) {
    const direction = params.sortDirection ?? "desc";
    const view = params.itemsView ?? "summary";
    const max = kind === "turns" ? 100 : 1000;
    const limit = params.limit ?? (kind === "turns" ? 25 : 50);
    if (!["asc", "desc"].includes(direction) || !["summary", "full", "notLoaded"].includes(view) || !Number.isInteger(limit) || limit < 1 || limit > max) throw new Error("Invalid provider history page options");
    const binding = { threadId, kind, direction, view, turnId: params.turnId ?? null };
    const encode = (state: CursorState) => "acp-page:" + Buffer.from(JSON.stringify({ ...binding, ...state })).toString("base64url");
    let state: CursorState = { nativeCursor: null, nativeSeen: [], nativeLimit: limit, storedAfter: null, boundary: null };
    let legacy = false;
    if (params.cursor) {
      if (typeof params.cursor !== "string" || params.cursor.length > 100000) throw new Error("Invalid provider history cursor");
      if (params.cursor.startsWith("acp-page:")) {
        try {
          const decoded: unknown = JSON.parse(Buffer.from(params.cursor.slice(9), "base64url").toString());
          if (!wireObject(decoded)) throw new Error();
          for (const [key, value] of Object.entries(binding) as [keyof typeof binding, string | null][]) if (decoded[key] !== value) throw new Error();
          const { nativeSeen, nativeCursor, nativeLimit, boundary, storedAfter } = decoded;
          if (!Array.isArray(nativeSeen) || nativeSeen.length > max || !nativeSeen.every((id: unknown) => typeof id === "string") || !(nativeCursor === null || typeof nativeCursor === "string")) throw new Error();
          if (typeof nativeLimit !== "number" || !Number.isInteger(nativeLimit) || nativeLimit < 1 || nativeLimit > max || !(boundary === null || typeof boundary === "string")) throw new Error();
          if (!(storedAfter === null || (Array.isArray(storedAfter) && storedAfter.length === 2 && typeof storedAfter[0] === "number" && Number.isFinite(storedAfter[0]) && typeof storedAfter[1] === "string"))) throw new Error();
          state = { nativeSeen, nativeCursor, nativeLimit, boundary, storedAfter: storedAfter === null ? null : [storedAfter[0], storedAfter[1]] };
        } catch { throw new Error("Invalid or mismatched provider history cursor"); }
      } else { state.nativeCursor = params.cursor; legacy = true; }
    }
    const running = activeTurns.get(threadId);
    const child = childIds.has(threadId) ? (await storedChildren(null)).get(threadId) : null;
    const turns = new Map((child ? child.turns : claudeTurnsOf(store, threadId)).map(turn => [turn.id, turn]));
    if (running) turns.set(running.turnId, running.snapshot(kind === "turns" ? view : "full"));
    const itemPositions = new Map<string, number>();
    const records = kind === "turns" ? [...turns.values()] : [...turns.values()].filter(turn => !params.turnId || turn.id === params.turnId).flatMap(turn => (turn.items ?? []).map((item, index: number) => {
      if (turn.startedAtMs != null) itemPositions.set(`${turn.id}:${item.id}`, index);
      return { turnId: turn.id, item, startedAtMs: turn.startedAtMs ?? (turn.startedAt ?? 0) * 1000 + index, completedAtMs: turn.completedAt == null ? null : turn.completedAt * 1000 };
    }));
    const idOf = (row: HistoryRow) => kind === "turns" ? (row as TranscriptTurn).id : (row as ItemRow).item?.id;
    const keyOf = (row: HistoryRow): [number, string] => {
      const itemRow = row as ItemRow, turn = row as TranscriptTurn;
      const position = itemPositions.get(`${itemRow.turnId}:${itemRow.item?.id}`);
      return [kind === "turns" ? (turn.startedAtMs == null ? turn.startedAt ?? 0 : turn.startedAtMs / 1000) : itemRow.startedAtMs ?? 0,
        position == null ? String(idOf(row) ?? "") : `${String(position).padStart(10, "0")}:${idOf(row)}`];
    };
    const compareKey = (a: [number, string], b: [number, string]) => ((a[0] - b[0]) || a[1].localeCompare(b[1])) * (direction === "desc" ? -1 : 1);
    const compare = (a: HistoryRow, b: HistoryRow) => compareKey(keyOf(a), keyOf(b));
    const providerIds = new Set(records.map(idOf));
    const stored = legacy ? [] : records.filter(row => (!state.storedAfter || compareKey(keyOf(row), state.storedAfter) > 0)).sort(compare);
    let storedIndex = 0;
    let nativePage: TurnPage | ItemPage | null = null;
    let nativeRows: HistoryRow[] = [];
    let nativeDone = !!child;
    let seen = new Set(state.nativeSeen);
    const nativeParams = { threadId, limit: state.nativeLimit, sortDirection: direction, ...(kind === "turns" ? { itemsView: view } : params.turnId ? { turnId: params.turnId } : {}) };
    const ensureNative = async () => {
      while (!nativeRows.length && !nativeDone) {
        if (nativePage) {
          if (!nativePage.nextCursor) { nativeDone = true; break; }
          if (nativePage.nextCursor === state.nativeCursor) throw new Error("Native history cursor did not advance");
          state.nativeCursor = nativePage.nextCursor;
          seen = new Set();
        }
        nativePage = await nativeProviderHistory(`thread/${kind}/list`, { ...nativeParams, ...(state.nativeCursor ? { cursor: state.nativeCursor } : {}) });
        nativeRows = (nativePage.data ?? []).filter(row => !providerIds.has(idOf(row)) && !seen.has(idOf(row)));
      }
    };
    const data: HistoryRow[] = [];
    let pageBytes = 2;
    const pageByteLimit = 6 * 1024 * 1024;
    while (data.length < limit) {
      await ensureNative();
      const a = stored[storedIndex], b = nativeRows[0];
      if (!a && !b) break;
      // Keep the native rollout order intact, including ties across native pages.
      const storedFirst = a && (!b || ((keyOf(a)[0] - keyOf(b)[0]) * (direction === "desc" ? -1 : 1) < 0) || (keyOf(a)[0] === keyOf(b)[0] && direction === "desc"));
      const row = (storedFirst ? (kind === "turns" ? turnProjection(a as TranscriptTurn, view) : a) : b) as HistoryRow;
      const skipping = state.boundary && idOf(row) !== state.boundary;
      if (!skipping) {
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes > pageByteLimit) throw new Error(`History ${kind === "items" ? "item" : "turn"} ${idOf(row)} exceeds the supported page size; its saved content was not truncated.`);
        if (data.length && pageBytes + bytes > pageByteLimit) break;
        pageBytes += bytes;
      }
      if (storedFirst) {
        storedIndex++;
        state.storedAfter = keyOf(a as HistoryRow);
      } else {
        nativeRows.shift();
        seen.add(idOf(b as HistoryRow) as string);
      }
      if (skipping) continue;
      state.boundary = null;
      data.push(row);
    }
    // Determine continuation without hydrating another native page.
    const moreNative = nativeRows.length || (!nativeDone && (nativePage as TurnPage | ItemPage | null)?.nextCursor);
    state.nativeSeen = [...seen];
    const nextCursor = storedIndex < stored.length || moreNative ? encode(state) : null;
    let backwardsCursor = null;
    if (data.length) {
      backwardsCursor = "acp-page:" + Buffer.from(JSON.stringify({ ...binding, direction: direction === "desc" ? "asc" : "desc", nativeCursor: null, nativeSeen: [], nativeLimit: limit, storedAfter: null, boundary: idOf(data[0] as HistoryRow) })).toString("base64url");
    }
    return { data, nextCursor, backwardsCursor };
  }
  async function resumeHistory(result: ResumeResult, threadId: string, store: Store, params: { excludeTurns?: boolean; initialTurnsPage?: HistoryOptions }) {
    result = { ...result, thread: { ...result.thread, ...threadSeen.get(threadId) } };
    const owner = providerOwners.get(threadId);
    if (owner) result.thread.status = owner.status();
    if (params.excludeTurns) {
      result.thread.turns = [];
      result.turnsBackwardsCursor = null;
    } else {
      const history = await providerHistory(threadId, store);
      result.thread.turns = history.turns;
      result.turnsBackwardsCursor = history.cursor;
    }
    result.initialTurnsPage = params.initialTurnsPage ? await providerPage(threadId, store, "turns", params.initialTurnsPage) : null;
    return result;
  }
  async function listProviderHistory(msg: ThreadRequest, store: Store) {
    const tid = msg.params?.threadId;
    const existing = providerOwners.get(tid);
    if (existing && existing.ws !== ws) {
      const target = forwarded.get(msg.id);
      forwarded.delete(msg.id);
      existing.dispatch(msg, target?.client ?? ws);
      return;
    }
    const result = await providerPage(tid, store, msg.method === "thread/turns/list" ? "turns" : "items", msg.params);
    toTui({ id: msg.id, result });
  }
  async function priorTranscript(threadId: string) {
    try {
      const r = await engineCall("thread/turns/list", { threadId, limit: 30, sortDirection: "desc", itemsView: "full" }).catch(() => ({ data: [] }));
      await storeChain();
      const stored = claudeTurnsOf(await loadStore(), threadId);
      const have = new Set((r.data ?? []).map((t) => t.id));
      const all = [...(r.data ?? []), ...stored.filter((t) => !have.has(t.id))].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const lines = [];
      for (const turn of all) for (const it of turn.items ?? []) {
        if (it.type === "userMessage") lines.push(`User: ${textOf(it.content)}`);
        else if (it.type === "agentMessage" && it.text?.trim()) lines.push(`Assistant: ${it.text.trim()}`);
        else if (it.type === "commandExecution") lines.push(`(Assistant ran: ${plainCommand(it.command as string)})`);
        else if (it.type === "fileChange") lines.push(`(Assistant edited: ${(it.changes ?? []).map((c) => c.path).join(", ")})`);
      }
      const t = lines.join("\n\n");
      return t.length > 12000 ? t.slice(-12000) : t;
    } catch (e) { log(`history read for ${threadId}: ${(e as BridgeError).message ?? JSON.stringify(e)}`); return ""; }
  }
  return { claudeTurnsOf, providerHistory, resumeHistory, listProviderHistory, priorTranscript };
}
