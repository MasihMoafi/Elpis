/** Owns the workspace's settings, browser, sidebar, and auxiliary panel visibility. */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useBrowser } from "@/components/browser-panel";
import { useSidePanel } from "@/components/side-panel";
import type { SettingsDestination } from "@/components/settings-view";
import type { TerminalLaunch } from "@/components/terminal-view";
import { onRequest as onFileRequest } from "@/lib/files-pane";
import type { Thread } from "@/lib/api";
import type { View } from "@/hooks/use-chat-navigation";

type Props = { selected: Thread | null; activeTabId: string; view: View; setView: Dispatch<SetStateAction<View>> };

export function useWorkspacePanels({ selected, activeTabId, view, setView }: Props) {
  const [settingsSection, setSettingsSection] = useState<SettingsDestination>("general");
  const [desktop, setDesktop] = useState(false);
  const [windowAvailable, setWindowAvailable] = useState(false);
  const sessionWindowApi = () => window.elpisDesktop?.openSessionWindow ?? (window.parent !== window && new URLSearchParams(location.search).get("pane") === "1" ? window.parent.elpisDesktop?.openSessionWindow : undefined);
  useEffect(() => { setWindowAvailable(!!sessionWindowApi()); }, []);
  const browser = useBrowser(selected?.id ?? `draft:${activeTabId}`);
  const side = useSidePanel(browser);
  useEffect(() => onFileRequest(() => { if (view !== "chat") setView("chat"); }), [view]);
  useEffect(() => { setDesktop(!!window.elpisDesktop?.browser); }, []);
  // The side panel (components/side-panel.tsx): shells and browser pages as tabs, beside the chat.
  const [hasTerminal, setHasTerminal] = useState(false);
  const [tuiLaunch, setTuiLaunch] = useState<TerminalLaunch | null>(null);
  useEffect(() => { setHasTerminal(!!window.elpisDesktop?.terminal); }, []);
  const panelShown = desktop && side.open && view === "chat";
  /** Full view (the side panel's): the panel fills the work area and the chat floats over it, as a card or folded to a pill. */
  const fullView = panelShown && side.full;
  /** A window too narrow for chat and panel side by side shows the panel alone; the chat comes back when it is needed. */
  const showChat = () => { if (side.full) side.setChatCollapsed(false); else if (matchMedia("(max-width: 760px)").matches) side.closePanel(); };
  useEffect(() => { if (selected?.id) showChat(); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pendingInputOpen, setPendingInputOpen] = useState(false);
  const pendingInputButton = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 1000px)");
    const update = () => setPanelDrawer(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [agentsPanel, setAgentsPanel] = useState(true);
  return { settingsSection, setSettingsSection, desktop, windowAvailable, sessionWindowApi,
    browser, side, hasTerminal, tuiLaunch, setTuiLaunch, panelShown, fullView, showChat,
    pendingInputOpen, setPendingInputOpen, pendingInputButton, sidebar, setSidebar, panelDrawer,
    agentsPanel, setAgentsPanel };
}
