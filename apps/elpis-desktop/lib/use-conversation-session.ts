import { useRef, useState } from "react";
import type { Entry, Thread } from "@/lib/api";
import type { SubmittedMessage } from "@/lib/submitted-messages";

/** The open conversation, its transcript, and the request and scroll guards used while it changes. */
export function useConversationSession() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedRef = useRef<Thread | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [submissions, setSubmissions] = useState<SubmittedMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const sending = useRef(0);
  const [loading, setLoading] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const followingBottom = useRef(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const scrollPositions = useRef(new Map<string, { top: number; atBottom: boolean }>());
  const pendingPosition = useRef<{ id: string; top: number; atBottom: boolean } | null>(null);
  const saveScroll = () => {
    const id = selectedRef.current?.id,
      element = scroll.current;
    if (id && element)
      scrollPositions.current.set(id, {
        top: element.scrollTop,
        atBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 80,
      });
  };
  const request = useRef(0);
  const initialRestoration = useRef<{ threadId: string; promise: Promise<void> } | null>(null);
  return {
    threads,
    setThreads,
    selected,
    setSelected,
    selectedRef,
    entries,
    setEntries,
    submissions,
    setSubmissions,
    busy,
    setBusy,
    sending,
    loading,
    setLoading,
    scroll,
    stickToBottom,
    followingBottom,
    awayFromBottom,
    setAwayFromBottom,
    restoreScroll,
    scrollPositions,
    pendingPosition,
    saveScroll,
    request,
    initialRestoration,
  };
}
