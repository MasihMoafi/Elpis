import { useEffect, useRef, useState } from "react";
import type { SideRequest } from "@/components/side-chat";
import type { useComposerState } from "@/lib/use-composer-state";
import type { View } from "@/lib/workspace-types";

export type ComposerPanel = "status" | "review" | "diff" | null;
export type SideChatState = { parentId: string; open: boolean; question?: SideRequest } | null;

export function useComposerPanels() {
  /** What a slash command has open above the composer, and the one-line answer of a command that only reports. */
  const [panel, setPanel] = useState<ComposerPanel>(null);
  const [slashNotice, setSlashNotice] = useState("");
  // /compact typed while the agent works runs when that turn finishes, as in the terminal.
  const [queuedCompact, setQueuedCompact] = useState<{ threadId: string; guidance?: string } | null>(null);
  // A new chat in its own worktree (the Local/Worktree menu).
  const [newWorktree, setNewWorktree] = useState(false);
  const [sideChat, setSideChat] = useState<SideChatState>(null);
  const sideRequests = useRef(0);
  return { panel, setPanel, slashNotice, setSlashNotice, queuedCompact, setQueuedCompact, newWorktree, setNewWorktree, sideChat, setSideChat, sideRequests };
}

/** A panel belongs to the chat and page it was opened on; a notice goes when the person types again. */
export function useComposerPanelScope(panels: ReturnType<typeof useComposerPanels>, composer: ReturnType<typeof useComposerState>, selectedId: string | undefined, view: View) {
  const { setPanel, setSideChat, setSlashNotice } = panels, { shellCreated, setShellMode, text } = composer;
  useEffect(() => { setPanel(null); }, [selectedId, view]);
  useEffect(() => { if (shellCreated.current !== selectedId || view !== "chat") setShellMode(false); shellCreated.current = null; setSideChat(null); }, [selectedId, view]);
  useEffect(() => { if (text) setSlashNotice(""); }, [text]);
}
