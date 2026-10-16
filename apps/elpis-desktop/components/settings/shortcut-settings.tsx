"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { SettingRow, SettingsGroup, SettingsHeader } from "@/components/settings/rows";

const matches = (shortcut: Shortcut, query: string) => {
  const text = [shortcut.group, shortcut.label, shortcut.keys.join("+"), ...shortcut.keys].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
};

/** Every shortcut in SHORTCUTS, grouped and searchable by action, key or group. */
export function ShortcutSettings() {
  const [query, setQuery] = useState("");
  const found = SHORTCUTS.filter(item => matches(item, query));
  const groups = [...new Set(found.map(item => item.group))];
  return <div aria-label="Keyboard shortcuts">
    <SettingsHeader title="Keyboard shortcuts" description="On macOS, use Cmd where Ctrl is shown." />
    <label className="settings-search relative block">
      <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="Search keyboard shortcuts" className="pl-8" placeholder="Search keyboard shortcuts" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    {groups.map(group => <SettingsGroup key={group} title={group}>
      {found.filter(item => item.group === group).map(item => <SettingRow key={item.id} title={item.label}>
        <span className="flex items-center gap-1" aria-label={item.keys.join("+")}>{item.keys.map((key, index) => <kbd key={`${key}:${index}`} className="settings-kbd">{key}</kbd>)}</span>
      </SettingRow>)}
    </SettingsGroup>)}
    {!groups.length && <div className="settings-rows settings-empty" role="status"><strong>No shortcuts match “{query.trim()}”</strong>Try an action such as “search” or a key such as “Ctrl”.</div>}
  </div>;
}
