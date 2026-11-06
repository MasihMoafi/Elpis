import { useEffect, useState } from "react";

/** A message as he should read it: no "Error:" prefix and no diagnostic code or request ID (6 Nov, Masih: "I don't like to see
 * such errors ... like this ever"). */
export const plainMessage = (text: string) => text.replace(/^(?:Type)?Error:\s*/, "").replace(/\s*\(ELPIS_[A-Z_]+(?:; request [a-f0-9-]+)?\)\s*$/, "");

/** The workspace's own notices, under the chat: the last error (it fades after 10 s), "Deleted …" with its Undo (8 s), and
 * the worktrees a delete or archive kept. */
export function useWorkspaceNotices() {
  const [error, setError] = useState("");
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(""), 10_000); return () => clearTimeout(timer); }, [error]);
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);
  useEffect(() => { if (!deletedNotice) return; const timer = setTimeout(() => setDeletedNotice(null), 8000); return () => clearTimeout(timer); }, [deletedNotice]);
  const [worktreeNotice, setWorktreeNotice] = useState("");
  const noteKept = (text: string) => { if (text) setWorktreeNotice(previous => previous ? `${previous} ${text}` : text); };
  return { error, setError, deletedNotice, setDeletedNotice, worktreeNotice, setWorktreeNotice, noteKept };
}
