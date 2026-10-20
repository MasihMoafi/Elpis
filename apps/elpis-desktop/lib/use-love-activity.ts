"use client";

import { useEffect, useRef, useState } from "react";
import { loveActivity, newLoveReplies } from "./love-activity";

export function useLoveActivity(active: boolean, ready: boolean) {
  const activeRef = useRef(active); activeRef.current = active;
  const [unread, setUnread] = useState<string[]>([]);
  const [threads, setThreads] = useState<Record<string, string>>({});
  useEffect(() => { if (active) setUnread([]); }, [active]);
  useEffect(() => {
    if (!ready) return;
    let previous: Map<string, string> | null = null;
    const events = new EventSource("/api/love-spot/events");
    events.onmessage = event => {
      let data: { type?: string; scene?: { elements?: unknown } };
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== "scene") return;
      const agents = loveActivity(data.scene?.elements);
      const replies = newLoveReplies(previous, agents);
      previous ??= new Map();
      agents.forEach(agent => previous!.set(agent.id, agent.reply));
      if (!activeRef.current && replies.length) setUnread(current => [...new Set([...current, ...replies])]);
      const identified = agents.filter(agent => agent.threadId);
      if (identified.length) setThreads(current => {
        if (identified.every(agent => current[agent.threadId!] === agent.name)) return current;
        return { ...current, ...Object.fromEntries(identified.map(agent => [agent.threadId!, agent.name])) };
      });
    };
    return () => events.close();
  }, [ready]);
  return { unread: unread.length, threads };
}
