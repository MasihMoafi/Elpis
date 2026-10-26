"use client";

import { useEffect, useRef, useState } from "react";
import { chatOrigin, loveActivity, newLoveReplies } from "./love-activity";
import { subscribeLoveSpotEvents } from "./love-spot-events";

export function useLoveActivity(active: boolean, ready: boolean, activeThread?: { id: string; name?: string | null } | null) {
  const [unread, setUnread] = useState<string[]>([]);
  const [origins, setOrigins] = useState<{ threads: Record<string, string>; resolved: boolean }>({ threads: {}, resolved: false });
  const threads = origins.threads;
  const reading = active || !!activeThread && chatOrigin(activeThread, threads) === "Love Spot";
  const activeRef = useRef(reading); activeRef.current = reading;
  useEffect(() => { if (reading) setUnread([]); }, [reading]);
  useEffect(() => {
    const unresolved = () => setOrigins(current => current.resolved ? { ...current, resolved: false } : current);
    unresolved();
    if (!ready) return;
    let previous: Map<string, string> | null = null;
    return subscribeLoveSpotEvents(event => {
      let data: { type?: string; scene?: { elements?: unknown } } | null;
      try { data = JSON.parse(event.data); } catch { unresolved(); return; }
      if (data?.type === "screenshots") return;
      const elements = data?.scene?.elements;
      if (data?.type !== "scene" || !Array.isArray(elements)) { unresolved(); return; }
      const agents = loveActivity(elements);
      const replies = newLoveReplies(previous, agents);
      previous ??= new Map();
      agents.forEach(agent => previous!.set(agent.id, agent.reply));
      if (!activeRef.current && replies.length) setUnread(current => [...new Set([...current, ...replies])]);
      const identified = agents.filter(agent => agent.threadId);
      setOrigins(current => {
        const threads = identified.every(agent => current.threads[agent.threadId!] === agent.name) ? current.threads
          : { ...current.threads, ...Object.fromEntries(identified.map(agent => [agent.threadId!, agent.name])) };
        return current.resolved && threads === current.threads ? current : { threads, resolved: true };
      });
    }, unresolved);
  }, [ready]);
  return { unread: unread.length, threads, originsResolved: ready && origins.resolved };
}
