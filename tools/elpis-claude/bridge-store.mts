import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { withFileLock } from "./file-lock.mts";
import { writeJson } from "./bridge-json.mts";
import { wireObject } from "./bridge-wire.mts";
import { isTranscriptItem,isTranscriptTurn } from "./bridge-transcript.mts";
import { isEngineThread } from "./bridge-engine-protocol.mts";
import type { Store,StoreUpdate,SavedSession,SavedHelper } from "./bridge-types.mts";

const string = (v: unknown): v is string => typeof v === "string";
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const boolean = (v: unknown): v is boolean => typeof v === "boolean";
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const nullable = (v: unknown, check: (value: unknown) => boolean) => v === null || check(v);
const array = (v: unknown, check: (value: unknown) => boolean) => Array.isArray(v) && v.every(check);
const strings = (v: unknown) => array(v, string);
const record = (v: unknown, check: (value: unknown) => boolean) => wireObject(v) && Object.values(v).every(check);
const isHelper = (v: unknown): v is SavedHelper => wireObject(v) && string(v.parentThreadId)
  && optional(v.model, x => nullable(x, string)) && optional(v.requested, string)
  && optional(v.ceiling, x => x === "read-only" || x === "workspace-write" || x === "danger-full-access")
  && optional(v.startedAt, number) && optional(v.workflowRunId, string) && optional(v.workflowAgentId, x => nullable(x, string));
const isSession = (v: unknown): v is SavedSession => wireObject(v)
  && optional(v.model, x => nullable(x, string)) && optional(v.nativeModel, string) && optional(v.effort, x => nullable(x, string))
  && optional(v.agent, string) && optional(v.mode, string) && optional(v.session, string) && optional(v.sessions, x => record(x, string))
  && optional(v.claudeAccountId, x => nullable(x, string)) && optional(v.turns, x => array(x, isTranscriptTurn))
  && optional(v.parentThreadId, string) && optional(v.rootThreadId, string) && optional(v.cwd, string)
  && optional(v.contextSessionId, string) && optional(v.providerHistory, boolean)
  && optional(v.thread, isEngineThread)
  && optional(v.active, x => wireObject(x) && string(x.turnId) && number(x.startedAt) && optional(x.startedAtMs, number) && number(x.pid)
    && optional(x.cwd, string) && optional(x.userItems, y => array(y, isTranscriptItem)) && optional(x.preview, string) && optional(x.transcriptOffset, number) && optional(x.inputs, strings))
  && optional(v.contextFiles, x => array(x, f => wireObject(f) && string(f.name) && string(f.path) && string(f.group)
    && boolean(f.included) && boolean(f.selectable) && optional(f.estimatedTokens, number) && optional(f.reason, string)))
  && optional(v.forkOf, x => wireObject(x) && string(x.threadId) && optional(x.at, number)
    && optional(x.beforeTurnId, y => nullable(y, string)) && optional(x.lastTurnId, y => nullable(y, string)) && optional(x.copied, boolean))
  && optional(v.goal, x => x === null || (wireObject(x) && string(x.threadId) && string(x.objective) && string(x.status)
    && nullable(x.tokenBudget, number) && number(x.tokensUsed) && number(x.timeUsedSeconds) && number(x.createdAt) && number(x.updatedAt)))
  && optional(v.plan, x => wireObject(x) && string(x.turnId) && nullable(x.explanation, string)
    && array(x.plan, step => wireObject(step) && string(step.step) && string(step.status)));
const isStore = (v: unknown): v is Store => wireObject(v) && Object.entries(v).every(([key, value]) =>
  key === "_default" ? wireObject(value) && string(value.model) && optional(value.effort, x => nullable(x, string))
    : key === "_delegations" ? record(value, isHelper) : isSession(value));

/** Read and atomically update the shared provider session store. */
export function createBridgeStore(STORE: string, deletedThreads: Set<string>, log: (message: string) => void) {
const saveStore = (store: Store) => writeJson(STORE, store);
async function readStore() {
  try {
    const store: unknown = JSON.parse(await readFile(STORE, "utf8"));
    if (!wireObject(store)) throw new Error("expected a JSON object");
    if (!isStore(store)) throw new Error("invalid saved session records");
    return store;
  } catch (e) {
    if (wireObject(e) && e.code === "ENOENT") return {};
    const error = Object.assign(new Error(`cannot load ${STORE}: ${e instanceof Error ? e.message : String(e)}`), { storeLoadError: true });
    log(`store: ${error.message}`);
    throw error;
  }
}
// All read-only callers share a parse of the saved version, including concurrent startup reads.
// Writes still read a fresh, private copy. Atomic saves and external replacements invalidate it.
let storeSnapshot: { sig: string; store: Store } | null = null;
let storeRead: { sig: string | null; promise: Promise<Store> } | null = null;
async function loadStore() { return loadStoreSnapshot(); }
async function loadStoreSnapshot() {
  let sig = null;
  try { const s = statSync(STORE); sig = `${s.ino}:${s.size}:${s.mtimeMs}`; } catch {}
  if (sig && storeSnapshot?.sig === sig) return storeSnapshot.store;
  if (sig && storeRead?.sig === sig) return storeRead.promise;
  const promise = readStore().then(store => { if (sig) storeSnapshot = { sig, store }; return store; });
  storeRead = { sig, promise };
  try { return await promise; }
  finally { if (storeRead?.promise === promise) storeRead = null; }
}
let storeChain = Promise.resolve();
let pendingStoreUpdates: StoreUpdate[] = [];
// Resolves true once saved, false if saving failed.
function updateStore(fn: (store: Store) => void) {
  const updates = pendingStoreUpdates;
  const saved = new Promise<boolean>(resolve => updates.push({ fn, resolve }));
  if (updates.length === 1) storeChain = storeChain.then(async () => {
    let success = false;
    try {
      await withFileLock(STORE, async () => {
        const st = await readStore();
        // Edits arriving during the read share this transaction, in order. Edits
        // arriving during the save get a new transaction behind this one.
        pendingStoreUpdates = [];
        for (const update of updates) update.fn(st);
        // Late plan/tool notifications cannot recreate a deleted transcript.
        for (const tid of deletedThreads) { delete st[tid]; if (st._delegations) delete st._delegations[tid]; }
        await saveStore(st);
      });
      success = true;
    } catch (e) { if (!wireObject(e) || !e.storeLoadError) log(`store: ${e instanceof Error ? e.message : String(e)}`); }
    finally {
      if (pendingStoreUpdates === updates) pendingStoreUpdates = [];
      for (const update of updates) update.resolve(success);
    }
  });
  return saved;
}
  return { loadStore, loadStoreSnapshot, updateStore, storeChain: () => storeChain };
}
