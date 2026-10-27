"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Pause, Pin, PinOff, Play, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { MATILDA_CHANGED } from "@/lib/matilda";

type Track = { title: string; artist: string; uri: string; status: string; canPlay: boolean; canPause: boolean; canNext: boolean };
type Companion = { pinned: boolean; face?: string; favorite: { title: string; uri: string } | null; music: Track | null; reason: string };

/** One compact presence in the shared top bar, independent of the active view. */
export function MatildaCompanion() {
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
  const track = state?.music;
  return <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pr-2">
    {state?.pinned ? <section aria-label="Pinned Matilda" className="flex min-w-0 items-center gap-1">
      <Popover onOpenChange={open => { if (open) void refresh(); }}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label="Matilda controls" title="Matilda · Music" />}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.face} alt="" width={24} height={24} className="shrink-0" /><span className="hidden sm:inline">Matilda</span>
        </PopoverTrigger>
        <PopoverContent align="end" className="space-y-3 p-3">
          <div className="space-y-1 text-sm"><strong className="block">Matilda</strong>{track?.title && <span className="block break-words">{track.title}</span>}{track?.artist && <span className="block break-words text-xs text-muted-foreground">{track.artist}</span>}</div>
          {track && <div role="group" aria-label="Music" className="flex flex-wrap items-center gap-1">
            {track.status === "Playing" && track.canPause ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("pause")}><Pause aria-hidden="true" />Pause</Button> : track.canPlay && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("play")}><Play aria-hidden="true" />Resume</Button>}
            {track.canNext && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("next")}><SkipForward aria-hidden="true" />Next</Button>}
            {state.favorite && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("play-favorite")}><Heart aria-hidden="true" />Play favorite</Button>}
            {track.uri && track.uri !== state.favorite?.uri && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("favorite")}>Remember this</Button>}
          </div>}
          {state.reason && <p className="text-xs text-muted-foreground">{state.reason}</p>}
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="sm" aria-label="Unpin Matilda" title="Unpin Matilda everywhere" onClick={() => void act("unpin")}><PinOff aria-hidden="true" /><span className="hidden sm:inline">Unpin</span></Button>
    </section> : <Button variant="ghost" size="sm" aria-label="Pin Matilda" title="Pin Matilda at the top of every page" disabled={busy} onClick={() => void act("pin")}><Pin aria-hidden="true" />Matilda</Button>}
    {error && <p role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm border border-border bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
