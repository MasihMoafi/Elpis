import { useEffect, useState } from "react";
import type { ThemeChoice } from "@/components/appearance-settings";
import { appStorage } from "@/lib/projects";

/** The sidebar's width in pixels, set by dragging its edge (components/resize-edge.tsx). */
export const SIDEBAR = { initial: 256, min: 200, max: 480 };

/** Theme and sidebar width, kept on this device. Theme: System follows the operating system. The desktop gets the theme as dark or not,
 * the choice (System keeps the operating system in charge of pages in the browser) and the page's own --background, resolved: main
 * paints the browser's blank pages with it. */
export function useAppearance(onError: (message: string) => void) {
  const [theme, setThemeChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(false);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR.initial);
  useEffect(() => {
    const saved = Number(appStorage().getItem("elpis-sidebar-width"));
    if (saved >= SIDEBAR.min && saved <= SIDEBAR.max) setSidebarWidth(saved);
  }, []);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = appStorage().getItem("elpis-theme"); } catch { /* The theme starts as System. */ }
    if (saved === "system" || saved === "light" || saved === "dark") setThemeChoice(saved);
    const media = matchMedia("(prefers-color-scheme: dark)"); setSystemDark(media.matches);
    const follow = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", follow); return () => media.removeEventListener("change", follow);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); window.elpisDesktop?.setTheme?.(dark, { source: theme, background: getComputedStyle(document.body).backgroundColor }); }, [dark, theme]);
  const resizeSidebar = (width: number) => { setSidebarWidth(width); try { appStorage().setItem("elpis-sidebar-width", String(width)); } catch { /* the width still applies to this window */ } };
  const setTheme = (next: ThemeChoice) => { setThemeChoice(next); try { appStorage().setItem("elpis-theme", next); } catch { onError("Could not save appearance on this device."); } };
  return { theme, dark, setTheme, sidebarWidth, resizeSidebar };
}
