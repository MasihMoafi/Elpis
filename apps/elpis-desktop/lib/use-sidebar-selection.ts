import { useRef, useState } from "react";
import type React from "react";
import type { Thread } from "@/lib/api";
import { useSteadyRowList } from "@/lib/whole-rows";

type Inputs = {
  selected: Thread | null;
  openSplit: (thread: Thread) => void;
  openThread: (thread: Thread) => Promise<void>;
};

export function useSidebarSelection({
  selected,
  openSplit,
  openThread,
}: Inputs) {
  /** Chats marked with Ctrl+click or Shift+click in the sidebar; `markAnchor` is where a Shift range starts. */
  const [marked, setMarked] = useState<string[]>([]);
  const markAnchor = useRef<string | null>(null);
  const threadList = useRef<HTMLDivElement>(null);
  useSteadyRowList(
    threadList,
    ".thread-row, .project-row, .section-label-row, .sidebar-group-row, .thread-more",
  );
  /** The sidebar's chat buttons in screen order (a project's chats also appear under Recents). */
  const rowLinks = () => [
    ...(threadList.current?.querySelectorAll<HTMLButtonElement>(
      ".thread-row > .thread-link",
    ) ?? []),
  ];
  const rowOf = (element: Element | null) =>
    element?.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  /** A click opens the chat; Ctrl+click marks or unmarks it; Shift+click marks the range from the last click, as in a file manager. */
  function clickRow(
    thread: Thread,
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
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
      const base = marked.length
        ? marked
        : selected && ids.includes(selected.id)
          ? [selected.id]
          : [];
      setMarked(
        base.includes(thread.id)
          ? base.filter((id) => id !== thread.id)
          : [...base, thread.id],
      );
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
