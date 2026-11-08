import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, unreadable, type Entry, type Thread } from "@/lib/api";
import { historyPath } from "@/lib/chat-history";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";

type Inputs = {
  history: ReturnType<typeof useTranscriptHistory>;
  selected: Thread | null;
  selectedRef: RefObject<Thread | null>;
  request: RefObject<number>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setEntries: Dispatch<SetStateAction<Entry[]>>;
  stickToBottom: RefObject<boolean>;
  scroll: RefObject<HTMLDivElement | null>;
  restoreScroll: RefObject<{ height: number; top: number } | null>;
};

export function createEarlierMessages({
  history,
  selected,
  selectedRef,
  request,
  setLoading,
  setError,
  setEntries,
  stickToBottom,
  scroll,
  restoreScroll,
}: Inputs) {
  const { heldEarlier, itemCursor, setItemCursor, setHeldCount } = history;
  const EARLIER_MESSAGES = 10;
  const earlierHeld = (id?: string) => !!id && (heldEarlier.current.get(id)?.length ?? 0) > 0;
  async function older(untilTurnId?: string, untilItemId?: string): Promise<boolean> {
    if (!selected || (!itemCursor && !earlierHeld(selected.id))) return false;
    const revision = request.current;
    setLoading(true);
    const id = selected.id,
      pages: Entry[] = [...(heldEarlier.current.get(id) ?? [])],
      seen = new Set<string>();
    const messagesIn = (list: Entry[]) => list.filter(entry => entry.item.type === "userMessage").length;
    let cursor: string | null = itemCursor,
      found = pages.some(
        entry =>
          entry.turnId === untilTurnId &&
          entry.item.type === "userMessage" &&
          (!untilItemId || entry.item.id === untilItemId),
      );
    try {
      // A press brings ten more of the chat's messages, however many tool steps lie between them.
      while (cursor && !found && (untilTurnId || messagesIn(pages) < EARLIER_MESSAGES)) {
        if (seen.has(cursor)) throw new Error("Repeated conversation cursor");
        seen.add(cursor);
        const result: { data: Entry[]; nextCursor: string | null } = await api(historyPath(id, cursor));
        if (!Array.isArray(result.data)) throw unreadable("conversations");
        found = result.data.some(
          entry =>
            entry.turnId === untilTurnId &&
            entry.item.type === "userMessage" &&
            (!untilItemId || entry.item.id === untilItemId),
        );
        pages.unshift(...result.data.reverse());
        cursor = result.nextCursor;
        if (selectedRef.current?.id !== id || request.current !== revision) break;
      }
      if (selectedRef.current?.id !== id || request.current !== revision) return false;
      // Show from the tenth message back; keep the rest for the next press.
      let split = 0;
      if (!untilTurnId && messagesIn(pages) > EARLIER_MESSAGES) {
        let count = 0;
        for (let index = pages.length - 1; index >= 0; index--)
          if (pages[index]!.item.type === "userMessage" && ++count === EARLIER_MESSAGES) {
            split = index;
            break;
          }
      }
      heldEarlier.current.set(id, pages.slice(0, split));
      setError("");
      stickToBottom.current = false;
      if (scroll.current)
        restoreScroll.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
      setEntries(prev => [...pages.slice(split), ...prev]);
      setItemCursor(cursor);
      setHeldCount(count => count + 1);
      return untilTurnId ? found : true;
    } catch (e) {
      if (request.current === revision) setError(String(e));
      return false;
    } finally {
      if (request.current === revision) setLoading(false);
    }
  }
  return { earlierHeld, older };
}
