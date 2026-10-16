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
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/api";
import { reloadSettings, settingsLoaded } from "@/lib/settings-store";

const TABS = [
  { id: "general", label: "General" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "voice", label: "Voice" },
  { id: "personalization", label: "Personalization" },
  { id: "providers", label: "Models & accounts" },
  { id: "mcp", label: "MCP servers" },
  { id: "usage", label: "Usage & limits" },
  { id: "git", label: "Git" },
  { id: "worktrees", label: "Worktrees" },
  { id: "hooks", label: "Hooks" },
  { id: "configuration", label: "Configuration" },
  { id: "archived", label: "Archived chats" },
] as const;
type Tab = (typeof TABS)[number]["id"];
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
  onUnarchived: (thread: Thread) => void; onDeleteThread: (thread: Thread) => Promise<void>;
};

export function SettingsView({ initialTab = "providers", navigationKey = 0, active = true, threadId, accountRefresh, onProvidersChanged, theme, onTheme, onUnarchived, onDeleteThread }: Props) {
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
    <nav className="settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
      {TABS.map(item => <Button key={item.id} variant="ghost" role="tab" type="button" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)}>{item.label}</Button>)}
    </nav>
    <div className="settings-page">{visited.map(section => <div key={section} role="tabpanel" id={`settings-panel-${section}`} aria-labelledby={`settings-tab-${section}`} hidden={tab !== section}>
      {page(section)}
    </div>)}</div>
  </div>;
}
