"use client";

import "@/components/settings/settings.css";
import { useEffect, useState } from "react";
import { AppearanceSettings, type ThemeChoice } from "@/components/appearance-settings";
import { ArchivedView } from "@/components/archived-view";
import { McpSettings } from "@/components/mcp-settings";
import { ProvidersSettings } from "@/components/providers-settings";
import { ConfigurationSettings } from "@/components/settings/configuration-settings";
import { GeneralSettings } from "@/components/settings/general-settings";
import { AboutSettings } from "@/components/settings/about-settings";
import { GitSettings, WorktreeSettings } from "@/components/settings/git-settings";
import { HooksSettings } from "@/components/settings/hooks-settings";
import { ImportSettings } from "@/components/settings/import-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { PersonalizationSettings } from "@/components/settings/personalization-settings";
import { ShortcutSettings } from "@/components/settings/shortcut-settings";
import { UsageSettings } from "@/components/settings/usage-settings";
import { VoiceSettings } from "@/components/settings/voice-settings";
import { ArrowLeft } from "lucide-react";
import { ModelsIcon, ArchiveIcon, BellIcon, BranchIcon, ChatIcon, ContextIcon, FileEditIcon, FolderIcon, KeyboardIcon, MicIcon, PersonIcon, SettingsIcon, ThemeIcon, ToolIcon, WorkflowsIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { ViewBoundary } from "@/components/view-boundary";
import { SettingRow, SettingsGroup, SettingsHeader, SettingsScope } from "@/components/settings/rows";
import { SettingsLoader } from "@/components/settings/config-choice";
import { DefaultModelSettings } from "@/components/settings/maintenance";
import { SECTIONS, type ConfigSectionId } from "@/lib/config-sections";
import type { Thread } from "@/lib/api";
import { reloadSettings, settingsLoaded } from "@/lib/settings-store";

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
  { id: "import", label: "Import chats", group: "app", scope: "this device", Icon: ChatIcon, words: "import claude code codex cloudroom bring chats history sessions" },
  { id: "archived", label: "Archived chats", group: "app", scope: "this device", Icon: ArchiveIcon, words: "archive restore delete" },
  { id: "about", label: "About", group: "app", scope: "this device", Icon: ContextIcon, words: "version commit update restart releases notes community" },
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
  onUnarchived: (thread: Thread) => void; onImported?: () => void; onDeleteThread: (thread: Thread) => Promise<void>; onBack?: () => void;
  onCustomize?: () => void;
  onChatContext?: () => void;
  onChatPermissions?: () => void; onChatModel?: () => void; modelChangeReason?: string; currentModel?: string | null; currentPermission?: string | null;
};

export function SettingsView({ initialTab = "providers", navigationKey = 0, accountRefresh, onProvidersChanged, theme, onTheme, onUnarchived, onImported, onDeleteThread, onBack, onCustomize, onChatContext, onChatPermissions, onChatModel, modelChangeReason, currentModel, currentPermission, threadId }: Props) {
  // One standard order, the same for everyone (Masih, 23 Oct: the section titles "wouldn't make sense if I could just change
  // the order"; "Don't make users change them"). Chats keep their drag order; Settings has none.
  const groups = SECTIONS, pages = TABS;
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
  const sectionList = (sections: readonly typeof SECTIONS[number][]) => <SettingsGroup>
    {sections.map(section => <SettingRow key={section.id} title={<h3 data-config-section={section.id}>{section.label}</h3>} description={section.description}>
      <Button variant="outline" onClick={() => selectTab(section.id)}>Open {section.label}</Button>
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
      case "about": return <AboutSettings />;
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
      case "import": return <ImportSettings onImported={onImported} />;
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
          return <div key={group.id} className="settings-nav-group"><Button data-slot="section-link" type="button" variant="ghost" size="sm" className="section-label settings-section-link" aria-current={tab === group.id ? "page" : undefined} onClick={() => selectTab(group.id)}>{group.label}</Button>
            {items.map(item => <Button key={item.id} data-slot="nav-row" variant="ghost" role="tab" type="button" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)}><item.Icon size={15} aria-hidden="true" />{item.label}</Button>)}
          </div>; })}
        {!visibleGroups.length && <p className="settings-nav-empty">No setting matches.</p>}
      </div>
    </nav>
    <div className="settings-page">{tab === "sections" && <><SettingsHeader title="Settings" description="Choose a section to set up Elpis." />{sectionList(groups)}</>}{sectionPage}
      {modelOverviewVisited && <div hidden={tab !== "models"}><SettingsScope value="new chats"><SettingsLoader>{settings => <DefaultModelSettings value={settings} />}</SettingsLoader></SettingsScope></div>}
      {visited.map(section => <div key={section} role="tabpanel" id={`settings-panel-${section}`} aria-labelledby={`settings-tab-${section}`} hidden={tab !== section}><ViewBoundary resetKey={navigationKey}><SettingsScope value={TABS.find(item => item.id === section)!.scope}>
        {page(section)}
      </SettingsScope></ViewBoundary></div>)}
    </div>
  </div>;
}
