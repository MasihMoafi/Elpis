/** Restores workspace preferences and syncs the desktop theme and storage errors. */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ThemeChoice } from "@/components/appearance-settings";
import { activeTab, readTabs, type ChatTabs } from "@/lib/chat-tabs";
import { appStorage, readProjects, type Project } from "@/lib/projects";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = { dark: boolean; theme: ThemeChoice; newDraftKey: Ref<string>; setText: (value: string) => void;
  savedDraft: (id: string) => string; restoreAttachments: (id: string) => void;
  setProjects: Setter<Project[]>; setProjectId: Setter<string | null>; setCwd: Setter<string>;
  updateTabs: (next: ChatTabs) => void; restoredTabs: Ref<boolean>; setTabsRestored: Setter<boolean>;
  setThemeChoice: Setter<ThemeChoice>; setSystemDark: Setter<boolean>; setError: Setter<string> };

export function useWorkspaceRestore({ dark, theme, newDraftKey, setText, savedDraft, restoreAttachments,
  setProjects, setProjectId, setCwd, updateTabs, restoredTabs, setTabsRestored, setThemeChoice,
  setSystemDark, setError }: Props) {
  // The desktop gets the theme as dark or not, the choice (System keeps the operating system in charge of pages in the browser)
  // and the page's own --background, resolved: main paints the browser's blank pages with it.
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); window.elpisDesktop?.setTheme?.(dark, { source: theme, background: getComputedStyle(document.body).backgroundColor }); }, [dark, theme]);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = appStorage().getItem("elpis-theme"); const stored = readProjects(); newDraftKey.current = stored.selectedId ? `new-${stored.selectedId}` : "new"; setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setProjects(stored.projects); setProjectId(stored.selectedId); setCwd(stored.projects.find(item => item.id === stored.selectedId)?.cwd ?? ""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not restore workspace preferences."); }
    try {
      const store = window.elpisDesktop?.storage, restored = store && readTabs(store);
      if (restored) {
        updateTabs(restored); restoredTabs.current = true;
        const shown = activeTab(restored);
        if (!shown.threadId && shown.draftKey) { newDraftKey.current = shown.draftKey; setText(savedDraft(shown.draftKey)); restoreAttachments(shown.draftKey); }
      }
    } catch { /* The tabs start afresh. */ }
    setTabsRestored(true);
    if (saved === "system" || saved === "light" || saved === "dark") setThemeChoice(saved);
    const media = matchMedia("(prefers-color-scheme: dark)"); setSystemDark(media.matches);
    const follow = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", follow); return () => media.removeEventListener("change", follow);
  }, []);
  useEffect(() => window.elpisDesktop?.storage?.onError(setError), []);
}
