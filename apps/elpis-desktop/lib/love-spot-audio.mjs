/** Keep Love Spot text-only until its playback and live-call acceptance checks pass. */
export const LOVE_SPOT_AUDIO = Object.freeze({
  available: false,
  reason: "Love Spot audio is temporarily unavailable.",
  pendingReason: "Audio is unavailable while chat information loads.",
});

/** Keep read aloud hidden until subscription speech is reliable and faithful. */
export const READ_ALOUD_AUDIO = Object.freeze({ available: false });
