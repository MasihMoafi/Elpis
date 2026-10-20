"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Bookmark } from "lucide-react";
import { api, type Entry } from "@/lib/api";

type Prompt = { turnId: string; text: string; reply?: string };
type PromptList = { threadId: string; data: Prompt[] };
type IndexState = { threadId: string; status: "loading" | "ready" | "error" };
type Hovered = { turnId: string; top: number };
const firstLine = (text: string) => text.trim().split(/\r?\n/, 1)[0] || "(No content)";
const isPrompt = (row: unknown): row is Prompt => {
  if (typeof row !== "object" || row === null) return false;
  const value = row as Record<string, unknown>;
  return typeof value.turnId === "string" && typeof value.text === "string" && (value.reply === undefined || typeof value.reply === "string");
};

/** The bridge indexes every prompt; rendered turns supply positions for reading and scrolling. */
export function PromptRail({ scroller, threadId, entries, onLoadEarlier, onNavigate }: {
  scroller: RefObject<HTMLElement | null>;
  /** Called before a jump, so the transcript stops following the newest message. */
  onNavigate: () => void;
  threadId: string | null;
  entries: Entry[];
  onLoadEarlier: (untilTurnId?: string) => Promise<boolean>;
}) {
  const [indexed, setIndexed] = useState<PromptList | null>(null);
  const [indexState, setIndexState] = useState<IndexState | null>(null);
  const [loaded, setLoaded] = useState<PromptList | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [saved, setSaved] = useState<{ threadId: string; ids: Set<string> } | null>(null);
  const previewId = useId();
  const rail = useRef<HTMLElement>(null);
  const marks = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const loadedOrder = useRef<string[]>([]);
  const pending = useRef<string | null>(null);
  const frame = useRef(0);

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
  const show = (turnId: string, button: HTMLButtonElement) => {
    if (!rail.current) return;
    const rect = button.getBoundingClientRect();
    setHovered({ turnId, top: (rect.top + rect.bottom) / 2 - rail.current.getBoundingClientRect().top });
  };

  const lastUser = entries.filter(entry => entry.item.type === "userMessage").at(-1);
  const revision = (lastUser?.turnId ?? "") + ":" + (lastUser?.clientPending ? "pending" : "saved");
  useEffect(() => {
    elements.current.clear(); loadedOrder.current = []; pending.current = null;
    setCurrent(null); setHovered(null);
    if (!threadId) return;
    try {
      const stored = JSON.parse(localStorage.getItem("elpis:prompt-rail-bookmarks:" + threadId) ?? "[]");
      setSaved({ threadId, ids: new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []) });
    } catch { setSaved({ threadId, ids: new Set() }); }
  }, [threadId]);
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setIndexState({ threadId, status: "loading" });
    void api<{ data: unknown }>("/threads/" + encodeURIComponent(threadId) + "/prompts").then(result => {
      if (cancelled) return;
      if (!Array.isArray(result.data) || !result.data.every(isPrompt)) throw new Error("Unreadable prompt index");
      setIndexed({ threadId, data: result.data });
      setIndexState({ threadId, status: "ready" });
    }).catch(() => { if (!cancelled) setIndexState({ threadId, status: "error" }); });
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
  const bookmarks = saved?.threadId === threadId ? saved.ids : new Set<string>();
  const preview = hovered && prompts.find(prompt => prompt.turnId === hovered.turnId);
  const reply = preview && indexedPrompts.find(prompt => prompt.turnId === preview.turnId)?.reply;
  const previewUnavailable = indexState?.threadId === threadId && indexState.status !== "loading";
  const activeIndex = hovered ? prompts.findIndex(prompt => prompt.turnId === hovered.turnId) : -1;
  if (prompts.length < 2) return null;

  const select = (turnId: string) => {
    if (goTo(turnId)) return;
    pending.current = turnId;
    void onLoadEarlier(turnId).then(found => { if (!found && pending.current === turnId) pending.current = null; });
  };
  const toggleBookmark = (turnId: string) => {
    if (!threadId) return;
    const ids = new Set(bookmarks);
    if (ids.has(turnId)) ids.delete(turnId); else ids.add(turnId);
    setSaved({ threadId, ids });
    try { localStorage.setItem("elpis:prompt-rail-bookmarks:" + threadId, JSON.stringify([...ids])); } catch { /* The current chat still reflects the choice. */ }
  };
  return <nav ref={rail} className="prompt-rail" aria-label="User messages" data-indexed={indexedPrompts.length >= 2}
    onMouseLeave={() => { if (!rail.current?.contains(document.activeElement)) setHovered(null); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(null); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); (event.target as HTMLElement).blur(); setHovered(null); } }}>
    <div ref={marks} className="prompt-rail-marks">
      {prompts.map((prompt, index) => {
        const distance = activeIndex < 0 ? -1 : Math.abs(index - activeIndex);
        const bookmarked = bookmarks.has(prompt.turnId);
        return <button data-slot="prompt-mark" data-distance={distance >= 0 && distance <= 3 ? distance : undefined} data-bookmarked={bookmarked || undefined}
          key={prompt.turnId} type="button" className="prompt-tick"
          aria-label={"Jump to user message " + (index + 1) + (bookmarked ? ", bookmarked turn" : "")}
          aria-current={prompt.turnId === current ? "true" : undefined}
          aria-describedby={hovered?.turnId === prompt.turnId ? previewId : undefined}
          onMouseEnter={event => show(prompt.turnId, event.currentTarget)}
          onFocus={event => show(prompt.turnId, event.currentTarget)}
          onClick={() => select(prompt.turnId)}><i aria-hidden="true" /></button>;
      })}
    </div>
    {preview && <div id={previewId} className="prompt-preview card card-border rounded-box border border-border bg-base-100 text-base-content shadow-lg" style={{ top: hovered.top }}>
      <div className="prompt-preview-heading">
        <span data-preview-text className="prompt-preview-title truncate font-medium">{firstLine(preview.text)}</span>
        <button type="button" className="prompt-bookmark btn btn-ghost btn-square btn-xs" aria-label={bookmarks.has(preview.turnId) ? "Remove bookmark" : "Bookmark turn"}
          aria-pressed={bookmarks.has(preview.turnId)}
          onClick={event => { event.stopPropagation(); toggleBookmark(preview.turnId); }}>
          <Bookmark size={16} fill={bookmarks.has(preview.turnId) ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      </div>
      {typeof reply === "string" ? <p data-preview-text className="prompt-preview-reply text-muted-foreground">{reply.trim() || "(No content)"}</p>
        : previewUnavailable
          ? <p data-preview-text className="prompt-preview-reply text-muted-foreground">Preview unavailable</p>
          : <div className="prompt-preview-skeleton animate-pulse" role="status"><span className="sr-only">Loading preview</span><i className="skeleton" aria-hidden="true" /><i className="skeleton" aria-hidden="true" /><i className="skeleton" aria-hidden="true" /></div>}
    </div>}
  </nav>;
}
