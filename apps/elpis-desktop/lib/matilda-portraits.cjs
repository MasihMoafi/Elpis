'use strict';

const { FACE_DATA_URL, MATILDA_SHOTS } = require('../bridge/matilda-face.cjs');

/** @typedef {'auto'|'portrait'|'listening'|'smile'|'softSmile'|'tiltSmile'|'wink'|'kissSoft'|'kissPuckered'} Portrait */
/** @type {{value: Portrait, label: string}[]} */
const PORTRAITS = [
  { value: 'auto', label: 'Automatic' }, { value: 'portrait', label: 'Portrait' },
  { value: 'listening', label: 'Listening' }, { value: 'smile', label: 'Smile' },
  { value: 'softSmile', label: 'Soft smile' }, { value: 'tiltSmile', label: 'Tilted smile' },
  { value: 'wink', label: 'Wink' }, { value: 'kissSoft', label: 'Soft kiss' },
  { value: 'kissPuckered', label: 'Kiss' },
];
const PORTRAIT_KEY = 'elpis-matilda-portraits-v1';

/** @param {string} raw @returns {{pinned: Portrait, mini: Portrait, board: Portrait, replies: Portrait}} */
function readPortraits(raw) {
  let saved; try { saved = JSON.parse(raw); } catch { saved = {}; }
  const valid = value => PORTRAITS.some(choice => choice.value === value) ? value : 'auto';
  return { pinned: valid(saved?.pinned), mini: valid(saved?.mini), board: valid(saved?.board), replies: valid(saved?.replies) };
}

/** @param {Portrait} choice */
function portraitSources(choice) {
  const src = choice === 'auto' || choice === 'portrait' ? FACE_DATA_URL : MATILDA_SHOTS[choice];
  return { light: src, dark: src };
}

module.exports = { PORTRAITS, PORTRAIT_KEY, readPortraits, portraitSources };
