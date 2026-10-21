"use client";

import "@/components/settings/settings.css";
import { useEffect, useState } from "react";
import { AppearanceSettings, type ThemeChoice } from "@/components/appearance-settings";
import { ArchivedView } from "@/components/archived-view";
import { McpSettings } from "@/components/mcp-settings";
import { ProvidersSettings } from "@/components/providers-settings";
import { ConfigurationSettings } from "@/components/settings/configuration-settings";
import { GeneralSettings } from "@/components/settings/general-settings";
import { GitSettings, WorktreeSettings } from "@/components/settings/git-settings";
import { HooksSettings } from "@/components/settings/hooks-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { PersonalizationSettings } from "@/components/settings/personalization-settings";
import { ShortcutSettings } from "@/components/settings/shortcut-settings";
import { UsageSettings } from "@/components/settings/usage-settings";
import { VoiceSettings } from "@/components/settings/voice-settings";
import { ArrowLeft } from "lucide-react";
import { ModelsIcon, ArchiveIcon, BellIcon, BranchIcon, ContextIcon, FileEditIcon, FolderIcon, KeyboardIcon, MicIcon, PersonIcon, SettingsIcon, ThemeIcon, ToolIcon, WorkflowsIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { ReorderItem, useReorder } from "@/components/reorder";
import { SearchField } from "@/components/ui/search-field";
import { ViewBoundary } from "@/components/view-boundary";
import { SettingRow, SettingsGroup, SettingsHeader, SettingsNotice, SettingsScope } from "@/components/settings/rows";
import { SettingsLoader } from "@/components/settings/config-choice";
import { DefaultModelSettings } from "@/components/settings/maintenance";
import { SECTIONS, type ConfigSectionId } from "@/lib/config-sections";
import type { Thread } from "@/lib/api";
import { reloadSettings, settingsLoaded } from "@/lib/settings-store";
import { arrange, move } from "@/lib/nav-order";
import { savePreferences, usePreferences, type Preferences } from "@/lib/preferences";

/** Existing control pages stay mounted so each control has one owner and unsaved drafts survive navigation. */
const TABS = [
  { id: "providers", label: "Models & accounts", group: "models", scope: "this device", Icon: ModelsIcon, words: "providers api key sign in chatgpt anthropic openrouter gemini" },
  { id: "configuration", label: "Configuration", group: "permissions", scope: "new chats", Icon: FileEditIcon, words: "approval sandbox web search output reasoning background model smart prune pruning config file" },
  { id: "personalization", label: "Personalization", group: "context", scope: "new chats", Icon: PersonIcon, words: "instructions memories memory" },
  { id: "mcp", label: "MCP servers", group: "connections", scope: "new chats", Icon: ToolIcon, words: "tools servers rag" },
  { id: "voice", label: "Voice", group: "connections", scope: "this device", Icon: MicIcon, words: "dictation transcription microphone whisper" },
  { id: "git", label: "Git", group: "connections", scope: "new chats", Icon: BranchIcon, words: "project root markers" },
  { id: "worktrees", label: "Worktrees", group: "connections", scope: "new chats", Icon: FolderIcon, words: "worktree root" },
  { id: "hooks", label: "Hooks", group: "connections", scope: "new chats", Icon: WorkflowsIcon, words: "hook trust" },
  { id: "general", label: "General", group: "app", scope: "this device", Icon: SettingsIcon, words: "default folder close window speed send shortcut follow-up queue steer context system tray quick entry global hotkey" },
  { id: "notifications", label: "Notifications", group: "app", scope: "this device", Icon: BellIcon, words: "alerts sound turn approval question" },
  { id: "appearance", label: "Appearance", group: "app", scope: "this device", Icon: ThemeIcon, words: "theme dark light system colour color" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "app", scope: "this device", Icon: KeyboardIcon, words: "keys hotkeys" },
  { id: "usage", label: "Usage & limits", group: "app", scope: "this device", Icon: ContextIcon, words: "limits plan quota" },
  { id: "archived", label: "Archived chats", group: "app", scope: "this device", Icon: ArchiveIcon, words: "archive restore delete" },
] as const;
export type Tab = (typeof TABS)[number]["id"];
export type SettingsDestination = Tab | ConfigSectionId | "sections";
// Pages that edit the shared Elpis config snapshot refresh it when opened, so their saves use the current version.
const CONFIG_PAGES: Tab[] = ["general", "personalization", "git", "worktrees", "configuration"];

/** Settings sections side by side, as in ChatGPT: one nav, one page at a time. Visited pages stay mounted to keep unsaved edits. */
type Props = {
  initialTab?: SettingsDestination;
  navigationKey?: number;
  /** Unused since Usage & limits no longer shows the selected chat; app/page.tsx still passes them. */
  active?: boolean; threadId?: string;
  accountRefresh: number; onProvidersChanged?: () => Promise<void> | void;
  theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void;
  onUnarchived: (thread: Thread) => void; onDeleteThread: (thread: Thread) => Promise<void>; onBack?: () => void;
  onCustomize?: () => void;
  onChatContext?: () => void;
  onChatPermissions?: () => void; onChatModel?: () => void; modelChangeReason?: string; currentModel?: string | null; currentPermission?: string | null;
};

export function SettingsView({ initialTab = "providers", navigationKey = 0, accountRefresh, onProvidersChanged, theme, onTheme, onUnarchived, onDeleteThread, onBack, onCustomize, onChatContext, onChatPermissions, onChatModel, modelChangeReason, currentModel, currentPermission, threadId }: Props) {
  const preferences = usePreferences();
  const [orderError, setOrderError] = useState("");
  const groups = arrange(SECTIONS, preferences.settingsSectionOrder.split(","));
  let savedGroups: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(preferences.settingsPageGroups);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) savedGroups = parsed as Record<string, unknown>;
  } catch { /* A damaged layout keeps the default memberships. */ }
  const pages = arrange(TABS, preferences.settingsPageOrder.split(",")).map(page => ({ ...page,
    group: groups.find(group => group.id === savedGroups[page.id])?.id ?? page.group,
  }));
  const reorder = (patch: Partial<Preferences>) => {
    try { savePreferences(patch); setOrderError(""); }
    catch (cause) { setOrderError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const sectionOrder: string[] = groups.map(item => item.id);
  const pageGroup = (id: string) => pages.find(page => page.id === id)?.group;
  const pageOrder = groups.flatMap(group => pages.filter(page => page.group === group.id).map(page => page.id));
  const keyboardPageOrder = groups.flatMap(group => {
    const ids = pages.filter(page => page.group === group.id).map(page => page.id);
    return ids.length ? ids : [group.id];
  });
  const settingsReorder = useReorder({ dragType: "text/x-elpis-settings",
    order: id => sectionOrder.includes(id) ? sectionOrder : keyboardPageOrder,
    canDrop: (id, target) => sectionOrder.includes(id) ? sectionOrder.includes(target) : !!pageGroup(id) && (sectionOrder.includes(target) || !!pageGroup(target)),
    dropInto: (id, target) => !!pageGroup(id) && sectionOrder.includes(target),
    onMove: (id, place) => {
      if (sectionOrder.includes(id)) { reorder({ settingsSectionOrder: move(sectionOrder, id, place).join(",") }); return; }
      const destination = place.into ? place.target : pageGroup(place.target);
      if (!destination) return;
      // Save position and membership in one preference transaction; a failed save changes neither.
      const memberships = Object.fromEntries(pages.map(page => [page.id, page.id === id ? destination : page.group]));
      const ids = place.into ? [...pageOrder.filter(page => page !== id), id] : move(pageOrder, id, place);
      reorder({ settingsPageOrder: ids.join(","), settingsPageGroups: JSON.stringify(memberships) });
    } });
  const [query, setQuery] = useState("");
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const shown = pages.filter(item => terms.every(term => `${item.label} ${item.words}`.toLowerCase().includes(term)));
  const visibleGroups = groups.filter(group => !terms.length || terms.every(term => `${group.label} ${group.description}`.toLowerCase().includes(term)) || shown.some(item => item.group === group.id));
  const [tab, setTab] = useState<SettingsDestination>(initialTab);
  const [modelOverviewVisited, setModelOverviewVisited] = useState(initialTab === "models");
  const [visited, setVisited] = useState<Tab[]>(TABS.some(item => item.id === initialTab) ? [initialTab as Tab] : []);
  const selectTab = (next: SettingsDestination) => {
    if (next === "models") setModelOverviewVisited(true);
    const page = TABS.find(page => page.id === next);
    if (page) setVisited(previous => previous.includes(page.id) ? previous : [...previous, page.id]);
    setTab(next);
    if (settingsLoaded() && (!page || CONFIG_PAGES.includes(page.id))) reloadSettings().catch(() => {});
  };
  useEffect(() => { setQuery(""); selectTab(initialTab); }, [initialTab, navigationKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedSection = SECTIONS.find(section => section.id === tab);
  const sectionList = (sections: typeof SECTIONS[number][]) => <SettingsGroup>
    {sections.map(section => <SettingRow key={section.id} title={<h3 data-config-section={section.id}>{section.label}</h3>} description={section.description}>
      <ReorderItem reorder={settingsReorder} itemId={section.id} render={<Button variant="outline" title={`${section.label} (drag, or Alt+Up/Down, to reorder)`} onClick={() => selectTab(section.id)}>Open {section.label}</Button>} />
    </SettingRow>)}
  </SettingsGroup>;
  const sectionPage = selectedSection && <>
    <SettingsHeader title={selectedSection.label} description={selectedSection.description} />
    <SettingsGroup title="Settings">
      {selectedSection.pages.map(link => { const item = TABS.find(page => page.id === link.tab)!; return <SettingRow key={link.tab} title={link.title} description={`Open ${item.label} settings.`} scope={link.scope}>
        <Button variant="outline" onClick={() => selectTab(item.id)}>Open {item.label}</Button>
      </SettingRow>; })}
      {selectedSection.id === "connections" && onCustomize && <SettingRow title="Plugins & skills" description="Open the existing plugins and skills controls." scope="new chats"><Button variant="outline" onClick={onCustomize}>Open</Button></SettingRow>}
      {selectedSection.id === "context" && threadId && <SettingRow title="Context Ledger" description="Choose what this chat admits into context. Saved defaults do not change its admission choices." scope="this chat"><Button variant="outline" onClick={onChatContext}>Open Context Ledger</Button></SettingRow>}
      {selectedSection.id === "models" && threadId && <SettingRow title="Current chat model" description={modelChangeReason ?? currentModel ?? "Not reported"} scope="this chat"><Button variant="outline" disabled={!!modelChangeReason} onClick={onChatModel}>Change this chat model</Button></SettingRow>}
      {selectedSection.id === "permissions" && threadId && <SettingRow title="Current permissions" description={currentPermission ?? "Not reported"} scope="this chat"><Button variant="outline" onClick={onChatPermissions}>Change this chat permissions</Button></SettingRow>}
    </SettingsGroup>
  </>;
  const page = (section: Tab) => {
    switch (section) {
      case "general": return <GeneralSettings />;
      case "notifications": return <NotificationSettings />;
      case "appearance": return <AppearanceSettings theme={theme} onTheme={onTheme} />;
      case "shortcuts": return <ShortcutSettings />;
      case "voice": return <VoiceSettings onOpenMcp={() => selectTab("mcp")} />;
      case "personalization": return <PersonalizationSettings />;
      case "providers": return <ProvidersSettings refreshKey={accountRefresh} onChanged={onProvidersChanged} />;
      case "mcp": return <McpSettings onOpenVoice={() => selectTab("voice")} />;
      case "usage": return <UsageSettings refreshKey={accountRefresh} />;
      case "git": return <GitSettings />;
      case "worktrees": return <WorktreeSettings />;
      case "hooks": return <HooksSettings />;
      case "configuration": return <ConfigurationSettings />;
      case "archived": return <ArchivedView onUnarchived={onUnarchived} onDelete={onDeleteThread} />;
    }
  };
  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings navigation">
      {onBack && <button data-slot="nav-row" type="button" className="back-link" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />Back to app</button>}
      <h1 className="settings-title">Settings</h1>
      <SearchField aria-label="Search settings" placeholder="Search" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} />
      <div role="tablist" aria-label="Settings sections" aria-orientation="vertical">
        {visibleGroups.map(group => { const items = shown.filter(item => item.group === group.id);
          return <div key={group.id} className="settings-nav-group"><ReorderItem reorder={settingsReorder} itemId={group.id} render={<Button data-slot="section-link" type="button" variant="ghost" size="sm" className="section-label settings-section-link" aria-current={tab === group.id ? "page" : undefined} title={`${group.label} (drag, or Alt+Up/Down, to reorder)`} onClick={() => selectTab(group.id)}>{group.label}</Button>} />
            {items.map(item => <ReorderItem key={item.id} reorder={settingsReorder} itemId={item.id} render={<Button data-slot="nav-row" variant="ghost" role="tab" type="button" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} className={tab === item.id ? "active" : ""} title={`${item.label} (drag, or Alt+Up/Down, to reorder)`} onClick={() => selectTab(item.id)}><item.Icon size={15} aria-hidden="true" />{item.label}</Button>} />)}
          </div>; })}
        {!visibleGroups.length && <p className="settings-nav-empty">No setting matches.</p>}
      </div>
    </nav>
    <div className="settings-page">{orderError && <SettingsNotice tone="alert">Could not save Settings order: {orderError}</SettingsNotice>}{tab === "sections" && <><SettingsHeader title="Settings" description="Choose a section to set up Elpis." />{sectionList(groups)}</>}{sectionPage}
      {modelOverviewVisited && <div hidden={tab !== "models"}><SettingsScope value="new chats"><SettingsLoader>{settings => <DefaultModelSettings value={settings} />}</SettingsLoader></SettingsScope></div>}
      {visited.map(section => <div key={section} role="tabpanel" id={`settings-panel-${section}`} aria-labelledby={`settings-tab-${section}`} hidden={tab !== section}><ViewBoundary resetKey={navigationKey}><SettingsScope value={TABS.find(item => item.id === section)!.scope}>
        {page(section)}
      </SettingsScope></ViewBoundary></div>)}
    </div>
  </div>;
}
