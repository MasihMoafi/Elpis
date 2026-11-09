import { createSentenceBuffer } from "./speech-buffer.mts";
import type { Item, Page, Writing } from "./love-spot-talk-types.mts";
import type { createTalkVoice } from "./love-spot-talk-voice.mts";

/** The reply Matilda is writing: one buffer per message, spoken sentence by sentence and previewed on the board. */
export function createTalkWriting({
  voice,
  finished,
  page,
  preview,
}: {
  voice: ReturnType<typeof createTalkVoice>;
  finished: Set<string>;
  page: () => Page | undefined;
  preview: (turnId: string, note: string, page: Page | undefined) => void;
}) {
  let writing: Writing | undefined;
  function cancel() {
    if (!writing) return;
    clearTimeout(writing.timer!);
    for (const item of writing.items.values()) item.buffer.cancel();
  }
  function begin(turnId: string | null) {
    if (writing?.id === turnId && !writing.done) return;
    cancel();
    writing = {
      id: turnId,
      items: new Map(),
      page: page(),
      timer: null,
      done: false,
    };
    voice.clearError();
    voice.startFeed();
  }
  function streamed(turnId: string, item: Item, delta?: string) {
    if (finished.has(turnId) || (item.phase && item.phase !== "final_answer")) return;
    if (!writing || writing.done) begin(turnId);
    if (!writing!.id) writing!.id = turnId;
    if (writing!.id !== turnId) return;
    let stream = writing!.items.get(item.id);
    if (!stream) {
      let separator = writing!.items.size ? "\n\n" : "";
      for (const previous of writing!.items.values()) previous.buffer.finish();
      stream = {
        raw: "",
        buffer: createSentenceBuffer(chunk => {
          voice.emit({ type: "text", text: separator + chunk });
          separator = "";
        }),
      };
      writing!.items.set(item.id, stream);
    }
    const next = delta ?? (item.text?.startsWith(stream.raw) ? item.text.slice(stream.raw.length) : "");
    stream.raw += next;
    stream.buffer.push(next);
    if (!writing!.timer) {
      const current = writing!;
      current.timer = setTimeout(() => {
        current.timer = null;
        if (current.done) return;
        preview(turnId, [...current.items.values()].map(item => item.buffer.text()).join("\n\n"), current.page);
      }, 300).unref();
    }
  }
  return {
    now: () => writing,
    reset: () => {
      writing = undefined;
    },
    begin,
    cancel,
    streamed,
  };
}
