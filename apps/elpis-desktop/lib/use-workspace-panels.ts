import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useBrowser } from "@/components/browser-panel";
import { useSidePanel } from "@/components/side-panel";
import type { TerminalLaunch } from "@/components/terminal-view";
import { useBrowserPins } from "@/lib/browser-pins";
import { onRequest as onFileRequest } from "@/lib/files-pane";
import { createWorkspaceVisibility } from "@/lib/workspace-visibility";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { Thread } from "@/lib/api";

type Inputs = {
  selected: Thread | null; cwd: string; activeTabId: string; desktop: boolean;
  pages: ReturnType<typeof useWorkspacePagesState>; setError: Dispatch<SetStateAction<string>>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>; searchInput: () => HTMLInputElement | null;
};

export function useWorkspacePanels({ selected, cwd, activeTabId, desktop, pages, setError, setSidebarCollapsed, searchInput }: Inputs) {
  const { view, setView } = pages;
  const browser = useBrowser(selected?.id ?? `draft:${activeTabId}`);
  const side = useSidePanel(browser, selected?.cwd || cwd);
  const browserPins = useBrowserPins(setError);
  useEffect(() => onFileRequest(() => { if (view !== "chat") setView("chat"); }), [view]);
  // The side panel (components/side-panel.tsx): shells and browser pages as tabs, beside the chat.
  const [tuiLaunch, setTuiLaunch] = useState<TerminalLaunch | null>(null);
  const panelShown = desktop && side.open && view === "chat";
  /** Full view: the panel fills the work area and the chat floats over it, as a card or folded to a pill. */
  const fullView = panelShown && side.full;
  const [pendingInputOpen, setPendingInputOpen] = useState(false);
  const pendingInputButton = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  const visibility = createWorkspaceVisibility({ side, pages, panelShown, panelDrawer, setSidebar, setSidebarCollapsed, searchInput });
  useEffect(() => { if (selected?.id) visibility.showChat(); }, [selected?.id]);
  useEffect(() => {
    const media = matchMedia("(max-width: 1000px)");
    const update = () => setPanelDrawer(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return { browser, side, browserPins, tuiLaunch, setTuiLaunch, panelShown, fullView, pendingInputOpen, setPendingInputOpen,
    pendingInputButton, sidebar, setSidebar, panelDrawer, ...visibility };
}
