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
  const request = useRef(0);
  const initialRestoration = useRef<{ threadId: string; promise: Promise<void> } | null>(null);
  return { threads, setThreads, selected, setSelected, selectedRef, entries, setEntries, submissions, setSubmissions, busy, setBusy, sending, loading, setLoading,
    scroll, stickToBottom, followingBottom, awayFromBottom, setAwayFromBottom, restoreScroll, request, initialRestoration };
}
