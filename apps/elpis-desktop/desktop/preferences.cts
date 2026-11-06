'use strict';
// Reads the renderer's desktop preferences (lib/preferences.ts) from the workspace store.
type ReadStore = { read: () => Record<string, unknown> };
type SeedStore = ReadStore & { snapshot: () => { revision?: number }; patch: (input: { key: string; changes: Record<string, unknown>; baseRevision: number }, writer: null) => Promise<unknown> };
const { DEFAULT_SHORTCUT }: typeof import('./quick-entry.cts') = require('./quick-entry.cts');
const PREFERENCES_KEY_VALUE = 'elpis-preferences-v1';
function saved(store: ReadStore): Record<string, unknown> {
  try {
    const value = store.read()[PREFERENCES_KEY_VALUE];
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
const closeNeedsConfirmationImpl = (store: ReadStore) => saved(store).confirmClose === true;
/** Settings → General → Close to tray; off by default. */
const closesToTrayImpl = (store: ReadStore) => saved(store).closeToTray === true;
/** What the packaged app ships hidden (22 Oct): the pages that do not work yet. The renderer's own defaults
 * (lib/preferences.ts) show everything, so a browser and the tests see every page. To bring one back, save its preference
 * (hiddenPages without the page's id) or remove it here. */
const SHIPPED_DEFAULTS_VALUE = { hiddenPages: 'experimentLab', profileAsked: false };
/** What the first shipped list hid (22 Oct). Workflows comes back piece by piece (Masih, 23 Oct: "Let's start working our way back to the workflow page"): a list still equal to it, never changed by the person, loses `canvas`. */
const FIRST_SHIPPED_HIDDEN = 'experimentLab,canvas';
/** Saves a shipped default once, and never over a value the person or an earlier run already saved. */
async function seedShippedDefaultsImpl(store: SeedStore) {
  const current = saved(store);
  const changes = Object.fromEntries(Object.entries(SHIPPED_DEFAULTS_VALUE).filter(([key]) => !Object.hasOwn(current, key)));
  if (current.hiddenPages === FIRST_SHIPPED_HIDDEN) changes.hiddenPages = SHIPPED_DEFAULTS_VALUE.hiddenPages;
  if (Object.keys(changes).length) await store.patch({ key: PREFERENCES_KEY_VALUE, changes, baseRevision: store.snapshot().revision as number }, null);
}
/** Settings → General → Quick Entry keyboard shortcut; empty when turned off. */
function quickEntryShortcutImpl(store: ReadStore) {
  const value = saved(store).quickEntryShortcut;
  return typeof value === 'string' ? value : DEFAULT_SHORTCUT;
}
export declare const closeNeedsConfirmation: typeof closeNeedsConfirmationImpl;
export declare const closesToTray: typeof closesToTrayImpl;
export declare const quickEntryShortcut: typeof quickEntryShortcutImpl;
export declare const seedShippedDefaults: typeof seedShippedDefaultsImpl;

export declare const PREFERENCES_KEY: typeof PREFERENCES_KEY_VALUE;
export declare const SHIPPED_DEFAULTS: typeof SHIPPED_DEFAULTS_VALUE;
module.exports = { PREFERENCES_KEY: PREFERENCES_KEY_VALUE, SHIPPED_DEFAULTS: SHIPPED_DEFAULTS_VALUE, closeNeedsConfirmation: closeNeedsConfirmationImpl, closesToTray: closesToTrayImpl, quickEntryShortcut: quickEntryShortcutImpl, seedShippedDefaults: seedShippedDefaultsImpl };
