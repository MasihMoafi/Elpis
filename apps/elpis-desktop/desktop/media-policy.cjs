'use strict';

function fromApp(contents, host, details, origin) {
  if (!contents || contents !== host.webContents) return false;
  try { return new URL(details.requestingUrl).origin === origin && new URL(contents.getURL()).origin === origin; }
  catch { return false; }
}
function appAudio(contents, host, permission, details, origin) {
  if (permission !== 'media' || details.isMainFrame !== true || !fromApp(contents, host, details, origin)) return false;
  return details.mediaType === 'audio' || (details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
}
// Settings → Notifications uses the web Notification API; only the Elpis page may show them.
function appNotifications(contents, host, permission, details, origin) {
  return permission === 'notifications' && details.isMainFrame !== false && fromApp(contents, host, details, origin);
}
const appPermission = (...args) => appAudio(...args) || appNotifications(...args);
module.exports = { appAudio, appNotifications, appPermission };
