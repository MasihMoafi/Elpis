"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Pause, Pin, PinOff, Play, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type Track = { title: string; artist: string; uri: string; status: string; canPlay: boolean; canPause: boolean; canNext: boolean };
type Companion = { pinned: boolean; face?: string; favorite: { title: string; uri: string } | null; music: Track | null; reason: string };

/** A page-local presence; it never focuses an input or starts playback on mount. */
export function MatildaCompanion({ page, replying }: { page?: string; replying: boolean }) {
  const [state, setState] = useState<Companion | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0);
  const working = useRef(false);
  const refresh = useCallback(async () => {
    if (!page || working.current) return;
    const request = ++generation.current;
    try {
      const value = await api<Companion>(`/love-spot/companion?page=${encodeURIComponent(page)}`);
      if (request === generation.current) { setState(value); setError(""); }
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : "Matilda could not load."); }
  }, [page]);
  useEffect(() => { working.current = false; setState(null); setBusy(false); setError(""); return () => { generation.current++; }; }, [page]);
  // Refresh after a board command and when returning to the page. No idle polling.
  useEffect(() => { void refresh(); }, [refresh, replying]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    return () => window.removeEventListener("focus", visible);
  }, [refresh]);
  async function act(action: string) {
    if (!page || (working.current && action !== "unpin")) return;
    const request = ++generation.current;
    working.current = true;
    setBusy(true); setError("");
    try {
      const value = await api<Companion>("/love-spot/companion", { action, page });
      if (request === generation.current) setState(value);
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : "The action could not finish."); }
    finally { if (request === generation.current) { working.current = false; setBusy(false); } }
  }
  if (!page) return null;
  const track = state?.music;
  return <div className="absolute bottom-16 right-4 z-[4] max-w-[calc(100%-2rem)] text-foreground" onPointerDown={event => event.stopPropagation()}>
    {state?.pinned ? <section aria-label="Pinned Matilda" className="hud-cut flex max-w-sm flex-wrap items-center gap-2 border border-border bg-background p-2 text-xs">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.face} alt="Matilda" width={40} height={40} className="shrink-0" />
      <div className="min-w-0 flex-1 basis-28">
        <span className="block font-medium">Matilda</span>
        {track?.title && <span className="block truncate text-muted-foreground" title={`${track.title}${track.artist ? ` · ${track.artist}` : ""}`}>{track.title}</span>}
      </div>
      <Button variant="ghost" size="sm" aria-label="Unpin Matilda" onClick={() => void act("unpin")}><PinOff aria-hidden="true" />Unpin</Button>
      {track && <div role="group" aria-label="Music" className="flex w-full flex-wrap items-center gap-1">
        {track.status === "Playing" && track.canPause ? <Button variant="ghost" size="icon-sm" aria-label="Pause music" disabled={busy} onClick={() => void act("pause")}><Pause aria-hidden="true" /></Button> : track.canPlay && <Button variant="ghost" size="icon-sm" aria-label="Resume music" disabled={busy} onClick={() => void act("play")}><Play aria-hidden="true" /></Button>}
        {track.canNext && <Button variant="ghost" size="icon-sm" aria-label="Next track" disabled={busy} onClick={() => void act("next")}><SkipForward aria-hidden="true" /></Button>}
        {state.favorite && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("play-favorite")}><Heart aria-hidden="true" />Play favorite</Button>}
        {track.uri && track.uri !== state.favorite?.uri && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("favorite")}>Remember this</Button>}
      </div>}
      {state.reason && <span className="w-full text-muted-foreground">{state.reason}</span>}
    </section> : <Button variant="outline" size="sm" aria-label="Pin Matilda" disabled={busy} onClick={() => void act("pin")}><Pin aria-hidden="true" />Matilda</Button>}
    {error && <p role="alert" className="mt-2 max-w-sm border border-border bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
