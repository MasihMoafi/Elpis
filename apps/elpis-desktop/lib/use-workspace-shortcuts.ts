import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { stopsOnEscape } from "@/lib/prompt-history";
import type { SideChatState } from "@/lib/use-composer-panels";
import type { Thread } from "@/lib/api";
import type { View } from "@/lib/workspace-types";
import { OPEN_CHARACTER_PICKER } from "@/lib/theme-characters";
import type { useSidePanel } from "@/components/side-panel";

type Inputs = {
  shortcutAction: RefObject<(id: string, index?: number) => void>;
  selected: Thread | null;
  ordered: Thread[];
  readOnlyRun: boolean;
  activeTurn: unknown;
  view: View;
  cwd: string;
  desktop: boolean;
  hasTerminal: boolean;
  side: ReturnType<typeof useSidePanel>;
  sideChat: SideChatState;
  setSideChat: Dispatch<SetStateAction<SideChatState>>;
  sidebar: boolean;
  sidebarCollapsed: boolean;
  activeTabId: string;
  commandReturnFocus: RefObject<HTMLElement | null>;
  shortcutsReturnFocus: RefObject<HTMLElement | null>;
  setCommandMenuOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  setRenameRequest: Dispatch<SetStateAction<boolean>>;
  setSettingsSection: (section: "general") => void;
  newChat: () => void;
  stop: (thread: Thread) => Promise<unknown>;
  focusComposer: () => void;
  focusSearch: () => void;
  undoDelete: () => Promise<unknown>;
  showSidebar: (open: boolean) => void;
  narrow: () => boolean;
  show: (view: View) => void;
  goHistory: (direction: -1 | 1) => void;
  loadThread: (thread: Thread) => Promise<unknown>;
  archiveChats: (threads: Thread[]) => void;
  chosenChats: () => Thread[];
  togglePin: (thread: Thread) => void;
  moveToEdge: (id: string, top: boolean) => void;
  newChatTab: () => void;
  closeChatTab: (id: string) => void;
  cycleTabs: (direction: -1 | 1) => void;
};

export function useWorkspaceShortcuts({
  shortcutAction,
  selected,
  ordered,
  readOnlyRun,
  activeTurn,
  view,
  cwd,
  desktop,
  hasTerminal,
  side,
  sideChat,
  setSideChat,
  sidebar,
  sidebarCollapsed,
  activeTabId,
  commandReturnFocus,
  shortcutsReturnFocus,
  setCommandMenuOpen,
  setShortcutsOpen,
  setRenameRequest,
  setSettingsSection,
  newChat,
  stop,
  focusComposer,
  focusSearch,
  undoDelete,
  showSidebar,
  narrow,
  show,
  goHistory,
  loadThread,
  archiveChats,
  chosenChats,
  togglePin,
  moveToEdge,
  newChatTab,
  closeChatTab,
  cycleTabs,
}: Inputs) {
  // Esc stops the running reply, as in Claude, wherever in the chat the focus is, unless a menu, dialog or field owns the key.
  const escapeStops = useRef<(event: KeyboardEvent) => void>(() => {});
  escapeStops.current = event => {
    if (selected && !readOnlyRun && activeTurn && view === "chat" && stopsOnEscape(event)) {
      event.preventDefault();
      void stop(selected);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => escapeStops.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  shortcutAction.current = (id, index) => {
    const at = selected ? ordered.findIndex(t => t.id === selected.id) : -1;
    if (id === "new-chat") newChat();
    else if (id === "command-menu") {
      commandReturnFocus.current = document.activeElement as HTMLElement | null;
      setCommandMenuOpen(true);
    } else if (id === "side-chat" && selected && !readOnlyRun && view === "chat") {
      setSideChat(previous =>
        previous?.parentId === selected.id
          ? { ...previous, open: !previous.open }
          : { parentId: selected.id, open: true },
      );
      if (sideChat?.open) focusComposer();
    } else if (id === "search") focusSearch();
    else if (id === "undo-delete") void undoDelete();
    else if (id === "sidebar") showSidebar(narrow() ? !sidebar : sidebarCollapsed);
    else if (id === "settings") {
      setSettingsSection("general");
      show("settings");
    } else if (id === "go-to-chat") {
      if (index !== undefined && ordered[index]) void loadThread(ordered[index]);
    } else if (id.startsWith("go-")) show(id.slice(3) as View);
    // A cancelled event means a visible picker took it; with Matilda hidden, Settings holds the same choice.
    else if (id === "theme") {
      if (window.dispatchEvent(new CustomEvent(OPEN_CHARACTER_PICKER, { cancelable: true }))) {
        setSettingsSection("general");
        show("settings");
      }
    } else if (id === "back" || id === "forward") goHistory(id === "back" ? -1 : 1);
    else if (id === "shortcuts") {
      shortcutsReturnFocus.current = document.activeElement as HTMLElement | null;
      setShortcutsOpen(true);
    } else if (id === "previous-chat" && ordered.length) void loadThread(ordered[at <= 0 ? 0 : at - 1]!);
    else if (id === "next-chat" && ordered.length)
      void loadThread(ordered[at < 0 ? 0 : Math.min(ordered.length - 1, at + 1)]!);
    else if (id === "rename" && selected) setRenameRequest(true);
    else if (id === "archive") archiveChats(chosenChats());
    else if (id === "pin" && selected) togglePin(selected);
    else if ((id === "chat-to-top" || id === "chat-to-bottom") && selected)
      moveToEdge(selected.id, id === "chat-to-top");
    else if (id === "copy-folder" && (selected?.cwd || cwd)) void navigator.clipboard.writeText(selected?.cwd || cwd);
    else if (id === "new-tab" && desktop) {
      newChatTab();
    } else if (id === "close-tab" && desktop && view === "chat") closeChatTab(activeTabId);
    else if ((id === "next-tab" || id === "previous-tab") && desktop && view === "chat")
      cycleTabs(id === "next-tab" ? 1 : -1);
    else if (id === "full-view" && desktop) {
      if (view !== "chat") show("chat");
      side.toggleFull(view === "chat" ? undefined : true);
    } else if (id === "terminal" && hasTerminal) {
      const away = view !== "chat";
      if (away) show("chat");
      if (!side.toggleTerminal(selected?.cwd || cwd, !away)) focusComposer();
    } else if (id === "files" && desktop) {
      const away = view !== "chat";
      if (away) show("chat");
      if (!side.toggleFiles(!away)) focusComposer();
    }
  };
}
