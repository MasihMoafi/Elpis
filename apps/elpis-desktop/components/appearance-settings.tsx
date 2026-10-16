"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ThemeChoice = "system" | "light" | "dark";
const OPTIONS: { id: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  { id: "system", label: "System", icon: <Monitor size={15} /> },
  { id: "light", label: "Light", icon: <Sun size={15} /> },
  { id: "dark", label: "Dark", icon: <Moon size={15} /> },
];

/** Theme for this app window; System follows the operating system and changes with it. */
export function AppearanceSettings({ theme, onTheme }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void }) {
  return <section className="mb-8" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading" className="mb-1 text-lg font-semibold">Appearance</h2>
    <p className="mb-3 text-sm text-muted-foreground">Saved on this device.</p>
    <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-2">
      {OPTIONS.map(option => <Button key={option.id} role="radio" aria-checked={theme === option.id} variant={theme === option.id ? "default" : "outline"} onClick={() => onTheme(option.id)}>{option.icon}{option.label}</Button>)}
    </div>
  </section>;
}
