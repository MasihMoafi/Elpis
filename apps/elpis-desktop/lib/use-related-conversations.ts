import { useEffect, useState } from "react";
import { api, isAgentRun, type Thread } from "@/lib/api";

export function useRelatedConversations(selected: Thread | null, threads: Thread[], showAgentRuns: boolean, agentRunsOpen: boolean) {
  const [related, setRelated] = useState<Record<string, Thread>>({});
  // Name the parent and the agent a continued chat came from, even when they are not on the loaded page.
  const relatedIds = [...new Set([selected?.parentThreadId, selected?.forkedFromId, ...(showAgentRuns && agentRunsOpen ? threads.filter(isAgentRun).map(thread => thread.parentThreadId) : [])])].filter((id): id is string => !!id && !threads.some(thread => thread.id === id) && !related[id]);
  useEffect(() => {
    for (const id of relatedIds) api<{ thread: Thread }>(`/threads/${encodeURIComponent(id)}?limit=1`).then(result => setRelated(prev => ({ ...prev, [id]: result.thread }))).catch(() => {});
  }, [relatedIds.join(",")]);
  return related;
}
