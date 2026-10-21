"use client";

import { useEffect } from "react";
import { usePreferences } from "@/lib/preferences";
import { readingStyle } from "@/lib/reading";
import { parseCustomThemes, THEME_COLORS } from "@/lib/theme-palettes";

/** Shared by every renderer route, including standalone windows. */
export function AppearanceTokens() {
  const preferences = usePreferences();
  useEffect(() => { document.documentElement.dataset.corners = preferences.cornerStyle; }, [preferences.cornerStyle]);
  useEffect(() => { document.documentElement.dataset.accent = preferences.accent; }, [preferences.accent]);
  useEffect(() => {
    const root = document.documentElement, style = root.style;
    const custom = parseCustomThemes(preferences.customThemes).find(theme => theme.id === preferences.selectedPalette);
    for (const mode of ["light", "dark"] as const) for (const { key } of THEME_COLORS) {
      const property = `--palette-${mode}-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      const color = custom?.[mode][key];
      if (color) style.setProperty(property, color); else style.removeProperty(property);
    }
    root.toggleAttribute("data-custom-palette", !!custom);
  }, [preferences.customThemes, preferences.selectedPalette]);
  useEffect(() => {
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(readingStyle(preferences))) root.setProperty(name, value);
  }, [preferences]);
  return null;
}
