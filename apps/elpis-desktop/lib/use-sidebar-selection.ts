import { useRef, useState } from "react";
import { selectInOrder } from "./ordered-selection";
import type React from "react";
import type { Thread } from "@/lib/api";
import { useSteadyRowList } from "@/lib/whole-rows";

type Inputs = {
  selected: Thread | null;
  openSplit: (thread: Thread) => void;
  openThread: (thread: Thread) => Promise<void>;
};

export function useSidebarSelection({ selected, openSplit, openThread }: Inputs) {
  /** Chats marked with Ctrl+click or Shift+click in the sidebar; `markAnchor` is where a Shift range starts. */
  const [marked, setMarked] = useState<string[]>([]);
  const markAnchor = useRef<string | null>(null);
  const threadList = useRef<HTMLDivElement>(null);
  useSteadyRowList(threadList, ".thread-row, .project-row, .section-label-row, .sidebar-group-row, .thread-more");
  /** The sidebar's chat buttons in screen order (a project's chats also appear under Recents). */
  const rowLinks = () => [
    ...(threadList.current?.querySelectorAll<HTMLButtonElement>(".thread-row > .thread-link") ?? []),
  ];
  const rowOf = (element: Element | null) => element?.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  /** A click opens the chat; Ctrl+click marks or unmarks it; Shift+click marks the range from the last click, as in a file manager. */
  function clickRow(thread: Thread, event: React.MouseEvent<HTMLButtonElement>, onOpen?: () => void) {
    if (event.altKey) {
      event.preventDefault();
      openSplit(thread);
      return;
    }
    const ids = [
      ...new Set(
        rowLinks()
          .map(rowOf)
          .filter((id): id is string => !!id),
      ),
    ];
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      const base = marked.length ? marked : selected && ids.includes(selected.id) ? [selected.id] : [];
      setMarked(selectInOrder(ids, base, markAnchor.current ?? selected?.id ?? null, thread.id, event));
      if (!event.shiftKey) markAnchor.current = thread.id;
      event.currentTarget.focus();
    } else {
      setMarked([]);
      markAnchor.current = thread.id;
      onOpen?.();
      void openThread(thread);
    }
  }
  return { marked, setMarked, threadList, rowLinks, clickRow };
}
