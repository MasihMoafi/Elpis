'use strict';
// Reads the renderer's desktop preferences (lib/preferences.ts) from the workspace store.
const { DEFAULT_SHORTCUT } = require('./quick-entry.cjs');
const PREFERENCES_KEY = 'elpis-preferences-v1';
function saved(store) {
  try {
    const value = store.read()[PREFERENCES_KEY];
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
const closeNeedsConfirmation = store => saved(store).confirmClose === true;
/** Settings → General → Close to tray; off by default. */
const closesToTray = store => saved(store).closeToTray === true;
/** What the packaged app ships hidden (22 Oct): the pages that do not work yet and the Session Manager. The renderer's own defaults
 * (lib/preferences.ts) show everything, so a browser and the tests see every page. To bring one back, save its preference
 * (hiddenPages without the page's id, or sessionManager: true) or remove it here. */
const SHIPPED_DEFAULTS = { hiddenPages: 'experimentLab,canvas', sessionManager: false };
/** Saves a shipped default once, and never over a value the person or an earlier run already saved. */
async function seedShippedDefaults(store) {
  const current = saved(store);
  const changes = Object.fromEntries(Object.entries(SHIPPED_DEFAULTS).filter(([key]) => !Object.hasOwn(current, key)));
  if (Object.keys(changes).length) await store.patch({ key: PREFERENCES_KEY, changes, baseRevision: store.snapshot().revision }, null);
}
/** The Session Manager's own review of running chats; on unless saved off. */
const sessionManagerOn = store => saved(store).sessionManager !== false;
/** Settings → General → Quick Entry keyboard shortcut; empty when turned off. */
function quickEntryShortcut(store) {
  const value = saved(store).quickEntryShortcut;
  return typeof value === 'string' ? value : DEFAULT_SHORTCUT;
}
module.exports = { PREFERENCES_KEY, SHIPPED_DEFAULTS, closeNeedsConfirmation, closesToTray, quickEntryShortcut, seedShippedDefaults, sessionManagerOn };
