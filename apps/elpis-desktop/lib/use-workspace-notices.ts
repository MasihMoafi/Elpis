import { useEffect, useState } from "react";

export { plainMessage } from "./error-text.mts";

/** The workspace's own notices, under the chat: the last error (it fades after 10 s), "Deleted …" with its Undo (8 s), what
 * an undo or redo of a chat action did (8 s), and the worktrees a delete or archive kept. */
export function useWorkspaceNotices() {
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 10_000);
    return () => clearTimeout(timer);
  }, [error]);
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!deletedNotice) return;
    const timer = setTimeout(() => setDeletedNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [deletedNotice]);
  // "Undone: …" / "Redone: …" after Ctrl+Z or Ctrl+Shift+Z on a chat action (lib/chat-undo.ts), 8 s.
  const [historyNotice, setHistoryNotice] = useState("");
  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") setHistoryNotice(event.detail);
    };
    window.addEventListener("elpis-default-model-change", changed);
    return () => window.removeEventListener("elpis-default-model-change", changed);
  }, []);
  useEffect(() => {
    if (!historyNotice) return;
    const timer = setTimeout(() => setHistoryNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [historyNotice]);
  const [worktreeNotice, setWorktreeNotice] = useState("");
  const noteKept = (text: string) => {
    if (text) setWorktreeNotice(previous => (previous ? `${previous} ${text}` : text));
  };
  return {
    error,
    setError,
    deletedNotice,
    setDeletedNotice,
    historyNotice,
    setHistoryNotice,
    worktreeNotice,
    setWorktreeNotice,
    noteKept,
  };
}
