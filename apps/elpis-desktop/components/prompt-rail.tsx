"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { api, type Entry } from "@/lib/api";

type Prompt = { turnId: string; text: string };
type PromptList = { threadId: string; data: Prompt[] };
const firstLine = (text: string) => text.trim().split(/\r?\n/, 1)[0] || "Prompt";
const labelOf = (text: string) => { const line = firstLine(text); return line.length > 80 ? `${line.slice(0, 79)}…` : line; };

/** The complete prompt index comes from the bridge; rendered turns supply positions for reading and scrolling. */
export function PromptRail({ scroller, threadId, entries, hasEarlier, loading, onLoadEarlier, onNavigate }: {
  scroller: RefObject<HTMLElement | null>;
  /** Called before a jump, so the transcript stops following the newest message (it would pull the view back down). */
  onNavigate: () => void;
  threadId: string | null;
  entries: Entry[];
  hasEarlier: boolean;
  loading: boolean;
  onLoadEarlier: (untilTurnId?: string) => Promise<boolean>;
}) {
  const [indexed, setIndexed] = useState<PromptList | null>(null);
  const [loaded, setLoaded] = useState<PromptList | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const elements = useRef(new Map<string, HTMLElement>());
  const loadedOrder = useRef<string[]>([]);
  const pending = useRef<string | null>(null);
  const frame = useRef(0);
  const marks = useRef<HTMLDivElement>(null);

  const goTo = (turnId: string) => {
    const root = scroller.current, element = elements.current.get(turnId);
    if (!root || !element) return false;
    onNavigate();
    root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 16, behavior: "smooth" });
    setCurrent(turnId);
    return true;
  };
  const place = () => {
    const root = scroller.current, list = loadedOrder.current;
    if (!root || !list.length) return;
    const top = root.getBoundingClientRect().top, bottom = root.scrollHeight - root.scrollTop - root.clientHeight < 4;
    let turnId = list[0];
    list.forEach(id => { if (elements.current.get(id)!.getBoundingClientRect().top - top <= root.clientHeight / 3) turnId = id; });
    setCurrent(bottom ? list[list.length - 1] : turnId);
  };
  const read = () => {
    const root = scroller.current;
    if (!root || !threadId) return;
    const ids = [...new Set(entries.filter(entry => entry.item.type === "userMessage").map(entry => entry.turnId))];
    const sections = [...root.querySelectorAll<HTMLElement>("section.turn[data-prompt]")];
    const found = sections.map((element, index) => ({ element, turnId: ids[index], text: (element.querySelector(".message.user:not(.editing)")?.textContent ?? "").trim() })).filter(prompt => !!prompt.turnId);
    elements.current = new Map(found.map(prompt => [prompt.turnId, prompt.element]));
    loadedOrder.current = found.map(prompt => prompt.turnId);
    const data = found.map(({ turnId, text }) => ({ turnId, text }));
    setLoaded(previous => previous?.threadId === threadId && previous.data.length === data.length && previous.data.every((prompt, index) => prompt.turnId === data[index].turnId && prompt.text === data[index].text) ? previous : { threadId, data });
    place();
    if (pending.current && elements.current.has(pending.current)) {
      const target = pending.current;
      pending.current = null;
      requestAnimationFrame(() => goTo(target));
    }
  };

  const lastUser = entries.filter(entry => entry.item.type === "userMessage").at(-1);
  const revision = `${lastUser?.turnId ?? ""}:${lastUser?.clientPending ? "pending" : "saved"}`;
  useEffect(() => { elements.current.clear(); loadedOrder.current = []; pending.current = null; setCurrent(null); setOpen(false); }, [threadId]);
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void api<{ data: Prompt[] }>(`/threads/${encodeURIComponent(threadId)}/prompts`).then(result => {
      // A reply of another shape (an older bridge) is ignored, as a failed read is.
      if (!cancelled && Array.isArray(result.data) && result.data.every(row => typeof row?.turnId === "string" && typeof row?.text === "string")) setIndexed({ threadId, data: result.data });
    }).catch(() => { /* The rendered turns remain available if the prompt index cannot be read. */ });
    return () => { cancelled = true; };
  }, [threadId, revision]);
  useEffect(read, [threadId, entries]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = scroller.current; if (!root) return;
    const onScroll = () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(place); };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame.current); };
  }, [scroller]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { marks.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }); }, [current, indexed]);

  const loadedPrompts = loaded?.threadId === threadId ? loaded.data : [];
  const indexedPrompts = indexed?.threadId === threadId ? indexed.data : [];
  const indexedIds = new Set(indexedPrompts.map(prompt => prompt.turnId));
  const prompts = indexed?.threadId === threadId ? [...indexedPrompts, ...loadedPrompts.filter(prompt => !indexedIds.has(prompt.turnId))] : loadedPrompts;
  if (prompts.length < 2) return null;

  const select = (turnId: string) => {
    setOpen(false);
    if (goTo(turnId)) return;
    pending.current = turnId;
    void onLoadEarlier(turnId).then(found => { if (!found && pending.current === turnId) pending.current = null; });
  };
  return <nav className="prompt-rail" aria-label="Prompts" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocusCapture={() => setOpen(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); (event.target as HTMLElement).blur(); setOpen(false); } }}>
    <div ref={marks} className="prompt-rail-marks">
      {prompts.map(prompt => <button data-slot="prompt-mark" key={prompt.turnId} type="button" className="prompt-tick" aria-label={`Go to prompt: ${labelOf(prompt.text)}`} aria-current={prompt.turnId === current ? "true" : undefined} onClick={() => select(prompt.turnId)}><i /></button>)}
    </div>
    {open && <nav className="prompt-panel rounded-box border border-border bg-base-100 p-1 text-base-content shadow-lg" aria-label="Prompt list">
      <ul className="menu menu-sm w-full min-w-0">
        {hasEarlier && <li><button type="button" disabled={loading} onClick={() => void onLoadEarlier()}>Load earlier messages</button></li>}
        {prompts.map(prompt => <li key={prompt.turnId}><button data-slot="prompt-row" type="button" className={`w-full min-w-0 text-left ${prompt.turnId === current ? "bg-accent font-medium" : ""}`} aria-current={prompt.turnId === current ? "true" : undefined} onClick={() => select(prompt.turnId)}><span className="block min-w-0 truncate">{firstLine(prompt.text)}</span></button></li>)}
      </ul>
    </nav>}
  </nav>;
}
