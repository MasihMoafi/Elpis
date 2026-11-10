import { useEffect, useLayoutEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isVoiceHandoff } from "@/bridge/voice-handoff.cts";
import type { Entry, Thread } from "@/lib/api";
import { rememberSubmittedMessages, withSubmittedMessages, type SubmittedMessage } from "@/lib/submitted-messages";
import type { View } from "@/lib/workspace-types";

type Inputs = {
  selected: Thread | null;
  entries: Entry[];
  submissions: SubmittedMessage[];
  setSubmissions: Dispatch<SetStateAction<SubmittedMessage[]>>;
  newDraftKey: RefObject<string>;
  scroll: RefObject<HTMLDivElement | null>;
  restoreScroll: RefObject<{ height: number; top: number; anchor?: Element; offset?: number } | null>;
  pendingPosition: RefObject<{ id: string; turn: number; offset: number; atBottom: boolean } | null>;
  stickToBottom: RefObject<boolean>;
  view: View;
};

export function useTranscriptPresentation({
  selected,
  entries,
  submissions,
  setSubmissions,
  newDraftKey,
  scroll,
  restoreScroll,
  pendingPosition,
  stickToBottom,
  view,
}: Inputs) {
  // A restored place stays on its element for a moment: turns near it finish rendering from their estimated height
  // (content-visibility) over the next frames and would drag the view (C3, C5; 10 Nov: 700px after earlier messages).
  const pinned = useRef<{ element: Element; offset: number; until: number } | null>(null);
  const keep = (element: HTMLElement) => {
    const pin = pinned.current;
    if (!pin || performance.now() > pin.until || !pin.element.isConnected) return void (pinned.current = null);
    const drift = pin.element.getBoundingClientRect().top - element.getBoundingClientRect().top - pin.offset;
    if (Math.abs(drift) >= 1) element.scrollTop += drift;
  };
  const pin = (element: HTMLElement, target: Element, offset: number) => {
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
    pinned.current = { element: target, offset, until: performance.now() + 1000 };
  };
  const shownScope = selected?.id ?? newDraftKey.current;
  const shownEntries = useMemo(
    () => withSubmittedMessages(entries, submissions, shownScope).filter(entry => !isVoiceHandoff(entry.item)),
    [entries, submissions, shownScope],
  );
  // Rewinding to the newest prompt would undo nothing he can see, so it has no Rewind (Masih, 29 Oct: "rewind what?").
  const newestPrompt = useMemo(
    () => shownEntries.findLast(entry => entry.item.type === "userMessage")?.item.id,
    [shownEntries],
  );
  useEffect(() => {
    setSubmissions(previous => rememberSubmittedMessages(entries, previous, selected?.id ?? newDraftKey.current));
  }, [entries, selected?.id, submissions]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const position = pendingPosition.current;
    if (position && position.id === selected?.id && entries.length) {
      pendingPosition.current = null;
      stickToBottom.current = position.atBottom;
      const turns = element.querySelectorAll(".turn"),
        turn = turns[turns.length - 1 - position.turn];
      if (position.atBottom || !turn) element.scrollTop = element.scrollHeight;
      else pin(element, turn, position.offset);
    } else if (restoreScroll.current) {
      const previous = restoreScroll.current;
      restoreScroll.current = null;
      // The turn that was under the reader goes back to the same screen offset (C3; 10 Nov: it jumped 88px). The height
      // difference is only a fallback: rows above the transcript (the loading line) change size in the same render.
      if (previous.anchor?.isConnected && previous.offset !== undefined)
        pin(element, previous.anchor, previous.offset);
      else element.scrollTop = previous.top + element.scrollHeight - previous.height;
    } else if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight });
  }, [entries, submissions, selected?.id]);

  // A chat that was at its end stays there when its box changes size (full view turns the column into a card).
  useEffect(() => {
    const element = scroll.current,
      content = element?.firstElementChild;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight });
      else keep(element);
    });
    observer.observe(element);
    observer.observe(content);
    // The reader taking over, or a prompt-rail jump, ends a pin at once.
    const release = () => {
      pinned.current = null;
    };
    const intents = ["wheel", "pointerdown", "keydown", "elpis-scroll-intent"];
    for (const name of intents) element.addEventListener(name, release);
    return () => {
      observer.disconnect();
      for (const name of intents) element.removeEventListener(name, release);
    };
  }, [view]);

  return { shownEntries, newestPrompt };
}
