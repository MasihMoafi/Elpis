"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { OptionList } from "@/components/slash-menu";
import { api, title, type Thread } from "@/lib/api";
import { insertMention, mentionAt, rankMentions, type Mention, type MentionItem } from "@/lib/mentions";

const MENU_ID = "mention-menu";

/** The @ picker above the message box, as in Claude's desktop app: the project's files and the person's other chats,
 * narrowed as they type. ↑↓ move, Enter or Tab insert "@name", Escape closes; the choice goes to `onPick` with the
 * mention the message will carry. Files come from the bridge once per folder and window. */
export function useMentionMenu({ text, caret, cwd, threads, currentId, onPick }: {
  text: string; caret: number; cwd?: string; threads: Thread[]; currentId?: string;
  onPick: (result: { text: string; caret: number; mention: Mention }) => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const [listing, setListing] = useState<{ cwd: string; files: string[] } | null>(null);
  if (dismissed !== null && dismissed !== text) setDismissed(null);
  const at = mentionAt(text, Math.min(caret, text.length));
  const asking = at !== null;
  useEffect(() => {
    if (!asking || !cwd || listing?.cwd === cwd) return;
    let current = true;
    api<{ data: string[] }>(`/files?cwd=${encodeURIComponent(cwd)}`).then(result => current && setListing({ cwd, files: result.data }), () => current && setListing({ cwd, files: [] }));
    return () => { current = false; };
  }, [asking, cwd, listing?.cwd]);
  const root = (cwd ?? "").replace(/\/+$/, "");
  const files: MentionItem[] = listing && listing.cwd === cwd ? listing.files.map(name => ({ kind: "file", name, detail: "File", path: `${root}/${name}` })) : [];
  const chats: MentionItem[] = threads.filter(thread => thread.id !== currentId && !thread.parentThreadId).map(thread => ({ kind: "chat", name: title(thread), detail: "Chat", path: `thread://${thread.id}` }));
  const matches = at && dismissed !== text ? rankMentions([...files, ...chats], at.query) : [];
  const open = matches.length > 0;
  const active = cursor.query === at?.query ? Math.min(cursor.index, matches.length - 1) : 0;
  const select = (index: number) => setCursor({ query: at?.query ?? "", index });
  function choose(item: MentionItem) {
    if (!at) return;
    setDismissed(null);
    onPick({ ...insertMention(text, at.start, Math.min(caret, text.length), item.name), mention: { name: item.name, path: item.path } });
  }
  /** Handles the key while the list is open; true when the message box should not handle it too. */
  function onKeyDown(event: KeyboardEvent) {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") select((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") choose(matches[active]);
    else if (event.key === "Escape") setDismissed(text);
    else return false;
    event.preventDefault(); return true;
  }
  return { open, matches, active, select, choose, onKeyDown, close: () => setDismissed(text),
    inputProps: { "aria-autocomplete": "list" as const, "aria-controls": open ? MENU_ID : undefined, "aria-activedescendant": open ? `${MENU_ID}-${active}` : undefined } };
}

export function MentionMenu({ menu }: { menu: ReturnType<typeof useMentionMenu> }) {
  if (!menu.open) return null;
  return <OptionList kind id={MENU_ID} label="Mentions" options={menu.matches.map((item, index) => ({ key: String(index), name: item.name, description: item.detail }))}
    active={menu.active} onHover={menu.select} onPick={index => menu.choose(menu.matches[index])} />;
}
