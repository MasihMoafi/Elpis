import type { Dispatch, SetStateAction } from "react";
import type { useSidePanel } from "@/components/side-panel";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { View } from "@/lib/workspace-types";

type Inputs = {
  side: ReturnType<typeof useSidePanel>; pages: ReturnType<typeof useWorkspacePagesState>;
  panelShown: boolean; panelDrawer: boolean; setSidebar: Dispatch<SetStateAction<boolean>>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>; searchInput: () => HTMLInputElement | null;
};

export function createWorkspaceVisibility({ side, pages, panelShown, panelDrawer, setSidebar, setSidebarCollapsed, searchInput }: Inputs) {
  const { view, setView, setSettingsVisited, setSettingsNavigation } = pages;
  /** A window too narrow for chat and panel side by side shows the panel alone; the chat comes back when it is needed. */
  const showChat = () => { if (side.full) side.setChatCollapsed(false); else if (matchMedia("(max-width: 760px)").matches) side.closePanel(); };
  const show = (next: View) => { if (next !== "chat") side.toggleFull(false); if (next === "settings") { setSettingsVisited(true); setSettingsNavigation(value => value + 1); } setView(next); setSidebar(false); };
  /** A narrow window slides the sidebar over the page; a wide one collapses it (the sidebar button and Ctrl+B), as in ChatGPT and Claude. */
  function narrow() { return matchMedia("(max-width: 760px)").matches || (panelShown && panelDrawer); }
  function showSidebar(open: boolean) { if (!narrow()) { setSidebarCollapsed(!open); return; } setSidebar(open); if (open) setSidebarCollapsed(false); }
  const focusSearch = () => { if (view === "settings") show("chat"); setSidebar(true); setSidebarCollapsed(false); requestAnimationFrame(() => { searchInput()?.focus(); searchInput()?.select(); }); };
  return { showChat, show, narrow, showSidebar, focusSearch };
}
