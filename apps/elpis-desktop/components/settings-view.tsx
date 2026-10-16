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
import { SettingsHeader } from "@/components/settings/rows";
import { ShortcutSettings } from "@/components/settings/shortcut-settings";
import { UsageSettings } from "@/components/settings/usage-settings";
import { VoiceSettings } from "@/components/settings/voice-settings";
import { ArrowLeft } from "lucide-react";
import { AgentsIcon, ArchiveIcon, BellIcon, BranchIcon, ContextIcon, FileEditIcon, FolderIcon, KeyboardIcon, MicIcon, PersonIcon, SearchIcon, SettingsIcon, ThemeIcon, ToolIcon, WorkflowsIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageBoundary } from "@/components/settings/page-boundary";
import type { Thread } from "@/lib/api";
import { reloadSettings, settingsLoaded } from "@/lib/settings-store";

/** The ChatGPT app's settings sidebar: grouped sections with icons, and words each section answers to in search. */
const TABS = [
  { id: "general", label: "General", group: "Personal", Icon: SettingsIcon, words: "default folder close window speed send shortcut follow-up queue steer context" },
  { id: "notifications", label: "Notifications", group: "Personal", Icon: BellIcon, words: "alerts sound turn approval question" },
  { id: "appearance", label: "Appearance", group: "Personal", Icon: ThemeIcon, words: "theme dark light system colour color" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "Personal", Icon: KeyboardIcon, words: "keys hotkeys" },
  { id: "voice", label: "Voice", group: "Personal", Icon: MicIcon, words: "dictation transcription microphone whisper" },
  { id: "personalization", label: "Personalization", group: "Personal", Icon: PersonIcon, words: "instructions memories memory" },
  { id: "usage", label: "Usage & limits", group: "Personal", Icon: ContextIcon, words: "limits plan quota context window" },
  { id: "archived", label: "Archived chats", group: "Personal", Icon: ArchiveIcon, words: "archive restore delete" },
  { id: "providers", label: "Models & accounts", group: "Integrations", Icon: AgentsIcon, words: "providers api key sign in chatgpt anthropic openrouter gemini" },
  { id: "mcp", label: "MCP servers", group: "Integrations", Icon: ToolIcon, words: "tools servers rag" },
  { id: "git", label: "Git", group: "Coding", Icon: BranchIcon, words: "project root markers" },
  { id: "worktrees", label: "Worktrees", group: "Coding", Icon: FolderIcon, words: "worktree root" },
  { id: "hooks", label: "Hooks", group: "Coding", Icon: WorkflowsIcon, words: "hook trust" },
  { id: "configuration", label: "Configuration", group: "Coding", Icon: FileEditIcon, words: "approval sandbox web search output reasoning background model smart prune pruning config file" },
] as const;
const GROUPS = ["Personal", "Integrations", "Coding"] as const;
export type Tab = (typeof TABS)[number]["id"];
// Pages that edit the shared Elpis config snapshot refresh it when opened, so their saves use the current version.
const CONFIG_PAGES: Tab[] = ["general", "personalization", "git", "worktrees", "configuration"];
// "elpis" was the former page with the selected chat's context, now under Usage & limits.
const resolve = (tab: Tab | "elpis"): Tab => tab === "elpis" ? "usage" : tab;

/** Settings sections side by side, as in ChatGPT: one nav, one page at a time. Visited pages stay mounted to keep unsaved edits. */
type Props = {
  initialTab?: Tab | "elpis";
  navigationKey?: number; active?: boolean;
  threadId?: string; accountRefresh: number; onProvidersChanged?: () => Promise<void> | void;
  theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void;
  onUnarchived: (thread: Thread) => void; onDeleteThread: (thread: Thread) => Promise<void>; onBack?: () => void;
};

export function SettingsView({ initialTab = "providers", navigationKey = 0, active = true, threadId, accountRefresh, onProvidersChanged, theme, onTheme, onUnarchived, onDeleteThread, onBack }: Props) {
  const [query, setQuery] = useState("");
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const shown = TABS.filter(item => terms.every(term => `${item.label} ${item.words}`.toLowerCase().includes(term)));
  const first = resolve(initialTab);
  const [tab, setTab] = useState<Tab>(first);
  const [visited, setVisited] = useState<Tab[]>([first]);
  const selectTab = (next: Tab) => {
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]); setTab(next);
    if (settingsLoaded() && CONFIG_PAGES.includes(next)) reloadSettings().catch(() => {});
  };
  useEffect(() => { selectTab(resolve(initialTab)); }, [initialTab, navigationKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = (section: Tab) => {
    switch (section) {
      case "general": return <GeneralSettings />;
      case "notifications": return <NotificationSettings />;
      case "appearance": return <AppearanceSettings theme={theme} onTheme={onTheme} />;
      case "shortcuts": return <ShortcutSettings />;
      case "voice": return <VoiceSettings onOpenMcp={() => selectTab("mcp")} />;
      case "personalization": return <PersonalizationSettings />;
      case "providers": return <><SettingsHeader title="Models & accounts" /><ProvidersSettings refreshKey={accountRefresh} onChanged={onProvidersChanged} /></>;
      case "mcp": return <><SettingsHeader title="MCP servers" /><McpSettings onOpenVoice={() => selectTab("voice")} /></>;
      case "usage": return <UsageSettings refreshKey={accountRefresh} threadId={threadId} active={active && tab === "usage"} />;
      case "git": return <GitSettings />;
      case "worktrees": return <WorktreeSettings />;
      case "hooks": return <HooksSettings />;
      case "configuration": return <ConfigurationSettings />;
      case "archived": return <><SettingsHeader title="Archived chats" /><ArchivedView onUnarchived={onUnarchived} onDelete={onDeleteThread} /></>;
    }
  };
  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings navigation">
      {onBack && <button type="button" className="settings-back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />Back to app</button>}
      <h1 className="settings-title">Settings</h1>
      <label className="settings-search"><SearchIcon size={14} aria-hidden="true" /><Input aria-label="Search settings" placeholder="Search" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label>
      <div role="tablist" aria-label="Settings sections" aria-orientation="vertical">
        {GROUPS.map(group => { const items = shown.filter(item => item.group === group);
          return items.length > 0 && <div key={group} className="settings-nav-group"><div className="section-label">{group}</div>
            {items.map(item => <Button key={item.id} variant="ghost" role="tab" type="button" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)}><item.Icon size={15} aria-hidden="true" />{item.label}</Button>)}
          </div>; })}
        {!shown.length && <p className="settings-nav-empty">No setting matches.</p>}
      </div>
    </nav>
    <div className="settings-page">{visited.map(section => <div key={section} role="tabpanel" id={`settings-panel-${section}`} aria-labelledby={`settings-tab-${section}`} hidden={tab !== section}><PageBoundary>
      {page(section)}
    </PageBoundary></div>)}</div>
  </div>;
}
