"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Entry } from "@/lib/api";
import { noticeOf } from "@/lib/workflow-notice";

/** The message box's keyboard basics, as Claude's desktop app has them (read from its source): ↑/↓ step through the
 * messages you sent, Ctrl+R searches them, Esc Esc in an empty box edits the last one, and Esc stops the reply. */

const HINT_DELAY_MS = 6000, DOUBLE_ESCAPE_MS = 800;

/** What the line above the message box says: the place in the history, or the search. */
export type PromptStatus =
  | { kind: "history"; index: number; total: number }
  | { kind: "search"; query: string; failed: boolean; matchIndex: number; total: number; showHints: boolean };

/** The messages you sent in this chat, oldest first. Attached files are not part of what you typed, nor is a workflow's end notice. */
export function promptsOf(entries: Entry[]): string[] {
  const prompts: string[] = [];
  for (const { item } of entries) {
    if (item.type !== "userMessage" || noticeOf(item)) continue;
    const typed = (item.content ?? []).filter(part => part.type === "text" && !attachedFile(part)).map(part => part.text ?? "").join("\n");
    if (typed.trim()) prompts.push(typed);
  }
  return prompts;
}
function attachedFile(part: { text?: string }) {
  const elements = (part as { text_elements?: unknown; textElements?: unknown }).text_elements ?? (part as { textElements?: unknown }).textElements;
  return Array.isArray(elements) && elements.some(element => typeof (element as { placeholder?: unknown })?.placeholder === "string" && (element as { placeholder: string }).placeholder.startsWith("Attachment: "));
}

/** Whether the caret is on the first and on the last visual line of the box; a long line that wraps counts as several.
 * Measured in a hidden copy of the box, with a marker at the caret. */
export function caretLines(box: HTMLTextAreaElement): { first: boolean; last: boolean } {
  const style = getComputedStyle(box), copy = document.createElement("div");
  for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "wordSpacing", "textIndent", "textTransform", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) copy.style[name] = style[name];
  Object.assign(copy.style, { boxSizing: "border-box", width: `${box.clientWidth}px`, position: "absolute", left: "-9999px", top: "0", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", height: "auto" });
  const start = document.createElement("span"), caret = document.createElement("span"), end = document.createElement("span"), at = box.selectionStart ?? 0;
  copy.append(start, box.value.slice(0, at), caret, box.value.slice(at), end);
  document.body.append(copy);
  const result = { first: caret.offsetTop === start.offsetTop, last: caret.offsetTop === end.offsetTop };
  copy.remove();
  return result;
}

/** Whether an Esc key press stops the reply: anywhere in the chat, unless something else owns Esc (a menu, a dialog, a
 * field of its own such as the sidebar search or the terminal). Handlers that used the key have called preventDefault. */
export function stopsOnEscape(event: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (("isComposing" in event && event.isComposing) || event.keyCode === 229) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest('aside, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-label="Terminal"]')) return false;
  if (target?.matches('input, select, textarea, [contenteditable=""], [contenteditable="true"]') && target.getAttribute("aria-label") !== "Message Elpis") return false;
  return !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
}

const isCtrlR = (event: KeyboardEvent) => event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  && (event.key.toLowerCase() === "r" || (event.code === "KeyR" && !/^[a-z]$/i.test(event.key)));

type Wiring = {
  /** The chat's items; the messages you sent in it are the history. */ entries: Entry[];
  box: () => HTMLTextAreaElement | null; read: () => string; write: (text: string, caret: "start" | "end") => void;
  /** Esc Esc in an empty box. */ editLast?: () => void;
};

/** The message box's history keys. Call `onKeyDown` first from the box's own handler (it returns true when it used the
 * key); show `status` above the box. `resetKey` changes with the chat, which ends any stepping or search. */
