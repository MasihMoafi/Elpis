"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsGroup, SettingsHeader } from "@/components/settings/rows";

export type ThemeChoice = "system" | "light" | "dark";
const OPTIONS: { id: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  { id: "system", label: "System", icon: <Monitor size={14} /> },
  { id: "light", label: "Light", icon: <Sun size={14} /> },
  { id: "dark", label: "Dark", icon: <Moon size={14} /> },
];

/** Theme for this app window; System follows the operating system and changes with it. */
export function AppearanceSettings({ theme, onTheme }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void }) {
  return <div aria-label="Appearance">
    <SettingsHeader title="Appearance" description="Saved on this device." />
    <SettingsGroup>
      <SettingRow title="Theme" description="Use light or dark, or follow your system.">
        <div role="radiogroup" aria-label="Theme" className="settings-segmented">
          {OPTIONS.map(option => <Button key={option.id} type="button" variant="ghost" size="sm" role="radio" aria-checked={theme === option.id} onClick={() => onTheme(option.id)}>{option.icon}{option.label}</Button>)}
        </div>
      </SettingRow>
    </SettingsGroup>
  </div>;
}
