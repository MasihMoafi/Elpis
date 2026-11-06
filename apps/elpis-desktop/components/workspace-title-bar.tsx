import type { Dispatch, RefObject, SetStateAction } from "react";
import { PanelLeft } from "lucide-react";
import { AppMenus } from "@/components/app-menus";
import { AppUpdate } from "@/components/app-update";
import { MatildaCompanion } from "@/components/matilda-companion";
import { NavButtons } from "@/components/nav-buttons";
import { Button } from "@/components/ui/button";
import type { createChatNavigation } from "@/lib/chat-navigation";
import type { useNavHistory } from "@/lib/nav-history";
import type { useAppPreferences } from "@/lib/preferences";
import type { createProjectActions } from "@/lib/project-actions";
import { shortcutTitle } from "@/lib/shortcuts";
import type { View } from "@/lib/workspace-types";

type Props = {
  desktop: boolean; preferences: ReturnType<typeof useAppPreferences>; navHistory: ReturnType<typeof useNavHistory>;
  sidebar: boolean; sidebarCollapsed: boolean; panelShown: boolean; panelDrawer: boolean;
  setError: Dispatch<SetStateAction<string>>; newChat: ReturnType<typeof createChatNavigation>["newChat"];
  goHistory: ReturnType<typeof createChatNavigation>["goHistory"]; addProject: ReturnType<typeof createProjectActions>["addProject"];
  show: (view: View) => void; showSidebar: (open: boolean) => void; narrow: () => boolean; shortcutAction: RefObject<(id: string, index?: number) => void>;
};

export function WorkspaceTitleBar({ desktop, preferences, navHistory, sidebar, sidebarCollapsed, panelShown, panelDrawer, setError, newChat, goHistory, addProject, show, showSidebar, narrow, shortcutAction }: Props) {
  return <>
    {desktop && <div className="title-bar"><NavButtons preferences={preferences} canBack={navHistory.canBack} canForward={navHistory.canForward} onBack={() => goHistory(-1)} onForward={() => goHistory(1)} />{(sidebarCollapsed || !sidebar) && <Button className={sidebarCollapsed || panelShown && panelDrawer ? undefined : "sidebar-open-narrow"} variant="ghost" size="icon-sm" aria-label="Open sidebar" title={shortcutTitle("Open sidebar", "sidebar", preferences)} onClick={() => showSidebar(true)}><PanelLeft size={16} /></Button>}<AppMenus preferences={preferences} onError={setError} onNewChat={newChat} onOpenFolder={() => void addProject()} onSettings={() => show("settings")} onToggleSidebar={() => showSidebar(narrow() ? !sidebar : sidebarCollapsed)} onBack={() => goHistory(-1)} onForward={() => goHistory(1)} canGoBack={navHistory.canBack} canGoForward={navHistory.canForward} onShortcuts={() => shortcutAction.current("shortcuts")} /><div className="title-bar-actions"><MatildaCompanion /><AppUpdate inTitleBar /></div></div>}
    {!desktop && <div className="title-bar"><div className="title-bar-actions"><MatildaCompanion /></div></div>}
  </>;
}
