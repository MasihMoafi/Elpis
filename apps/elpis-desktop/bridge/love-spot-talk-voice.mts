import { createSpeechFeed } from "./love-spot-speech.mts";
import { BridgeError } from "./validate.mts";
import type { Client, SpeechFeed, Store, Writing } from "./love-spot-talk-types.mts";

/** Matilda's voice: whether she may speak, why not, and the feed of the reply being spoken. */
export function createTalkVoice({
  audio,
  store,
  client,
  threadId,
  publish,
}: {
  audio: { available: boolean; reason?: string };
  store: Store;
  client: Client;
  threadId: () => string | null;
  publish: () => void;
}) {
  let muted = false,
    available = false,
    reason: string | undefined = "",
    voiceError = "",
    feed: SpeechFeed | undefined;
  const state = () => ({
    enabled: available && !muted,
    available,
    reason,
    error: voiceError,
  });
  const emit: SpeechFeed["emit"] = event => feed?.emit(event);
  const off = (why: string | undefined) => {
    available = false;
    reason = why;
    emit({ type: "stop" });
    return state();
  };
  async function refresh() {
    if (!audio.available) {
      voiceError = "";
      return off(audio.reason);
    }
    try {
      muted = await store.voice();
    } catch {
      return off("Voice settings could not be read. Writing can continue.");
    }
    try {
      available = (await client.voiceStatus()).available;
      reason = available ? "" : "Connect ChatGPT in Settings → Connections.";
    } catch {
      available = false;
      reason = "ChatGPT voice is unavailable. Check Settings → Connections.";
    }
    if (!available) emit({ type: "stop" });
    return state();
  }
  function startFeed() {
    emit({ type: "stop" });
    feed = createSpeechFeed(
      threadId(),
      () => state().enabled && !voiceError,
      message => {
        voiceError = message;
        publish();
      },
    );
    return feed;
  }
  const requireLive = () => {
    if (!available) throw new BridgeError(reason, 403);
    if (muted) throw new BridgeError("Matilda Voice is off.", 409);
  };
  return {
    state,
    emit,
    refresh,
    startFeed,
    requireLive,
    silenced: () => muted,
    clearError: () => {
      voiceError = "";
    },
    requireAudio: () => {
      if (!audio.available) throw new BridgeError(audio.reason, 403);
    },
    async set(enabled: boolean, writing: Writing | undefined) {
      if (!enabled) emit({ type: "stop" });
      for (const item of writing?.items.values() ?? []) item.buffer.discard();
      await store.voice(!enabled);
      await refresh();
      if (enabled && available && writing && !writing.done) {
        for (const item of writing.items.values()) item.buffer.discard();
        voiceError = "";
        startFeed();
      }
      publish();
      return state();
    },
    speech() {
      requireLive();
      if (voiceError) throw new BridgeError(voiceError, 409);
      if (!feed) throw new BridgeError("Matilda has no new reply to speak.", 409);
      return feed;
    },
  };
}
