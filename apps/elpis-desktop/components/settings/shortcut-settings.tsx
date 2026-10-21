"use client";

import { useState } from "react";
import { SearchField } from "@/components/ui/search-field";
import { Button } from "@/components/ui/button";
import { SHORTCUTS, configuredShortcuts, canCustomizeShortcut, shortcutBindings, shortcutConflict, type Shortcut } from "@/lib/shortcuts";
import { savePreferences, usePreferences } from "@/lib/preferences";
import { ShortcutRecorder } from "@/components/settings/system-settings";
import { SettingRow, SettingsEmpty, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

const matches = (shortcut: Shortcut, query: string) => {
  const text = [shortcut.group, shortcut.label, shortcut.keys.join("+"), ...shortcut.keys].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
};

/** Every shortcut in SHORTCUTS, grouped and searchable by action, key or group. */
export function ShortcutSettings() {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const preferences = usePreferences(), bindings = shortcutBindings(preferences);
  const found = configuredShortcuts(preferences).filter(item => matches(item, query));
  const save = (id: string, binding: string | null) => {
    setError("");
    const keys = binding === null ? SHORTCUTS.find(item => item.id === id)!.keys : binding ? [binding] : [];
    const conflict = keys.map(key => shortcutConflict(id, key, preferences)).find(Boolean);
    if (conflict) { setError(`This shortcut is already used by ${conflict}. Change or turn off that binding first.`); return; }
    const next = { ...bindings };
    if (binding === null) delete next[id]; else next[id] = binding;
    try { savePreferences({ shortcutBindings: JSON.stringify(next) }); }
    catch (cause) { setError(`Could not save shortcut: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const groups = [...new Set(found.map(item => item.group))];
  return <div aria-label="Keyboard shortcuts">
    <SettingsHeader title="Keyboard shortcuts" description="Focus an app shortcut and press its new keys. On macOS, use Cmd where Ctrl is shown. Other rows document native window controls and gestures in the focused view." />
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    <SearchField aria-label="Search keyboard shortcuts" placeholder="Search keyboard shortcuts" value={query} onChange={event => setQuery(event.target.value)} />
    {groups.map(group => <SettingsGroup key={group} title={group}>
      {found.filter(item => item.group === group).map(item => <SettingRow key={item.id} title={item.label}>
        {canCustomizeShortcut(item.id) ? <>
          <ShortcutRecorder label={`Shortcut for ${item.label}`} shortcut={item.keys[0] ?? ""} reserved={[]} onRecord={binding => save(item.id, binding)} onRefuse={setError} />
          {item.keys.slice(1).map(key => <kbd key={key} className="kbd">{key}</kbd>)}
          {item.keys.length > 0 && <Button variant="ghost" aria-label={`Turn off shortcut for ${item.label}`} onClick={() => save(item.id, "")}>Off</Button>}
          {Object.hasOwn(bindings, item.id) && <Button variant="ghost" aria-label={`Reset shortcut for ${item.label}`} onClick={() => save(item.id, null)}>Reset</Button>}
        </> : <span className="flex items-center gap-1" aria-label={item.keys.join("+")}>{item.keys.map((key, index) => <kbd key={`${key}:${index}`} className="kbd">{key}</kbd>)}</span>}
      </SettingRow>)}
    </SettingsGroup>)}
    {!groups.length && <SettingsEmpty title={`No shortcuts match “${query.trim()}”`}>Try an action such as “search” or a key such as “Ctrl”.</SettingsEmpty>}
  </div>;
}
