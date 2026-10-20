/** Owns server-backed conversation search and its pagination. */
import { useEffect, useState } from "react";
import { api, unreadable, type Thread } from "@/lib/api";
import { mergeListedThreads } from "@/lib/agents";

export function useChatSearch(ready: boolean, hidden: { current: Set<string> }) {
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const [searchResults, setSearchResults] = useState<{ query: string; data: Thread[]; nextCursor: string | null; loading: boolean; error: string }>({ query: "", data: [], nextCursor: null, loading: false, error: "" });
  useEffect(() => {
    if (!ready || !searchTerm) { setSearchResults({ query: "", data: [], nextCursor: null, loading: false, error: "" }); return; }
    let disposed = false;
    setSearchResults({ query: searchTerm, data: [], nextCursor: null, loading: true, error: "" });
    const timer = setTimeout(() => {
      api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&searchTerm=${encodeURIComponent(searchTerm)}`)
        .then(result => { if (!Array.isArray(result.data)) throw unreadable("search"); if (!disposed) setSearchResults({ query: searchTerm, data: result.data, nextCursor: result.nextCursor, loading: false, error: "" }); })
        .catch(cause => { if (!disposed) setSearchResults({ query: searchTerm, data: [], nextCursor: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready, searchTerm]);
  async function loadMoreSearch() {
    if (!searchResults.nextCursor || searchResults.loading || searchResults.query !== searchTerm) return;
    const query = searchTerm;
    setSearchResults(previous => ({ ...previous, loading: true, error: "" }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&searchTerm=${encodeURIComponent(query)}&cursor=${encodeURIComponent(searchResults.nextCursor)}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      setSearchResults(previous => previous.query === query ? { query, data: mergeListedThreads(previous.data, result.data, hidden.current), nextCursor: result.nextCursor, loading: false, error: "" } : previous);
    } catch (cause) { setSearchResults(previous => previous.query === query ? { ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) } : previous); }
  }
  return { search, setSearch, searchTerm, searchResults, loadMoreSearch };
}
