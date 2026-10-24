// Which sidebar sections (Projects, Pinned, Groups, Love Spot, Workflows, Recents, Other agents) and which projects are
// folded, as the person left them; kept in the desktop store (desktop/state.cjs) so a restart keeps them. No value imports,
// so the node tests load this file as it is.

export type SidebarFolds = { sections: Record<string, boolean>; projects: Record<string, boolean> };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export const FOLDS_KEY = "elpis-sidebar-folds-v1";
/** Workflows starts folded (Masih, 24 Oct: "workflow only be closed, collapsed, it's okay if it's there"). */
export const defaultFolds = (): SidebarFolds => ({ sections: { workflows: true }, projects: {} });

const flags = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
  .filter((entry): entry is [string, boolean] => !!entry[0] && typeof entry[1] === "boolean"));

/** What was saved, over the defaults; an unreadable value gives the defaults. */
export function readFolds(storage: Storage): SidebarFolds {
  const fallback = defaultFolds();
  try {
    const saved = JSON.parse(storage.getItem(FOLDS_KEY) || "null");
    if (!saved || typeof saved !== "object") return fallback;
    return { sections: { ...fallback.sections, ...flags(saved.sections) }, projects: flags(saved.projects) };
  } catch { return fallback; }
}

/** False when the store refused it; the fold still applies for this session. */
export function writeFolds(state: SidebarFolds, storage: Storage): boolean {
  try { storage.setItem(FOLDS_KEY, JSON.stringify(state)); return true; } catch { return false; }
}
