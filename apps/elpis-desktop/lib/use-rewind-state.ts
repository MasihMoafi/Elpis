import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import type { MessageVersion } from "@/lib/turn-replacement";
import type { createMessageActions } from "@/lib/message-actions";

export function useRewindState() {
  /** The message whose "Rewind to here" is awaiting confirmation (its turn). */
  const [rewindTurn, setRewindTurn] = useState<string | null>(null);
  const [rewindActions, setRewindActions] = useState<Record<string, "undo" | "redo" | undefined>>({});
  /** ChatGPT's ‹ 1/2 › under an edited message, per chat: its versions by turn (bridge/message-versions.mts). */
  const [messageVersions, setMessageVersions] = useState<Record<string, MessageVersion[]>>({});
  const [rewindBusy, setRewindBusy] = useState(false);
  const rewindSwitch = useRef<string | null>(null);
  return {
    rewindTurn,
    setRewindTurn,
    rewindActions,
    setRewindActions,
    messageVersions,
    setMessageVersions,
    rewindBusy,
    setRewindBusy,
    rewindSwitch,
  };
}

export function useRewindStatus(
  ready: boolean,
  connected: boolean,
  threadId: string | undefined,
  activeTurn: string | undefined,
  setRewindActions: Dispatch<SetStateAction<Record<string, "undo" | "redo" | undefined>>>,
  loadVersions: ReturnType<typeof createMessageActions>["loadVersions"],
) {
  useEffect(() => {
    const id = threadId;
    if (!ready || !connected || !id || activeTurn) return;
    let disposed = false;
    api<{ action?: "undo" | "redo" } | null>(`/threads/${encodeURIComponent(id)}/rewind`, { action: "status" })
      .then(result => {
        if (!disposed) setRewindActions(prev => ({ ...prev, [id]: result?.action }));
      })
      .catch(() => {});
    loadVersions(id, () => disposed);
    return () => {
      disposed = true;
    };
  }, [ready, connected, threadId, activeTurn]);
}
