"use client";

import { useState } from "react";
import { SearchField } from "@/components/ui/search-field";
import { SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { SettingRow, SettingsEmpty, SettingsGroup, SettingsHeader } from "@/components/settings/rows";

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
    <SearchField aria-label="Search keyboard shortcuts" placeholder="Search keyboard shortcuts" value={query} onChange={event => setQuery(event.target.value)} />
    {groups.map(group => <SettingsGroup key={group} title={group}>
      {found.filter(item => item.group === group).map(item => <SettingRow key={item.id} title={item.label}>
        <span className="flex items-center gap-1" aria-label={item.keys.join("+")}>{item.keys.map((key, index) => <kbd key={`${key}:${index}`} className="kbd">{key}</kbd>)}</span>
      </SettingRow>)}
    </SettingsGroup>)}
    {!groups.length && <SettingsEmpty title={`No shortcuts match “${query.trim()}”`}>Try an action such as “search” or a key such as “Ctrl”.</SettingsEmpty>}
  </div>;
}
