'use strict';
// Reads the renderer's desktop preferences (lib/preferences.ts) from the workspace store.
const PREFERENCES_KEY = 'elpis-preferences-v1';
function closeNeedsConfirmation(store) {
  try {
    const saved = store.read()[PREFERENCES_KEY];
    return typeof saved === 'string' && JSON.parse(saved)?.confirmClose === true;
  } catch { return false; }
}
module.exports = { PREFERENCES_KEY, closeNeedsConfirmation };
