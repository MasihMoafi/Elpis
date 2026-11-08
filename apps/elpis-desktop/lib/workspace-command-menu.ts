import type { RefObject } from "react";
import type { CommandAction } from "@/components/command-menu";
import { configuredShortcuts } from "@/lib/shortcuts";
import { NAV_PAGES, PAGE_NAMES } from "@/lib/workspace-navigation-pages";
import type { useAppPreferences } from "@/lib/preferences";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useSidebarSelection } from "@/lib/use-sidebar-selection";
import type { useWorkspaceDialogState } from "@/lib/use-workspace-dialog-state";
import type { createWorkspaceVisibility } from "@/lib/workspace-visibility";

type Inputs = {
  preferences: ReturnType<typeof useAppPreferences>;
  session: ReturnType<typeof useConversationSession>;
  selection: ReturnType<typeof useSidebarSelection>;
  dialogs: ReturnType<typeof useWorkspaceDialogState>;
  shortcutAction: RefObject<(id: string, index?: number) => void>;
  pins: string[];
  hiddenPages: string[];
  desktop: boolean;
  hasTerminal: boolean;
  projectChanging: boolean;
  show: ReturnType<typeof createWorkspaceVisibility>["show"];
};

export function createWorkspaceCommandMenu({
  preferences,
  session,
  selection,
  dialogs,
  shortcutAction,
  pins,
  hiddenPages,
  desktop,
  hasTerminal,
  projectChanging,
  show,
}: Inputs) {
  const { selected } = session,
    { marked } = selection;
  const { shortcutsReturnFocus, commandReturnFocus, setShortcutsOpen } = dialogs;
  const shortcuts = configuredShortcuts(preferences);
  const commandActions: CommandAction[] = [
    "new-chat",
    "search",
    "settings",
    "shortcuts",
    "sidebar",
    ...(desktop ? ["files", "full-view"] : []),
    ...(hasTerminal ? ["terminal"] : []),
    ...(selected ? ["rename", "pin"] : []),
    ...(selected || marked.length ? ["archive"] : []),
  ]
    .filter(id => id !== "new-chat" || !projectChanging)
    .map(id => {
      const shortcut = shortcuts.find(item => item.id === id)!;
      return {
        id,
        name:
          id === "pin"
            ? `${pins.includes(selected!.id) ? "Unpin" : "Pin"} chat`
            : id === "archive" && marked.length > 1
              ? `Archive ${marked.length} chats`
              : id === "shortcuts"
                ? "Keyboard shortcuts"
                : shortcut.label,
        keys: shortcut.keys,
        run: () => {
          if (id === "shortcuts") {
            shortcutsReturnFocus.current = commandReturnFocus.current;
            setShortcutsOpen(true);
          } else shortcutAction.current(id);
        },
      };
    });
  commandActions.push({
    id: "improve-elpis",
    name: "Improve Elpis…",
    run: () => window.dispatchEvent(new CustomEvent("elpis:improve")),
  });
  for (const target of ["agentsGuide", ...NAV_PAGES.map(page => page.id)] as const) {
    const name = PAGE_NAMES[target];
    if (!hiddenPages.includes(target) && !(target === "agentsGuide" && hiddenPages.includes("canvas")))
      commandActions.push({ id: target, name, run: () => show(target) });
  }
  return commandActions;
}
