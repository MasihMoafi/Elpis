import type React from "react";
import { PanelLeft } from "lucide-react";
import { BrandWordmark } from "@/components/brand-wordmark";
import { NewChatIcon, SettingsIcon, ThemeIcon } from "@/components/elpis-icons";
import { ReorderItem, type useReorder } from "@/components/reorder";
import { AccountRow } from "@/components/account-row";
import { UsagePanel } from "@/components/provider-usage";
import { ResizeEdge } from "@/components/resize-edge";
import type { SettingsDestination } from "@/components/settings-view";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import type { Thread } from "@/lib/api";
import type { createChatNavigation } from "@/lib/chat-navigation";
import type { useAppPreferences } from "@/lib/preferences";
import { shortcutHint, shortcutTitle } from "@/lib/shortcuts";
import { SIDEBAR, type useAppearance } from "@/lib/use-appearance";
import type { useLoveActivity } from "@/lib/use-love-activity";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useSidebarSearch } from "@/lib/use-sidebar-search";
import type { useSidebarKeys } from "@/lib/use-workspace-navigation";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import { shownPageShortcut, type NAV_PAGES } from "@/lib/workspace-navigation-pages";
import type { View } from "@/lib/workspace-types";

type Props = {
  sidebar: boolean; sidebarKeys: ReturnType<typeof useSidebarKeys>; appearance: ReturnType<typeof useAppearance>;
  pages: ReturnType<typeof useWorkspacePagesState>; preferences: ReturnType<typeof useAppPreferences>;
  projectState: ReturnType<typeof useProjectState>; runtime: ReturnType<typeof useRuntimeState>; loveActivity: ReturnType<typeof useLoveActivity>;
  search: ReturnType<typeof useSidebarSearch>; searchInput: React.RefObject<HTMLInputElement | null>; selected: Thread | null;
  arrangedPages: (typeof NAV_PAGES)[number][]; pageReorder: ReturnType<typeof useReorder>;
  show: (view: View) => void; showSidebar: (open: boolean) => void; focusComposer: () => void;
  openSettings: (tab: SettingsDestination) => void; newChat: ReturnType<typeof createChatNavigation>["newChat"]; children: React.ReactNode;
};

export function WorkspaceSidebar({ sidebar, sidebarKeys, appearance, pages, preferences, projectState, runtime, loveActivity, search, searchInput, selected, arrangedPages, pageReorder, show, showSidebar, focusComposer, openSettings, newChat, children }: Props) {
  const { dark, setTheme, sidebarWidth, resizeSidebar } = appearance;
  const { view } = pages;
  const { projectChanging } = projectState;
  const { accountRefresh, connected } = runtime;
  return (
    <aside className={`sidebar${sidebar ? " open" : ""}`} aria-label="Workspace navigation" onKeyDown={sidebarKeys}>
      <div className="brand"><Button type="button" variant="ghost" size="logo" className="brand-home" aria-label="Elpis home" onClick={() => show("chat")}><BrandWordmark dark={dark} width={73} height={36} /></Button><Button className="sidebar-toggle" variant="ghost" size="icon-sm" aria-label="Close sidebar" title={shortcutTitle("Close sidebar", "sidebar", preferences)} onClick={() => showSidebar(false)}><PanelLeft size={16} /></Button></div>
      <nav className="nav-list" aria-label="Workspace">
        <Button data-slot="nav-row" className="new-chat" variant="ghost" aria-label="New chat" data-shortcut={shortcutHint("new-chat", preferences)} aria-current={view === "chat" && !selected ? "page" : undefined} disabled={projectChanging} onClick={newChat}><NewChatIcon size={16} />New chat</Button>
        {arrangedPages.map(page => <ReorderItem key={page.id} reorder={pageReorder} itemId={page.id} render={<Button data-slot="nav-row" variant="ghost" data-nav-page={page.id} className={page.id === "loveSpot" ? "accent-scope" : undefined} aria-label={page.name} data-shortcut={shortcutHint(shownPageShortcut(page.id) ?? "", preferences)} aria-current={view === page.id || (page.id === "mother" && view === "chat" && selected?.motherAgent) ? "page" : undefined} onClick={() => show(page.id)} title={`${page.name} (drag, or Alt+Up/Down, to reorder)`}>
          <page.Icon size={16} />{page.name}{page.id === "loveSpot" && loveActivity.unread > 0 && <span className="love-unread badge badge-sm" role="status" aria-label={`${loveActivity.unread} Love Spot agents replied`}>{loveActivity.unread}</span>}</Button>} />)}
      </nav>
      <SearchField ref={searchInput} hint="Ctrl Shift K" aria-label="Search conversations" placeholder="Search chats" maxLength={200} value={search.search} onChange={e => search.setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); search.setSearch(""); focusComposer(); } }} />
      {children}
      <UsagePanel refreshKey={accountRefresh} onOpen={() => openSettings("usage")} />
      <div className="sidebar-footer"><AccountRow refreshKey={accountRefresh} /></div>
      <div className="sidebar-status">
        <span className="status-line"><i className={`status-dot${connected ? " connected" : ""}`} />{connected ? "Local workspace" : "Disconnected"}</span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon-xs" aria-label={dark ? "Use light theme" : "Use dark theme"} title={dark ? "Use light theme" : "Use dark theme"} onClick={() => setTheme(dark ? "light" : "dark")}><ThemeIcon size={14} /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => openSettings("general")}><SettingsIcon size={14} /></Button>
        </span>
      </div>
      <ResizeEdge label="Resize sidebar" width={sidebarWidth} min={SIDEBAR.min} max={SIDEBAR.max} initial={SIDEBAR.initial} grows="right" onResize={resizeSidebar} onClose={() => showSidebar(false)} />
    </aside>
  );
}