export function usePromptKeys(resetKey: string, wiring: Wiring) {
  const prompts = useMemo(() => promptsOf(wiring.entries), [wiring.entries]);
  const latest = useRef({ ...wiring, prompts }); latest.current = { ...wiring, prompts };
  const stepping = useRef<{ index: number; draft: string; shown: string; total: number } | null>(null);
  const searching = useRef<{ list: string[]; query: string; index: number; draft: string } | null>(null);
  const armed = useRef<number | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<PromptStatus | null>(null);

  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const showSearch = (state: Omit<Extract<PromptStatus, { kind: "search" }>, "kind" | "showHints">) => {
    clearTimer(); setStatus({ kind: "search", ...state, showHints: false });
    timer.current = setTimeout(() => { timer.current = null; setStatus(previous => previous?.kind === "search" ? { ...previous, showHints: true } : previous); }, HINT_DELAY_MS);
  };
  /** Ends a search: Esc and Backspace on an empty search bring the draft back; anything else keeps the match, caret at its end. */
  const finish = (restore: boolean) => {
    const search = searching.current; searching.current = null; clearTimer(); setStatus(null);
    if (!search) return;
    const { write, box } = latest.current;
    if (restore) write(search.draft, "end");
    else { const target = box(); if (target) target.setSelectionRange(target.value.length, target.value.length); }
  };
  const cancel = useCallback(() => { if (searching.current) finish(false); stepping.current = null; setStatus(previous => previous?.kind === "history" ? null : previous); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stepping.current = null; searching.current = null; armed.current = null; clearTimer(); setStatus(null); return clearTimer; }, [resetKey]);

  const find = (query: string, from: number, step: 1 | -1) => {
    const search = searching.current!, { write } = latest.current, total = search.list.length;
    search.query = query;
    if (!query) { search.index = -1; write(search.draft, "start"); showSearch({ query, failed: false, matchIndex: 0, total }); return; }
    const needle = query.toLowerCase();
    for (let i = from; i >= 0 && i < total; i += step) {
      if (!search.list[i].toLowerCase().includes(needle)) continue;
      search.index = i; write(search.list[i], "start"); showSearch({ query, failed: false, matchIndex: i + 1, total }); return;
    }
    showSearch({ query, failed: true, matchIndex: 0, total });
  };

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const { prompts, box, read, editLast } = latest.current, target = box();
    if (!target) return false;
    const composing = event.nativeEvent.isComposing || event.keyCode === 229, key = event.key;
    const wasArmed = armed.current; armed.current = null;

    const search = searching.current;
    if (search) {
      if (composing || key === "Dead" || key === "Process" || ((event.ctrlKey || event.metaKey) && !event.altKey && ["v", "x"].includes(key.toLowerCase()))) { finish(false); return false; }
      event.preventDefault(); event.stopPropagation();
      if (isCtrlR(event) || key === "ArrowUp") find(search.query, search.index + 1, 1);
      else if (key === "ArrowDown") find(search.query, search.index - 1, -1);
      else if (key === "Escape") finish(true);
      else if (key === "Backspace") { if (!search.query) finish(true); else find(search.query.slice(0, -1), Math.max(search.index, 0), 1); }
      else if (["Enter", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) finish(false);
      else if (key.length === 1 && !event.metaKey && !(event.ctrlKey && !event.altKey)) find(search.query + key, Math.max(search.index, 0), 1);
      return true;
    }

    if (isCtrlR(event) && !composing) {
      event.preventDefault(); event.stopPropagation();
      const seen = new Set<string>();
      const list = prompts.slice().reverse().filter(prompt => !seen.has(prompt) && (seen.add(prompt), true));
      stepping.current = null; searching.current = { list, query: "", index: -1, draft: read() };
      showSearch({ query: "", failed: false, matchIndex: 0, total: list.length });
      return true;
    }

    if (key === "Escape") {
      if (event.repeat || composing || read() || !editLast) return false;
      if (wasArmed !== null && Date.now() - wasArmed <= DOUBLE_ESCAPE_MS) { event.preventDefault(); event.stopPropagation(); editLast(); return true; }
      armed.current = Date.now();
      return false;
    }

    if (key !== "ArrowUp" && key !== "ArrowDown") {
      // Typing over a recalled message ends the stepping; what is in the box stays.
      if (stepping.current && !composing && !event.metaKey && !event.ctrlKey && !event.altKey && (key.length === 1 || ["Backspace", "Delete", "Enter"].includes(key))) { stepping.current = null; setStatus(null); }
      return false;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || composing || target.selectionStart !== target.selectionEnd || !prompts.length) return false;
    const up = key === "ArrowUp", lines = caretLines(target);
    if (!(up ? lines.first : lines.last)) return false;
    // Edited since the last recall, or a new message arrived: stepping starts over.
    if (stepping.current && (stepping.current.shown !== read() || stepping.current.total !== prompts.length)) stepping.current = null;
    if (!stepping.current) {
      if (!up || read().trim()) return false;
      stepping.current = { index: prompts.length, draft: read(), shown: read(), total: prompts.length };
    }
    const here = stepping.current, index = up ? Math.max(0, here.index - 1) : here.index + 1;
    event.preventDefault();
    if (index === here.index) return true;
    if (index >= prompts.length) { latest.current.write(here.draft, "end"); stepping.current = null; setStatus(null); return true; }
    here.index = index; here.shown = prompts[index];
    latest.current.write(prompts[index], "end"); setStatus({ kind: "history", index: index + 1, total: prompts.length });
    return true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { onKeyDown, status, cancel };
}
