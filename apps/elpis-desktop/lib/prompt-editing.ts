import { flushSync } from "react-dom";
import type { Dispatch, SetStateAction } from "react";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useTurnReplacementView } from "@/lib/use-turn-replacement-view";

type Inputs = {
  composer: ReturnType<typeof useComposerState>; session: ReturnType<typeof useConversationSession>; replacement: ReturnType<typeof useTurnReplacementView>;
  editDraft: (value: string) => void; setMessageEdits: Dispatch<SetStateAction<Record<string, string>>>; setSlashNotice: Dispatch<SetStateAction<string>>;
};

export function createPromptEditing({ composer, session, replacement, editDraft, setMessageEdits, setSlashNotice }: Inputs) {
  const { composerRef } = composer;
  const { selected, entries } = session;
  const { replaceable, replacementOptions } = replacement;
  /** Puts an earlier message (or the draft) in the box with the caret at its start or end, as the history keys do. */
  function writePrompt(value: string, caret: "start" | "end") {
    flushSync(() => editDraft(value));
    const at = caret === "end" ? value.length : 0;
    composerRef.current?.setSelectionRange(at, at);
  }
  /** Esc Esc in an empty box opens the newest message you sent for editing, as in Claude; one that cannot be replaced says why. */
  function editLastMessage() {
    if (!replaceable || !selected) return;
    const last = entries.filter(entry => entry.item.type === "userMessage").at(-1); if (!last) return;
    const option = replacementOptions.get(last.turnId);
    if (!option?.allowed) { if (option) setSlashNotice(option.reason); return; }
    setMessageEdits(previous => ({ ...previous, [JSON.stringify([selected.id, last.turnId, option.messageId])]: option.prompt }));
  }
  return { writePrompt, editLastMessage };
}
