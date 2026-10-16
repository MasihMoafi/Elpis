export type DeletionPageOptions = { archived: boolean; limit: number; cursor?: string };
export type DeletionPage<T extends { id: string }> = { data: T[]; nextCursor: string | null };

export async function scanDeletionThreads<T extends { id: string }>(readPage: (options: DeletionPageOptions) => Promise<DeletionPage<T>>): Promise<T[]> {
  const threads = new Map<string, T>();
  for (const archived of [false, true]) {
    const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await readPage({ archived, limit: 100, ...(cursor !== null ? { cursor } : {}) }), next = page?.nextCursor;
      if (!Array.isArray(page?.data) || page.data.some(thread => !thread || typeof thread !== "object" || Array.isArray(thread) || typeof thread.id !== "string" || !thread.id.trim() || thread.id.includes("\0"))
        || (next !== null && (typeof next !== "string" || !next || cursors.has(next)))) throw new Error("Could not read the complete conversation list. Nothing was deleted.");
      for (const thread of page.data) if (!threads.has(thread.id)) threads.set(thread.id, thread);
      if (next !== null) cursors.add(next); cursor = next;
    } while (cursor !== null);
  }
  return [...threads.values()];
}
