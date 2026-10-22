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
/** The Session Manager (its sidebar row and its own review of running chats); off by default, hidden until it does enough. To bring it back, save sessionManager: true or change the default in lib/preferences.ts. */
const sessionManagerOn = store => saved(store).sessionManager === true;
/** Settings → General → Quick Entry keyboard shortcut; empty when turned off. */
function quickEntryShortcut(store) {
  const value = saved(store).quickEntryShortcut;
  return typeof value === 'string' ? value : DEFAULT_SHORTCUT;
}
module.exports = { PREFERENCES_KEY, closeNeedsConfirmation, closesToTray, quickEntryShortcut, sessionManagerOn };
