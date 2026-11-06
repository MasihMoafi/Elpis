'use strict';

type Contents = { getURL: () => string } | null | undefined;
type Host = { webContents: Contents };
type Details = { requestingUrl?: string | undefined; isMainFrame?: boolean | undefined; mediaType?: string | undefined; mediaTypes?: string[] | undefined };

function fromApp(contents: Contents, host: Host, details: Details, origin: string) {
  if (!contents || contents !== host.webContents) return false;
  try { return new URL(details.requestingUrl as string).origin === origin && new URL(contents.getURL()).origin === origin; }
  catch { return false; }
}
function appAudioImpl(contents: Contents, host: Host, permission: string, details: Details, origin: string) {
  if (permission !== 'media' || details.isMainFrame !== true || !fromApp(contents, host, details, origin)) return false;
  return details.mediaType === 'audio' || (details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
}
// Settings → Notifications uses the web Notification API; only the Elpis page may show them.
function appNotificationsImpl(contents: Contents, host: Host, permission: string, details: Details, origin: string) {
  return permission === 'notifications' && details.isMainFrame !== false && fromApp(contents, host, details, origin);
}
// Copy buttons use the web clipboard API. Grant writes only to the app, never clipboard reads.
function appClipboardImpl(contents: Contents, host: Host, permission: string, details: Details, origin: string) {
  return permission === 'clipboard-sanitized-write' && details.isMainFrame !== false && fromApp(contents, host, details, origin);
}
const appPermissionImpl = (...args: Parameters<typeof appAudioImpl>) => appAudioImpl(...args) || appNotificationsImpl(...args) || appClipboardImpl(...args);
export declare const appAudio: typeof appAudioImpl;
export declare const appNotifications: typeof appNotificationsImpl;
export declare const appClipboard: typeof appClipboardImpl;
export declare const appPermission: typeof appPermissionImpl;
module.exports = { appAudio: appAudioImpl, appNotifications: appNotificationsImpl, appClipboard: appClipboardImpl, appPermission: appPermissionImpl };
