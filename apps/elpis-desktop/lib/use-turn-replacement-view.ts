import { useMemo } from "react";
import type { Entry, Thread } from "@/lib/api";
import { replacementEligibility } from "@/lib/turn-replacement";

type Inputs = {
  selected: Thread | null;
  entries: Entry[];
  shownEntries: Entry[];
  continues: boolean;
  activeTurn: string | undefined;
  connected: boolean;
  busy: boolean;
  loading: boolean;
  itemCursor: string | null;
};

export function useTurnReplacementView({
  selected,
  entries,
  shownEntries,
  continues,
  activeTurn,
  connected,
  busy,
  loading,
  itemCursor,
}: Inputs) {
  const editable = !!selected && !continues && connected && !busy;
  // Rewind, delete and version navigation still require an idle chat.
  const replaceable = editable && !activeTurn && selected.status?.type !== "active";
  const { turnEntries, replacementOptions, replacementOptionsKey } = useMemo(() => {
    const turnEntries = new Map<string, Entry[]>();
    // Live items may arrive out of order; target the first message the transcript actually shows.
    for (const entry of shownEntries) {
      const group = turnEntries.get(entry.turnId) ?? [];
      group.push(entry);
      turnEntries.set(entry.turnId, group);
    }
    // Only the oldest turn can be cut by a descending history page.
    const replacementOptions = new Map(
      [...turnEntries].map(([id, group]) => [
        id,
        group.some(entry => entry.clientPending && entry.item.type === "userMessage")
          ? { allowed: false as const, reason: "Wait for this turn's messages to be recorded before editing." }
          : replacementEligibility(group, id, {
              historyComplete: !loading && (itemCursor === null || id !== entries[0]?.turnId),
            }),
      ]),
    );
    // The transcript already depends on shownEntries for prompt text and attachments.
    // This key tracks eligibility only; serializing every prompt on each streamed token
    // duplicates large histories and creates avoidable garbage collection.
    const replacementOptionsKey = JSON.stringify(
      [...replacementOptions].map(([id, option]) => [id, option.allowed, option.allowed ? option.messageId : option.reason]),
    );
    return { turnEntries, replacementOptions, replacementOptionsKey };
  }, [shownEntries, entries, loading, itemCursor]);
  const regenerate = (() => {
    if (!replaceable) return null;
    const last = entries.at(-1);
    if (!last) return null;
    const turn = entries.filter(entry => entry.turnId === last.turnId);
    const eligibility = replacementOptions.get(last.turnId);
    const prompt = eligibility?.allowed ? eligibility.prompt : null;
    const reply = turn.filter(entry => entry.item.type === "agentMessage").at(-1);
    return prompt && reply ? { turnId: last.turnId, prompt, replyId: reply.item.id } : null;
  })();
  return { editable, replaceable, turnEntries, replacementOptions, replacementOptionsKey, regenerate };
}
