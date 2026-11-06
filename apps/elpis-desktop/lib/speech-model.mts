/** Google documents these Gemini TTS generations as mono 16-bit PCM at 24 kHz. */
export function speechPcmRate(model: string) {
  return /^google\/gemini-(?:2\.5|3\.1|3\.8)[a-z0-9.-]*tts(?::[a-z0-9.-]+)?$/i.test(model) ? 24000 : null;
}

/** Other PCM-only models need a known sample format before this player can offer them. */
export function speechModelUnavailable(model: string) {
  return /^(?:heygen\/|google\/.*tts)/i.test(model) && !speechPcmRate(model) ? 'This model returns PCM audio, which is unavailable here.' : null;
}
