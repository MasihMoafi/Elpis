"use client";

import { useEffect, useState } from "react";
import { AppearanceSettings, type ThemeChoice } from "@/components/appearance-settings";
import { ArchivedView } from "@/components/archived-view";
import { ElpisSettings } from "@/components/elpis-settings";
import { McpSettings } from "@/components/mcp-settings";
import { ProvidersSettings } from "@/components/providers-settings";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/api";

const TABS = [
  { id: "providers", label: "Models & accounts" },
  { id: "mcp", label: "MCP servers" },
  { id: "appearance", label: "Appearance" },
  { id: "elpis", label: "Elpis" },
  { id: "archived", label: "Archived chats" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Settings sections side by side, as in Cloudroom: one nav, one section at a time. */
type Props = {
  initialTab?: Tab;
  navigationKey?: number; active?: boolean;
  threadId?: string; accountRefresh: number; onProvidersChanged?: () => Promise<void> | void;
  theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void;
  onUnarchived: (thread: Thread) => void; onDeleteThread: (thread: Thread) => Promise<void>;
};

export function SettingsView({ initialTab = "providers", navigationKey = 0, active = true, threadId, accountRefresh, onProvidersChanged, theme, onTheme, onUnarchived, onDeleteThread }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [visited, setVisited] = useState<Tab[]>([initialTab]);
  useEffect(() => { setTab(initialTab); setVisited(previous => previous.includes(initialTab) ? previous : [...previous, initialTab]); }, [initialTab, navigationKey]);
  const selectTab = (next: Tab) => { setVisited(previous => previous.includes(next) ? previous : [...previous, next]); setTab(next); };
  return <div className="settings-layout">
    <nav className="settings-nav" role="tablist" aria-label="Settings sections">
      {TABS.map(item => <Button key={item.id} variant="ghost" role="tab" type="button" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)}>{item.label}</Button>)}
    </nav>
    <div className="settings-page">{visited.map(section => <div key={section} role="tabpanel" id={`settings-panel-${section}`} aria-labelledby={`settings-tab-${section}`} hidden={tab !== section}>
      {section !== "appearance" && section !== "elpis" && <h2 className="mb-5 text-lg font-semibold">{TABS.find(item => item.id === section)?.label}</h2>}
      {section === "providers" && <ProvidersSettings refreshKey={accountRefresh} onChanged={onProvidersChanged} />}
      {section === "mcp" && <McpSettings />}
      {section === "appearance" && <AppearanceSettings theme={theme} onTheme={onTheme} />}
      {section === "elpis" && <ElpisSettings threadId={threadId} active={active && tab === "elpis"} />}
      {section === "archived" && <ArchivedView onUnarchived={onUnarchived} onDelete={onDeleteThread} />}
    </div>)}</div>
  </div>;
}
