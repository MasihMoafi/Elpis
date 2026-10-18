"use client";

import { useEffect } from "react";
import { usePreferences } from "@/lib/preferences";
import { readingStyle } from "@/lib/reading";

/** Shared by every renderer route, including standalone windows. */
export function AppearanceTokens() {
  const preferences = usePreferences();
  useEffect(() => { document.documentElement.dataset.accent = preferences.accent; }, [preferences.accent]);
  useEffect(() => {
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(readingStyle(preferences))) root.setProperty(name, value);
  }, [preferences]);
  return null;
}
