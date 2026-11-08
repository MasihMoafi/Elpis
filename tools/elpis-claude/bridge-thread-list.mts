import { inputSummary,isPromptInput } from "./bridge-transcript.mts";
import type { EngineCall,ActiveRecord,BridgeResponses,EngineThread,ProviderTurn,SavedSession,Store,TranscriptItem,TranscriptTurn } from "./bridge-types.mts";

export type ThreadListRequest = { sortKey?: string; sortDirection?: string; cursor?: string; cwd?: string | string[]; sourceKinds?: string[]; modelProviders?: string[]; searchTerm?: string; archived?: boolean; sectionId?: unknown; projectId?: unknown; parentThreadId?: unknown; ancestorThreadId?: unknown };
type Dependencies = { engineCall: EngineCall; activeTurns: Map<string, ProviderTurn>; ownModel: (thread: EngineThread, store: Store) => boolean; storeChain: () => Promise<void>; loadStore: () => Promise<Store>; now: () => number; log: (message: string) => void };

export const listField = (req: ThreadListRequest) => ({ updated_at: "updatedAt", recency_at: "recencyAt" } as Record<string, "updatedAt" | "recencyAt">)[req.sortKey as string] ?? "createdAt";
export const previewOf = (first: TranscriptItem | undefined) => first?.type === "userMessage" ? inputSummary(first.content?.filter(isPromptInput) ?? []) : first?.type === "enteredReviewMode" ? `Code review: ${first.review}` : "";
export const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

export const shouldMergeThreadList = (req: ThreadListRequest) => !req.archived && req.sortKey !== "section_position" && req.sortDirection !== "asc"
  && req.sectionId == null && req.projectId == null && req.parentThreadId == null && req.ancestorThreadId == null;

/** Add provider-only chats to the matching native history page. */
export function createThreadList({ engineCall, activeTurns, ownModel, storeChain, loadStore, now, log }: Dependencies) {
  const pageFloor = new Map<string, number>(); // nextCursor -> sort value of the last thread on the page before it
  const previewed = new Set<string>(); // threads the engine lists itself
  const missingThreadUntil = new Map<string, number>(); // a native thread/read said this saved chat is not loaded
  const runningFirstTurn = (saved: SavedSession | undefined): saved is SavedSession & { active: ActiveRecord & { preview: string } } => !saved?.turns?.length && typeof saved?.active?.preview === "string";
  async function unlistedClaudeThreads(req: ThreadListRequest, page: { data: EngineThread[]; nextCursor?: string | null }) {
    const field = listField(req);
    const value = (t: EngineThread) => t[field] ?? t.updatedAt ?? 0;
    const ceiling = req.cursor ? pageFloor.get(req.cursor) : Infinity;
    const floor = page.nextCursor && page.data.length ? value(page.data.at(-1) as EngineThread) : -Infinity;
    if (page.nextCursor) pageFloor.set(page.nextCursor, floor);
    if (ceiling === undefined) return [];
    const upper = ceiling;
    await storeChain();
    const store = await loadStore();
    const have = new Set(page.data.map((t) => t.id));
    const cwds = req.cwd == null ? null : [req.cwd].flat();
    const candidates = (Object.entries(store) as [string, SavedSession][]).filter(([id, saved]) =>
      !id.startsWith("_") && !have.has(id) && !previewed.has(id) && (saved?.turns?.length || runningFirstTurn(saved)) && !saved.parentThreadId);
    const out: (EngineThread | undefined)[] = new Array(candidates.length);
    let next = 0, failure: unknown;
    async function readCandidate(index: number) {
      const [id, saved] = candidates[index] as [string, SavedSession];
      if ((missingThreadUntil.get(id) ?? 0) > now()) return;
      const t = (await engineCall("thread/read", { threadId: id, includeTurns: false }, 5000).catch((e) => {
        if (e.code === "ETIMEDOUT") throw e;
        if (/^thread not loaded:/.test(e.message ?? "")) missingThreadUntil.set(id, now() + 30_000);
        log(`thread/list: cannot read saved thread ${id}: ${e.message ?? JSON.stringify(e)}`);
        return null;
      }))?.thread;
      if (!t) return;
      missingThreadUntil.delete(id);
      const interactive = t.source === "cli" || t.source === "vscode" || ["atlas", "chatgpt"].includes((t.source as { custom?: string } | undefined)?.custom as string);
      if (req.sourceKinds?.length ? !req.sourceKinds.includes(t.source as string) : !interactive) return;
      if (t.preview) { previewed.add(id); return; }
      if (/\/archived_sessions\//.test(t.path ?? "") || (cwds && !cwds.includes(t.cwd as string))) return;
      if (req.modelProviders?.length && !req.modelProviders.includes(t.modelProvider as string)) return;
      if (value(t) < floor || value(t) >= upper) return;
      const preview = saved.turns?.length ? previewOf((saved.turns[0] as TranscriptTurn).items?.[0]) : (saved.active as ActiveRecord & { preview: string }).preview;
      if (req.searchTerm && ![t.name ?? "", preview].some((text: string) => text.includes(req.searchTerm as string))) return;
      if (preview.trim()) {
        const listed = { ...t, preview: preview.trim() }; ownModel(listed, store);
        // A first turn still running has no saved turn; the store's `active` record, kept by whichever connection runs it, says so.
        if (runningFirstTurn(saved) && (activeTurns.has(id) || processAlive((saved.active as ActiveRecord).pid))) listed.status = { type: "active", activeFlags: [] };
        out[index] = listed;
      }
    }
    // The engine serializes reads per thread, so independent roots can overlap. Keep the
    // window bounded and retain store order for equal timestamps despite out-of-order replies.
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (!failure && next < candidates.length) {
        try { await readCandidate(next++); } catch (e) { failure ??= e; }
      }
    }));
    if (failure) throw failure;
    return out.filter((item): item is EngineThread => Boolean(item));
  }
  return { unlistedClaudeThreads, missingThreadUntil };
}
