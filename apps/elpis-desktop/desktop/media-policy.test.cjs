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
