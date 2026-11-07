import { useEffect, useLayoutEffect, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isVoiceHandoff } from "@/bridge/voice-handoff.cts";
import type { Entry, Thread } from "@/lib/api";
import { rememberSubmittedMessages, withSubmittedMessages, type SubmittedMessage } from "@/lib/submitted-messages";
import type { View } from "@/lib/workspace-types";

type Inputs = {
  selected: Thread | null; entries: Entry[]; submissions: SubmittedMessage[]; setSubmissions: Dispatch<SetStateAction<SubmittedMessage[]>>;
  newDraftKey: RefObject<string>; scroll: RefObject<HTMLDivElement | null>; restoreScroll: RefObject<{ height: number; top: number } | null>;
  pendingPosition: RefObject<{ id: string; top: number; atBottom: boolean } | null>;
  stickToBottom: RefObject<boolean>; view: View;
};

export function useTranscriptPresentation({ selected, entries, submissions, setSubmissions, newDraftKey, scroll, restoreScroll, pendingPosition, stickToBottom, view }: Inputs) {
  const shownScope = selected?.id ?? newDraftKey.current;
  const shownEntries = useMemo(() => withSubmittedMessages(entries, submissions, shownScope).filter(entry => !isVoiceHandoff(entry.item)), [entries, submissions, shownScope]);
  // Rewinding to the newest prompt would undo nothing he can see, so it has no Rewind (Masih, 29 Oct: "rewind what?").
  const newestPrompt = useMemo(() => shownEntries.findLast(entry => entry.item.type === "userMessage")?.item.id, [shownEntries]);
  useEffect(() => { setSubmissions(previous => rememberSubmittedMessages(entries, previous, selected?.id ?? newDraftKey.current)); }, [entries, selected?.id, submissions]);
  useLayoutEffect(() => { const element = scroll.current; if (!element) return; const position = pendingPosition.current; if (position && position.id === selected?.id && entries.length) { pendingPosition.current = null; stickToBottom.current = position.atBottom; element.scrollTop = position.atBottom ? element.scrollHeight : position.top; } else if (restoreScroll.current) { const previous = restoreScroll.current; restoreScroll.current = null; element.scrollTop = previous.top + element.scrollHeight - previous.height; } else if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight }); }, [entries, submissions, selected?.id]);

  // A chat that was at its end stays there when its box changes size (full view turns the column into a card).
  useEffect(() => {
    const element = scroll.current, content = element?.firstElementChild; if (!element || !content) return;
    const observer = new ResizeObserver(() => { if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight }); });
    observer.observe(element); observer.observe(content); return () => observer.disconnect();
  }, [view]);

  return { shownEntries, newestPrompt };
}
