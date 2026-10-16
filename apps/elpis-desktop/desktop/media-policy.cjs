'use strict';

function appAudio(contents, host, permission, details, origin) {
  if (!contents || contents !== host.webContents || permission !== 'media' || details.isMainFrame !== true) return false;
  try { if (new URL(details.requestingUrl).origin !== origin || new URL(contents.getURL()).origin !== origin) return false; }
  catch { return false; }
  return details.mediaType === 'audio' || (details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
}
module.exports = { appAudio };
