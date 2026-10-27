"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Heart, MessageCircle, Music2, Pause, Pin, PinOff, Play, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { MATILDA_CHANGED } from "@/lib/matilda";
import { appStorage } from "@/lib/projects";

type Track = { title: string; artist: string; uri: string; status: string; canPlay: boolean; canPause: boolean; canNext: boolean };
type Companion = { pinned: boolean; face?: string; favorite: { title: string; uri: string; artist?: string } | null; threadId?: string | null; music: Track | null; reason: string };

/** One compact presence in the shared top bar, independent of the active view. */
const POSITION_KEY = "elpis-matilda-position-v1";
function savedPosition() {
  try { const p = JSON.parse(appStorage().getItem(POSITION_KEY) || "null"); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x as number, y: p.y as number }; } catch {}
  return { x: 0, y: 0 };
}
export function MatildaCompanion({ onChat }: { onChat?: (id: string | null) => void } = {}) {
  const [state, setState] = useState<Companion | null>(null);
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
  const drag = useRef<{ x: number; y: number; position: { x: number; y: number } } | null>(null);
  const move = (x: number, y: number) => {
    const bounds = widget.current?.getBoundingClientRect(); if (!bounds) return;
    const current = positionRef.current;
    const next = { x: Math.round(current.x + Math.min(Math.max(0, bounds.x + x), Math.max(0, innerWidth - bounds.width)) - bounds.x), y: Math.round(current.y + Math.min(Math.max(0, bounds.y + y), Math.max(0, innerHeight - bounds.height)) - bounds.y) };
    positionRef.current = next; setPosition(next);
  };
  const savePosition = () => { try { appStorage().setItem(POSITION_KEY, JSON.stringify(positionRef.current)); } catch { setError("Matilda's position could not be saved."); } };
  useLayoutEffect(() => { if (state?.pinned) move(0, 0); }, [state?.pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const resized = () => move(0, 0); window.addEventListener("resize", resized); return () => window.removeEventListener("resize", resized); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const track = state?.music;
  const artist = state?.favorite?.uri === track?.uri ? state?.favorite?.artist || track?.artist : track?.artist;
  return <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pr-2">
    {state?.pinned ? <section ref={widget} aria-label="Pinned Matilda" className="relative z-40 flex min-w-0 items-center gap-1" style={{ transform: `translate(${position.x}px, ${position.y}px)`, WebkitAppRegion: "no-drag" } as CSSProperties}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.face} alt="Matilda" width={24} height={24} draggable={false} tabIndex={0} title="Drag Matilda to move; arrow keys move when focused" className="shrink-0 cursor-grab select-none active:cursor-grabbing" style={{ touchAction: "none" }}
        onPointerDown={event => { if (event.button !== 0 || !widget.current) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, position: positionRef.current }; }}
        onPointerMove={event => { if (!drag.current) return; event.stopPropagation(); const start = drag.current; move(start.position.x + event.clientX - start.x - positionRef.current.x, start.position.y + event.clientY - start.y - positionRef.current.y); }}
        onPointerUp={() => { if (drag.current) { drag.current = null; savePosition(); } }}
        onPointerCancel={() => { const start = drag.current; drag.current = null; if (start) { positionRef.current = start.position; setPosition(start.position); } }}
        onKeyDown={event => { const delta: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }; const step = delta[event.key]; if (step) { event.preventDefault(); event.stopPropagation(); move(step[0] * (event.shiftKey ? 3 : 1), step[1] * (event.shiftKey ? 3 : 1)); savePosition(); } }} />
      <Popover onOpenChange={open => { if (open) void refresh(); }}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Music controls" title="Music" />}><Music2 aria-hidden="true" /></PopoverTrigger>
        <PopoverContent align="end" className="grid h-44 w-80 grid-rows-[auto_1fr_auto] gap-2 p-3">
          <strong className="block text-sm">Music</strong>
          <div className="min-h-0 text-sm">{track?.title && <span className="line-clamp-2 block break-words">{track.title}</span>}<span className="block min-h-4 text-xs text-muted-foreground">{artist}</span>{state.reason && <p className="text-xs text-muted-foreground">{state.reason}</p>}</div>
          <div role="group" aria-label="Music" className="flex h-8 items-center gap-1">
            {track && <>
              {track.status === "Playing" && track.canPause ? <Button variant="ghost" size="icon-sm" aria-label="Pause music" title="Pause" disabled={busy} onClick={() => void act("pause")}><Pause aria-hidden="true" /></Button> : track.canPlay && <Button variant="ghost" size="icon-sm" aria-label="Resume music" title="Resume" disabled={busy} onClick={() => void act("play")}><Play aria-hidden="true" /></Button>}
              {track.canNext && <Button variant="ghost" size="icon-sm" aria-label="Next track" title="Next track" disabled={busy} onClick={() => void act("next")}><SkipForward aria-hidden="true" /></Button>}
              {state.favorite && <Button variant="ghost" size="icon-sm" aria-label="Play favorite" title="Play favorite" disabled={busy} onClick={() => void act("play-favorite")}><Heart aria-hidden="true" /></Button>}
              {track.uri && track.uri !== state.favorite?.uri && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("favorite")}>Remember this</Button>}
            </>}
          </div>
        </PopoverContent>
      </Popover>
      {onChat && <Button variant="ghost" size="icon-xs" aria-label="Chat with Matilda" title="Chat with Matilda" onClick={() => onChat(state.threadId ?? null)}><MessageCircle aria-hidden="true" /></Button>}
      <Button variant="ghost" size="icon-xs" aria-label="Unpin Matilda" title="Unpin Matilda everywhere" onClick={() => void act("unpin")}><PinOff aria-hidden="true" /></Button>
    </section> : <Button variant="ghost" size="sm" className="px-1 sm:px-2" aria-label="Pin Matilda" title="Pin Matilda at the top of every page" disabled={busy} onClick={() => void act("pin")}><Pin aria-hidden="true" className="hidden sm:block" />Matilda</Button>}
    {error && <p role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm border border-border bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
