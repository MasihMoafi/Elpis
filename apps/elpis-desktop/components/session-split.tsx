"use client";

import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/attachments";
import type { Thread } from "@/lib/api";

type Session = { thread: Thread | null; text: string; attachments: Attachment[] };
/** Each pane runs the existing chat surface, with its own composer and subscription to the same bridge. */
export function useSessionSplit(session: Session, focus: () => void, promote: (session: Session) => void) {
  const [pane, setPane] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const other = useRef<Session | null>(null);
  const focusRef = useRef(focus); focusRef.current = focus;
  const promoteRef = useRef(promote); promoteRef.current = promote;
  const splitRef = useRef(thread); splitRef.current = thread;
  useEffect(() => {
    const embedded = window.parent !== window && new URLSearchParams(location.search).get("pane") === "1";
    setPane(embedded);
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      if (embedded && event.source === window.parent) {
        if (event.data?.type === "elpis:focus-pane") focusRef.current();
      } else if (event.source === frame.current?.contentWindow) {
        if (event.data?.type === "elpis:pane-state") other.current = event.data.session as Session;
        if (event.data?.type === "elpis:close-pane") { setThread(null); focusRef.current(); }
        if (event.data?.type === "elpis:previous-pane") focusRef.current();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !["[", "]"].includes(event.key)) return;
      if (embedded) {
        event.preventDefault(); window.parent.postMessage({ type: "elpis:previous-pane" }, location.origin);
      } else if (splitRef.current) {
        event.preventDefault(); frame.current?.contentWindow?.postMessage({ type: "elpis:focus-pane" }, location.origin);
      }
    };
    window.addEventListener("message", message); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("message", message); window.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => { if (pane) window.parent.postMessage({ type: "elpis:pane-state", session }, location.origin); }, [pane, session.thread, session.text, session.attachments]);
  const close = () => {
    if (pane) window.parent.postMessage({ type: "elpis:close-pane" }, location.origin);
    else if (other.current) { const remaining = other.current; setThread(null); promoteRef.current(remaining); }
  };
  return { pane, thread, frame, close, open: (next: Thread) => { other.current = null; setThread(next); } };
}
