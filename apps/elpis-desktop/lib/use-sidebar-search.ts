import { useEffect, useState, type RefObject } from "react";
import { api, unreadable, type Thread } from "./api";
import { mergeListedThreads } from "./agents";

type SearchPage = { query: string; data: Thread[]; nextCursor: string | null; loading: boolean; error: string };
const EMPTY: SearchPage = { query: "", data: [], nextCursor: null, loading: false, error: "" };
const searchPath = (query: string, cursor?: string | null) => `/threads?limit=100&searchTerm=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The sidebar's search: what he typed, and the saved conversations the bridge found for it (asked 250 ms after typing stops,
 * then page by page). `results` is null until they belong to the current text. */
export function useSidebarSearch(ready: boolean, hidden: RefObject<Set<string>>) {
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const [page, setPage] = useState<SearchPage>(EMPTY);
  useEffect(() => {
    if (!ready || !searchTerm) { setPage(EMPTY); return; }
    let disposed = false;
    setPage({ ...EMPTY, query: searchTerm, loading: true });
    const timer = setTimeout(() => {
      api<{ data: Thread[]; nextCursor: string | null }>(searchPath(searchTerm))
        .then(result => { if (!Array.isArray(result.data)) throw unreadable("search"); if (!disposed) setPage({ ...EMPTY, query: searchTerm, data: result.data, nextCursor: result.nextCursor }); })
        .catch(cause => { if (!disposed) setPage({ ...EMPTY, query: searchTerm, error: message(cause) }); });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready, searchTerm]);
  async function loadMore() {
    if (!page.nextCursor || page.loading || page.query !== searchTerm) return;
    const query = searchTerm;
    setPage(previous => ({ ...previous, loading: true, error: "" }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(searchPath(query, page.nextCursor)); if (!Array.isArray(result.data)) throw unreadable("conversations");
      setPage(previous => previous.query === query ? { ...EMPTY, query, data: mergeListedThreads(previous.data, result.data, hidden.current), nextCursor: result.nextCursor } : previous);
    } catch (cause) { setPage(previous => previous.query === query ? { ...previous, loading: false, error: message(cause) } : previous); }
  }
  const results = searchTerm && page.query === searchTerm ? page : null;
  return { search, setSearch, searchTerm, results, loadMore };
}
