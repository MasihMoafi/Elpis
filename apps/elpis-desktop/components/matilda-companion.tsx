"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { PinIcon } from "@/components/elpis-icons";
import { MatildaMiniChat, useMatildaMiniChat } from "@/components/matilda-mini-chat";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { MATILDA_CHANGED } from "@/lib/matilda";
import { appStorage } from "@/lib/projects";

type Track = { title: string; artist: string; uri: string; status: string; canPlay: boolean; canPause: boolean; canNext: boolean; muted: boolean; canMute: boolean };
type Companion = { pinned: boolean; face?: string; favorite: { title: string; uri: string; artist?: string } | null; threadId?: string | null; music: Track | null; reason: string };

/** One compact presence in the shared top bar, independent of the active view. */
const POSITION_KEY = "elpis-matilda-position-v1";
function savedPosition() {
  try { const p = JSON.parse(appStorage().getItem(POSITION_KEY) || "null"); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x as number, y: p.y as number }; } catch {}
  return { x: 0, y: 0 };
}
export function MatildaCompanion() {
  const [state, setState] = useState<Companion | null>(null);
  const [chatOpen, setChatOpen] = useState(false), mini = useMatildaMiniChat(chatOpen);
  const suppressClick = useRef(false);
  useEffect(() => { if (!state?.pinned) setChatOpen(false); }, [state?.pinned]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), working = useRef(false);
  const refresh = useCallback(async () => {
    if (working.current) return;
    const request = ++generation.current;
    try {
      const value = await api<Companion>("/love-spot/companion?page=global");
      if (request === generation.current) { setState(value); setError(""); }
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : "Matilda could not load."); }
  }, []);
  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    window.addEventListener(MATILDA_CHANGED, visible);
    return () => { generation.current++; window.removeEventListener("focus", visible); window.removeEventListener(MATILDA_CHANGED, visible); };
  }, [refresh]);
  async function act(action: string) {
    if (working.current && action !== "unpin") return;
    const request = ++generation.current;
    working.current = true; setBusy(true); setError("");
    try {
      const value = await api<Companion>("/love-spot/companion", { action, page: "global" });
      if (request === generation.current) setState(value);
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : "The action could not finish."); }
    finally { if (request === generation.current) { working.current = false; setBusy(false); } }
  }
  const [position, setPosition] = useState(savedPosition);
  const positionRef = useRef(position); positionRef.current = position;
  const widget = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; position: { x: number; y: number }; moved: boolean } | null>(null);
  const move = (x: number, y: number) => {
    const bounds = widget.current?.getBoundingClientRect(); if (!bounds) return;
    const current = positionRef.current;
    const left = Math.min(Math.max(0, bounds.x + x), Math.max(0, innerWidth - bounds.width));
    let top = Math.min(Math.max(0, bounds.y + y), Math.max(0, innerHeight - bounds.height));
    // Native browser pages sit above the app renderer. Keep the controls in the visible strip above them.
    for (const element of document.querySelectorAll(".browser-viewport")) {
      const browser = element.getBoundingClientRect();
      if (browser.width && browser.height && left < browser.right && left + bounds.width > browser.left && top < browser.bottom && top + bounds.height > browser.top) top = Math.max(0, browser.top - bounds.height - 4);
    }
    const next = { x: Math.round(current.x + left - bounds.x), y: Math.round(current.y + top - bounds.y) };
    if (next.x === current.x && next.y === current.y) return;
    positionRef.current = next; setPosition(next);
  };
  const savePosition = async () => {
    try {
      const value = JSON.stringify(positionRef.current), storage = window.elpisDesktop?.storage;
      if (storage?.saveItem) await storage.saveItem(POSITION_KEY, value);
      else appStorage().setItem(POSITION_KEY, value);
    } catch { setError("Matilda's position could not be saved."); }
  };
  useLayoutEffect(() => { if (state?.pinned) move(0, 0); }, [state?.pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const resized = () => move(0, 0); window.addEventListener("resize", resized); return () => window.removeEventListener("resize", resized); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!state?.pinned) return;
    let panes: Element[] = [];
    const resized = new ResizeObserver(() => move(0, 0));
    const discover = () => {
      const next = [...document.querySelectorAll(".browser-viewport")];
      if (next.length === panes.length && next.every((pane, i) => pane === panes[i])) return;
      panes = next; resized.disconnect(); panes.forEach(pane => resized.observe(pane)); move(0, 0);
    };
    const changed = new MutationObserver(discover); changed.observe(document.body, { childList: true, subtree: true }); discover();
    return () => { changed.disconnect(); resized.disconnect(); };
  }, [state?.pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const capture = window.elpisDesktop?.screenCapture;
    if (!capture) return;
    void capture.setSession(state?.pinned ? state.threadId ?? null : null).catch(cause => setError(cause instanceof Error ? cause.message : "Page capture could not connect."));
    return () => { void capture.setSession(null).catch(() => {}); };
  }, [state?.pinned, state?.threadId]);
  const track = state?.music;
  return <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pr-2">
    {state?.pinned ? <section ref={widget} aria-label="Pinned Matilda" className="relative z-40 flex min-w-0 items-center gap-1" style={{ transform: `translate(${position.x}px, ${position.y}px)`, WebkitAppRegion: "no-drag" } as CSSProperties}>
      <Popover open={chatOpen} onOpenChange={open => { if (!suppressClick.current) setChatOpen(open); }}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Chat with Matilda" title="Chat with Matilda · drag to move" style={{ touchAction: "none" }}
          onPointerDown={event => { if (event.button !== 0 || !widget.current) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, position: positionRef.current, moved: false }; }}
          onPointerMove={event => { const start = drag.current; if (!start) return; const dx = event.clientX - start.x, dy = event.clientY - start.y; if (Math.hypot(dx, dy) >= 4) start.moved = true; if (start.moved) { event.stopPropagation(); move(start.position.x + dx - positionRef.current.x, start.position.y + dy - positionRef.current.y); } }}
          onPointerUp={() => { const start = drag.current; drag.current = null; if (start?.moved) { suppressClick.current = true; void savePosition(); } }}
          onClick={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); requestAnimationFrame(() => { suppressClick.current = false; }); } }}
          onPointerCancel={() => { const start = drag.current; drag.current = null; if (start) { positionRef.current = start.position; setPosition(start.position); } }}
          onKeyDown={event => { const delta: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }; const step = delta[event.key]; if (step) { event.preventDefault(); event.stopPropagation(); move(step[0] * (event.shiftKey ? 3 : 1), step[1] * (event.shiftKey ? 3 : 1)); void savePosition(); } }} />}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.face} alt="Matilda" width={24} height={24} draggable={false} className="shrink-0 select-none" />
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="matilda-mini-popup"><MatildaMiniChat chat={mini} /></PopoverContent>
      </Popover>
      {track?.canMute && <Button variant="ghost" size="sm" className="px-2" aria-label={track.muted ? "Unmute music" : "Mute music"} aria-pressed={track.muted} title={track.muted ? "Unmute music" : "Mute music"} disabled={busy} onClick={() => void act("toggle-mute")}>{track.muted ? "Unmute" : "Mute"}</Button>}
      <Button variant="ghost" size="icon-xs" aria-label="Unpin Matilda" title="Unpin Matilda" aria-pressed="true" onClick={() => void act("unpin")}><PinIcon size={16} /></Button>
    </section> : <Button variant="ghost" size="sm" className="px-1 sm:px-2" aria-label="Pin Matilda" title="Pin Matilda" disabled={busy} onClick={() => void act("pin")}><PinIcon size={16} className="hidden sm:block" />Matilda</Button>}
    {error && <p role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm border border-border bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
