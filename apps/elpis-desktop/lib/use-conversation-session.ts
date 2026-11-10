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
  const restoreScroll = useRef<{ height: number; top: number; anchor?: Element; offset?: number } | null>(null);
  const scrollPositions = useRef(new Map<string, { turn: number; offset: number; atBottom: boolean }>());
  const pendingPosition = useRef<{ id: string; turn: number; offset: number; atBottom: boolean } | null>(null);
  const saveScroll = () => {
    const id = selectedRef.current?.id,
      element = scroll.current;
    if (!id || !element) return;
    // The turn at the top of the view, counted from the end, and how far down it sits. Pixels alone drift: turns off screen
    // render at an estimated height until seen (content-visibility), and a chat reloads only its latest page (C5; 10 Nov).
    const box = element.getBoundingClientRect(),
      turns = [...element.querySelectorAll(".turn")],
      index = turns.findIndex(turn => turn.getBoundingClientRect().bottom > box.top);
    scrollPositions.current.set(id, {
        turn: index < 0 ? 0 : turns.length - 1 - index,
        offset: index < 0 ? 0 : turns[index]!.getBoundingClientRect().top - box.top,
        // At it, not near it: a reader slightly above the end comes back to that place (specs/chat-scrolling.md C5).
        atBottom: element.scrollHeight - element.scrollTop - element.clientHeight <= 2,
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
