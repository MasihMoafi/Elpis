/** Availability still requires a signed-in ChatGPT voice connection at runtime. */
export const LOVE_SPOT_AUDIO = Object.freeze({
  available: true,
  readAloudAvailable: false,
  reason: "",
  pendingReason: "Audio is unavailable while chat information loads.",
});

/** Keep read aloud hidden until subscription speech is reliable and faithful. */
export const READ_ALOUD_AUDIO = Object.freeze({ available: false });
