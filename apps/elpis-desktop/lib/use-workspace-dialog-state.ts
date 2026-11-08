import { useRef, useState } from "react";
import type { Thread } from "@/lib/api";

/** Dialogs shared by the workspace and the focus each keyboard dialog returns to. */
export function useWorkspaceDialogState() {
  const [newGroupFor, setNewGroupFor] = useState<string[] | null>(null);
  /** Chats awaiting the shared delete confirmation (a row's menu, D, or the header's Chat actions). */
  const [deleteTargets, setDeleteTargets] = useState<Thread[] | null>(null);
  const [deleteRunHistory, setDeleteRunHistory] = useState(false);
  /** After the sidebar deletes chats, Undo (or Ctrl+Z) reopens the chat that was open. */
  const shownWhenDeleted = useRef(new Set<string>());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  const shortcutsReturnFocus = useRef<HTMLElement | null>(null);
  const [renameRequest, setRenameRequest] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  return {
    newGroupFor,
    setNewGroupFor,
    deleteTargets,
    setDeleteTargets,
    deleteRunHistory,
    setDeleteRunHistory,
    shownWhenDeleted,
    shortcutsOpen,
    setShortcutsOpen,
    commandMenuOpen,
    setCommandMenuOpen,
    commandReturnFocus,
    shortcutsReturnFocus,
    renameRequest,
    setRenameRequest,
    resumeOpen,
    setResumeOpen,
  };
}
