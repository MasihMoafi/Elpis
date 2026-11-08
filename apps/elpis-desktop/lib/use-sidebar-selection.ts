import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { Thread } from "@/lib/api";
import { fitChatListEnd, useWholeRows } from "@/lib/whole-rows";

const fittedLists = new WeakSet<HTMLElement>();

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
  useEffect(() => {
    // keep the chat list's end on a whole row as the window, the rows or their labels change
    const list = threadList.current;
    if (!list || fittedLists.has(list)) return; // the list mounts after the splash
    fittedLists.add(list);
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitChatListEnd(list));
    };
    new ResizeObserver(fit).observe(list);
    new MutationObserver(fit).observe(list, { childList: true, subtree: true, characterData: true });
    fit();
  });
  // Async rows and viewport changes can leave the last chat painted only part way (lib/whole-rows.ts).
  useWholeRows(threadList, ".thread-row", ".thread-row, .section-label-row, .sidebar-group-row, .thread-more");
  /** The sidebar's chat buttons in screen order (a project's chats also appear under Recents). */
  const rowLinks = () => [
    ...(threadList.current?.querySelectorAll<HTMLButtonElement>(".thread-row > .thread-link") ?? []),
  ];
  const rowOf = (element: Element | null) => element?.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  /** A click opens the chat; Ctrl+click marks or unmarks it; Shift+click marks the range from the last click, as in a file manager. */
  function clickRow(thread: Thread, event: React.MouseEvent<HTMLButtonElement>) {
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
    if (event.ctrlKey || event.metaKey) {
      const base = marked.length ? marked : selected && ids.includes(selected.id) ? [selected.id] : [];
      setMarked(base.includes(thread.id) ? base.filter(id => id !== thread.id) : [...base, thread.id]);
      markAnchor.current = thread.id;
    } else if (event.shiftKey) {
      const to = ids.indexOf(thread.id),
        at = ids.indexOf(markAnchor.current ?? selected?.id ?? thread.id),
        from = at < 0 ? to : at;
      setMarked(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
      event.currentTarget.focus();
    } else {
      setMarked([]);
      markAnchor.current = thread.id;
      void openThread(thread);
    }
  }
  return { marked, setMarked, threadList, rowLinks, clickRow };
}
