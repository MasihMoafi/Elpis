"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Segmented, SettingRow, SettingsGroup, SettingsHeader } from "@/components/settings/rows";

export type ThemeChoice = "system" | "light" | "dark";
const OPTIONS: { value: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];

/** Theme for this app window; System follows the operating system and changes with it. */
export function AppearanceSettings({ theme, onTheme }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void }) {
  return <div aria-label="Appearance">
    <SettingsHeader title="Appearance" description="Saved on this device." />
    <SettingsGroup>
      <SettingRow title="Theme" description="Use light or dark, or follow your system.">
        <Segmented label="Theme" value={theme} options={OPTIONS} onChange={onTheme} />
      </SettingRow>
    </SettingsGroup>
  </div>;
}
