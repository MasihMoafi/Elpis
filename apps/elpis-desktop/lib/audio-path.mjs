/** Local audio references open in Matilda's existing music player. */
export function isAudioPath(value) {
  return typeof value === 'string' && /\.(?:mp3|m4a|aac|flac|wav|wave|ogg|oga|opus|aif|aiff)$/i.test(value);
}
