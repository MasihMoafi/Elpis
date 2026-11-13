import { speakable, speakableLength } from "./read-aloud-text.ts";
import type { LiveSpeech } from "./read-aloud-text.ts";
import type { Entry } from "../lib/api.ts";
import { replyPortrait } from "../bridge/matilda-face.cts";

/** Her reply as the small chat shows it: without the portrait marker she starts it with. */
export const shownReply = (text: string) => replyPortrait(text).text;

/** One of her replies in the small chat, as the bridge sends it. */
export type SpokenReply = { id: string; text: string };

/** Her final answers in the small chat that are not from before it opened. */
export function herReplies(entries: Entry[], earlier: Set<string>): SpokenReply[] {
  return entries
    .filter(
      entry =>
        entry.item.type === "agentMessage" &&
        (!entry.item.phase || entry.item.phase === "final_answer") &&
        !earlier.has(entry.turnId),
    )
    .map(entry => ({
      id: `${entry.turnId}:${entry.item.id}`,
      text: typeof entry.item.text === "string" ? entry.item.text : "",
    }));
}

/** What she has said of each reply, counted in spoken words. */
export type MiniVoice = {
  said: Map<string, number>;
  stopped: Set<string>;
  live: { id: string; speech: LiveSpeech } | null;
  suppress: boolean;
};

export const miniVoice = (): MiniVoice => ({ said: new Map(), stopped: new Set(), live: null, suppress: false });

const wordCount = (text: string) => text.match(/\S+/g)?.length ?? 0;
/** Where the text goes on after its first `count` words, or -1 when it has fewer. */
function afterWords(text: string, count: number) {
  if (!count) return 0;
  let seen = 0;
  for (const word of text.matchAll(/\S+/g)) if (++seen === count) return word.index + word[0].length;
  return -1;
}

/** Speak what is new in her replies since the last update, from the text the small chat shows. While she writes, the
 * bridge sends her reply as streamed; once she is done, its cleaned-up final text replaces it, so what was said is counted
 * in spoken words, not characters of a text that changes (13 Nov, Masih: "the read-aloud differs from what I see").
 * `open` starts a reading, or returns null when the voice is unavailable; returns whether it was. */
export function speakReplies(
  state: MiniVoice,
  replies: SpokenReply[],
  { busy, enabled, open }: { busy: boolean; enabled: boolean; open: (id: string) => LiveSpeech | null },
) {
  let unavailable = false;
  for (const { id, text } of replies) {
    const shown = shownReply(text);
    if (state.suppress || state.stopped.has(id) || !enabled) {
      state.said.set(id, wordCount(speakable(shown)));
      state.stopped.add(id);
      continue;
    }
    const ready = speakable(busy ? shown.slice(0, speakableLength(shown, true)) : shown),
      said = state.said.get(id) ?? 0,
      start = afterWords(ready, said);
    const next = start < 0 ? "" : ready.slice(start);
    if (!next.trim()) continue;
    if (state.live?.id !== id) {
      const opened = open(id);
      if (!opened) {
        unavailable = true;
        state.said.set(id, wordCount(speakable(shown)));
        continue;
      }
      state.live = { id, speech: opened };
    }
    state.said.set(id, said + wordCount(next));
    state.live.speech.feed(next);
  }
  if (!busy) {
    state.suppress = false;
    state.live?.speech.end();
    state.live = null;
  }
  return unavailable;
}
