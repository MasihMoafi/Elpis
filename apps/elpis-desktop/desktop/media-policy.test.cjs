const test = require('node:test');
const assert = require('node:assert/strict');
const { appAudio } = require('./media-policy.cjs');

test('only the Elpis main frame can capture audio; websites, camera and other permissions stay denied', () => {
  const origin = 'http://127.0.0.1:4000'; const contents = { getURL: () => origin + '/' }; const host = { webContents: contents };
  const details = { requestingUrl: origin + '/', isMainFrame: true, mediaType: 'audio' };
  assert.equal(appAudio(contents, host, 'media', details, origin), true);
  assert.equal(appAudio(contents, host, 'media', { ...details, mediaType: undefined, mediaTypes: ['audio'] }, origin), true);
  for (const invalid of [{ ...details, isMainFrame: false }, { ...details, requestingUrl: 'https://example.com' }, { ...details, mediaType: 'video' }, { ...details, mediaType: undefined, mediaTypes: ['audio', 'video'] }]) assert.equal(appAudio(contents, host, 'media', invalid, origin), false);
  assert.equal(appAudio({}, host, 'media', details, origin), false);
  assert.equal(appAudio(contents, host, 'display-capture', details, origin), false);
});

test('only the Elpis page may show notifications; websites and subframes may not', () => {
  const { appNotifications, appPermission } = require('./media-policy.cjs');
  const origin = 'http://127.0.0.1:4000'; const contents = { getURL: () => origin + '/' }; const host = { webContents: contents };
  const details = { requestingUrl: origin + '/', isMainFrame: true };
  assert.equal(appNotifications(contents, host, 'notifications', details, origin), true);
  assert.equal(appPermission(contents, host, 'notifications', { requestingUrl: origin + '/' }, origin), true);
  for (const invalid of [{ ...details, isMainFrame: false }, { ...details, requestingUrl: 'https://example.com/' }]) assert.equal(appNotifications(contents, host, 'notifications', invalid, origin), false);
  assert.equal(appNotifications({ getURL: () => origin + '/' }, host, 'notifications', details, origin), false);
  assert.equal(appPermission(contents, host, 'geolocation', details, origin), false);
});

test('Elpis can copy text without granting clipboard reads or allowing websites and subframes to write', () => {
  const { appPermission } = require('./media-policy.cjs');
  const origin = 'http://127.0.0.1:4000', contents = { getURL: () => origin + '/' }, host = { webContents: contents };
  const details = { requestingUrl: origin + '/', isMainFrame: true };
  assert.equal(appPermission(contents, host, 'clipboard-sanitized-write', details, origin), true);
  assert.equal(appPermission(contents, host, 'clipboard-sanitized-write', { requestingUrl: origin + '/' }, origin), true);
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'unknown']) assert.equal(appPermission(contents, host, permission, details, origin), false);
  for (const invalid of [{ ...details, isMainFrame: false }, { ...details, requestingUrl: 'https://example.invalid/' }, { ...details, requestingUrl: undefined }]) assert.equal(appPermission(contents, host, 'clipboard-sanitized-write', invalid, origin), false);
  assert.equal(appPermission({ getURL: () => origin + '/' }, host, 'clipboard-sanitized-write', details, origin), false);
});
