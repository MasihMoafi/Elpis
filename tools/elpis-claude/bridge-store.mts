import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { withFileLock } from "./file-lock.mts";
import { writeJson } from "./bridge-json.mts";
import type { Store,StoreUpdate } from "./bridge-types.mts";

/** Read and atomically update the shared provider session store. */
export function createBridgeStore(STORE: string, deletedThreads: Set<string>, log: (message: string) => void) {
const saveStore = (store: Store) => writeJson(STORE, store);
async function readStore() {
  try {
    const store: unknown = JSON.parse(await readFile(STORE, "utf8"));
    if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("expected a JSON object");
    return store as Store;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    const error = Object.assign(new Error(`cannot load ${STORE}: ${(e as Error).message}`), { storeLoadError: true });
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
    } catch (e) { const error = e as Error & { storeLoadError?: boolean }; if (!error.storeLoadError) log(`store: ${error.message}`); }
    finally {
      if (pendingStoreUpdates === updates) pendingStoreUpdates = [];
      for (const update of updates) update.resolve(success);
    }
  });
  return saved;
}
  return { loadStore, loadStoreSnapshot, updateStore, storeChain: () => storeChain };
}
