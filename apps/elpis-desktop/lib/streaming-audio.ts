/** Feed MPEG frames to the media buffer as they arrive. A plain media URL waits for the complete response in Chromium. */
export async function playStreamingAudio(audio: HTMLAudioElement, url: string, signal: AbortSignal, prefetched?: Promise<Response>, shouldPlay = () => true) {
  if (!MediaSource.isTypeSupported("audio/mpeg")) throw new Error("This browser cannot play the local streaming voice.");
  const media = new MediaSource(), address = URL.createObjectURL(media);
  const transfer = new AbortController(), combined = AbortSignal.any([signal, transfer.signal]);
  let failure: Error | null = null;
  const speed = audio.playbackRate;
  const aborted = () => { audio.pause(); audio.removeAttribute("src"); audio.load(); };
  combined.addEventListener("abort", aborted, { once: true });
  const event = (target: EventTarget, name: string) => new Promise<void>((resolve, reject) => {
    const clean = () => { target.removeEventListener(name, done); combined.removeEventListener("abort", cancel); };
    const done = () => { clean(); resolve(); };
    const cancel = () => { clean(); reject(failure ?? new DOMException("Reading stopped", "AbortError")); };
    target.addEventListener(name, done, { once: true });
    combined.addEventListener("abort", cancel, { once: true });
    if (combined.aborted) cancel();
  });
  audio.onerror = () => { failure = new Error("The local speech stream could not be played."); transfer.abort(); };
  const ended = event(audio, "ended");
  ended.catch(() => {});
  try {
    const opened = event(media, "sourceopen");
    audio.src = address;
    audio.playbackRate = speed;
    audio.preservesPitch = true;
    if (shouldPlay()) void audio.play().catch(error => {
      if (error?.name === "AbortError" && !combined.aborted) return;
      failure = error; transfer.abort();
    });
    await opened;
    const buffer = media.addSourceBuffer("audio/mpeg");
    const failed = () => { failure = new Error("The local speech stream is invalid."); transfer.abort(); };
    buffer.addEventListener("error", failed);
    try {
      const response = await (prefetched ?? fetch(url, { signal: combined }));
      if (!response.ok || !response.body) throw new Error("The local voice could not start. Read the reply again.");
      const reader = response.body.getReader();
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener("abort", cancelRead, { once: true });
      if (combined.aborted) cancelRead();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const updated = event(buffer, "updateend");
          updated.catch(() => {});
          buffer.appendBuffer(new Uint8Array(value).buffer);
          await updated;
        }
      } finally { combined.removeEventListener("abort", cancelRead); await reader.cancel().catch(() => {}); }
      if (media.readyState === "open") media.endOfStream();
      await ended;
    } finally { buffer.removeEventListener("error", failed); }
  } finally {
    transfer.abort();
    combined.removeEventListener("abort", aborted);
    audio.onerror = null;
    URL.revokeObjectURL(address);
  }
}
