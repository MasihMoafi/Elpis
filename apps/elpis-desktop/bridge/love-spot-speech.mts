import type { SpeechEvent, SpeechFeed } from "./love-spot-talk-types.mts";
import { BridgeError } from "./validate.mts";
export function createSpeechFeed(threadId: string | null, allowed: () => boolean, onError: (message: string) => void) {
  let listener: ((event: SpeechEvent) => void | Promise<void>) | undefined,
    consumed = false,
    ended = false,
    queued: SpeechEvent[] = [],
    size = 0;
  const feed: SpeechFeed = {
    threadId,
    emit(event) {
      if (ended) return;
      if (event.type === "stop") {
        ended = true;
        queued = [];
      }
      if (event.type === "text") {
        if (!allowed()) return;
        size += event.text.length;
        if (!listener && (size > 262144 || queued.length >= 256))
          return feed.fail("Voice fell behind. Stop and retry explicitly.");
      }
      if (listener) void listener(event);
      else queued.push(event);
    },
    subscribe(listen) {
      if (consumed) throw new BridgeError("This Matilda reply already had a speaker. Retry explicitly.", 409);
      consumed = true;
      listener = listen;
      const backlog = queued;
      queued = [];
      size = 0;
      for (const event of backlog) void listen(event);
      return () => {
        listener = undefined;
        ended = true;
        queued = [];
      };
    },
    fail(message) {
      onError(message);
      feed.emit({ type: "stop" });
    },
  };
  return feed;
}
