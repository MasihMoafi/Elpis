"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { PinIcon, SoundIcon, SoundOffIcon } from "@/components/elpis-icons";
import { MatildaMiniChat, useMatildaMiniChat } from "@/components/matilda-mini-chat";
import { MatildaHeartBurst } from "@/components/matilda-heart-burst";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { MATILDA_CHANGED, MATILDA_CHAT_SHOWN } from "@/lib/matilda";
import { appStorage } from "@/lib/projects";
import { MATILDA_SHOTS, MATILDA_SHOTS_LIGHT } from "@/bridge/matilda-face.cjs";

type Track = { title: string; artist: string; uri: string; status: string; canPlay: boolean; canPause: boolean; canNext: boolean; muted: boolean; canMute: boolean };
type Companion = { pinned: boolean; face?: string; favorite: { title: string; uri: string; artist?: string } | null; threadId?: string | null; music: Track | null; reason: string };

/** Pinned, she floats over the app (28 Oct: "I don't like this to be here", in the title bar): drag her face to move her,
 * her corner to resize her, like Dot. Where and how big are saved as distances from the window's bottom right. */
const FLOAT_KEY = "elpis-matilda-float-v1";
type Place = { right: number; bottom: number; size: number };
const SIZE = { min: 40, max: 256, step: 8 };
const sized = (size: number) => Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size)));
function savedPlace(): Place {
  try { const p = JSON.parse(appStorage().getItem(FLOAT_KEY) || "null"); if (p && [p.right, p.bottom, p.size].every(Number.isFinite)) return { right: p.right, bottom: p.bottom, size: sized(p.size) }; } catch {}
  // In the corner, clear of the side panel's Done button and the composer's send button.
  return { right: 16, bottom: 16, size: 64 };
}
/** The window's own chrome: she and her chat stay below the title bar, where Electron moves the window instead. */
const chromeBottom = () => typeof document === "undefined" ? 0 : Math.ceil(document.querySelector(".title-bar")?.getBoundingClientRect().bottom ?? 0);
type Mood = Exclude<keyof typeof MATILDA_SHOTS, "listening">;
const MOODS = Object.keys(MATILDA_SHOTS).filter(name => name !== "listening") as Mood[];
const stillness = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Her resting face is "listening"; the others fade in when they fit (28 Oct, Masih chose them): her smile while she
 * replies, a warm tilted smile while hovered, a soft smile for 3 s after her reply, and now and then a wink. Never with
 * reduced motion. */
function useMood(replying: boolean, replies: number) {
  const [replied, setReplied] = useState(false), [hovered, setHovered] = useState(false), [winking, setWinking] = useState(false), seen = useRef(replies);
  useEffect(() => {
    if (replies <= seen.current) { seen.current = replies; return; }
    seen.current = replies; setReplied(true);
    const timer = window.setTimeout(() => setReplied(false), 3000); return () => window.clearTimeout(timer);
  }, [replies]);
  useEffect(() => {
    if (stillness()) return;
    let timer = 0;
    const next = () => { timer = window.setTimeout(() => { setWinking(true); timer = window.setTimeout(() => { setWinking(false); next(); }, 1400); }, 25000 + Math.random() * 20000); };
    next(); return () => window.clearTimeout(timer);
  }, []);
  const mood: Mood | null = replying ? "smile" : hovered ? "tiltSmile" : replied ? "softSmile" : winking ? "wink" : null;
  return { shown: stillness() ? null : mood, setHovered };
}
export function MatildaCompanion() {
  const [state, setState] = useState<Companion | null>(null);
  const [chatOpen, setChatOpen] = useState(false), mini = useMatildaMiniChat(chatOpen);
  const mood = useMood(mini.posting || mini.conversation.busy, mini.conversation.entries.filter(entry => entry.item.type === "agentMessage").length);
  const suppressClick = useRef(false), faceRef = useRef<HTMLButtonElement>(null), floatRef = useRef<HTMLElement>(null);
  useEffect(() => { if (!state?.pinned) setChatOpen(false); }, [state?.pinned]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(MATILDA_CHAT_SHOWN, { detail: chatOpen }));
    return () => { if (chatOpen) window.dispatchEvent(new CustomEvent(MATILDA_CHAT_SHOWN, { detail: false })); };
  }, [chatOpen]);
  // Her chat is part of her, like a pet's (29 Oct: dragging her "broke" the chatbox, which trailed and jumped as a separate
  // popover). Escape closes it and gives her the focus back; a press anywhere else closes it.
  useEffect(() => {
    if (!chatOpen) return;
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setChatOpen(false); faceRef.current?.focus(); } };
    const press = (event: globalThis.PointerEvent) => { if (!floatRef.current?.contains(event.target as Node)) setChatOpen(false); };
    document.addEventListener("keydown", key); document.addEventListener("pointerdown", press, true);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", press, true); };
  }, [chatOpen]);
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
  // `place` is where she was put, and is what is saved. `shown` fits it to the window and keeps her off native browser
  // pages (they sit above the app renderer); fitting never rewrites `place`, so she goes back to it when there is room.
  const [place, setPlace] = useState(savedPlace), [shown, setShown] = useState({ left: 0, top: 0 });
  const placeRef = useRef(place); placeRef.current = place;
  const shownRef = useRef(shown);
  const drag = useRef<{ x: number; y: number; left: number; top: number; size: number; resize: boolean; moved: boolean } | null>(null);
  // While she is held her chat keeps the side it opened on, so it moves with her instead of jumping across her.
  const [heldSide, setHeldSide] = useState<"top" | "bottom" | null>(null);
  const fit = () => {
    const { right, bottom, size } = placeRef.current;
    const whole = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), Math.max(min, Math.floor(max)));
    const chrome = chromeBottom();
    let left = whole(innerWidth - right - size, 0, innerWidth - size), top = whole(innerHeight - bottom - size, chrome, innerHeight - size);
    for (const element of document.querySelectorAll(".browser-viewport")) {
      const pane = element.getBoundingClientRect();
      if (!pane.width || !pane.height || left >= pane.right || left + size <= pane.left || top >= pane.bottom || top + size <= pane.top) continue;
      if (pane.top - size - 4 >= chrome) top = Math.floor(pane.top - size - 4); else left = Math.max(0, Math.floor(pane.left - size - 4));
    }
    if (left === shownRef.current.left && top === shownRef.current.top) return;
    shownRef.current = { left, top }; setShown(shownRef.current);
  };
  // A drag or a key puts her somewhere new (or makes her bigger), starting from where she is shown.
  const put = (left: number, top: number, size = placeRef.current.size) => {
    const next = { right: Math.round(innerWidth - left - size), bottom: Math.round(innerHeight - top - size), size };
    placeRef.current = next; setPlace(next); fit();
  };
  const move = (x: number, y: number) => put(shownRef.current.left + x, shownRef.current.top + y);
  // Resizing keeps her bottom-right corner where it is, so she grows up and to the left, towards the handle.
  const resize = (size: number) => { const { left, top } = shownRef.current, now = placeRef.current.size, next = sized(size); put(left + now - next, top + now - next, next); };
  const save = async () => {
    try {
      const value = JSON.stringify(placeRef.current), storage = window.elpisDesktop?.storage;
      if (storage?.saveItem) await storage.saveItem(FLOAT_KEY, value);
      else appStorage().setItem(FLOAT_KEY, value);
    } catch { setError("Matilda's place could not be saved."); }
  };
  const grab = (resizing: boolean) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ...shownRef.current, size: placeRef.current.size, resize: resizing, moved: false };
  };
  const pull = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current; if (!start) return;
    // A release the window never passed on (over its title bar, or outside it) ends the drag; she never follows a free pointer.
    if (!(event.buttons & 1)) { release(); return; }
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) >= 4) { start.moved = true; setHeldSide(side); document.documentElement.classList.add("matilda-dragging"); }
    if (!start.moved) return;
    event.stopPropagation();
    if (!start.resize) { put(start.left + dx, start.top + dy, start.size); return; }
    const next = sized(start.size - (dx + dy) / 2);
    put(start.left + start.size - next, start.top + start.size - next, next);
  };
  const release = () => {
    const start = drag.current; drag.current = null;
    if (!start?.moved) return;
    setHeldSide(null); document.documentElement.classList.remove("matilda-dragging");
    suppressClick.current = true; requestAnimationFrame(() => { suppressClick.current = false; }); void save();
  };
  const keys = (resizing: boolean) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 3 : 1, grow = ({ "+": 1, "=": 1, "-": -1, "_": -1, ...resizing ? { ArrowUp: 1, ArrowLeft: 1, ArrowDown: -1, ArrowRight: -1 } : {} } as Record<string, number>)[event.key];
    const delta = resizing ? undefined : ({ ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] } as Record<string, [number, number]>)[event.key];
    if (!grow && !delta) return;
    event.preventDefault(); event.stopPropagation();
    if (grow) resize(placeRef.current.size + grow * SIZE.step * step); else move(delta![0] * step, delta![1] * step);
    void save();
  };
  useLayoutEffect(() => { if (state?.pinned) fit(); }, [state?.pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const resized = () => fit(); window.addEventListener("resize", resized); return () => window.removeEventListener("resize", resized); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!state?.pinned) return;
    let panes: Element[] = [];
    const resized = new ResizeObserver(() => fit());
    const discover = () => {
      const next = [...document.querySelectorAll(".browser-viewport")];
      if (next.length === panes.length && next.every((pane, i) => pane === panes[i])) return;
      panes = next; resized.disconnect(); panes.forEach(pane => resized.observe(pane)); fit();
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
  useEffect(() => () => document.documentElement.classList.remove("matilda-dragging"), []);
  const track = state?.music;
  const size = place.size, chrome = chromeBottom();
  const side = heldSide ?? (shown.top - chrome < 300 ? "bottom" : "top");
  // Her chat sits above her (below her near the top), right edges together, inside the window and below the title bar.
  const chatPlace = () => {
    const width = Math.min(340, innerWidth - 24), gap = 6, edge = 4;
    const left = Math.min(Math.max(shown.left + size - width, edge), innerWidth - edge - width) - shown.left;
    return side === "top" ? { left, width, bottom: size + gap, maxHeight: shown.top - gap - chrome - edge } : { left, width, top: size + gap, maxHeight: innerHeight - shown.top - size - gap - edge };
  };
  const floating = state?.pinned && <section ref={floatRef} aria-label="Pinned Matilda" className="matilda-float" data-controls={shown.top - chrome < 40 ? "below" : "above"} style={{ left: shown.left, top: shown.top, width: size, height: size }}>
    <button ref={faceRef} type="button" className="matilda-face" aria-label="Chat with Matilda" aria-haspopup="dialog" aria-expanded={chatOpen} title="Chat with Matilda · drag to move" style={{ touchAction: "none" }}
      onPointerDown={grab(false)} onPointerMove={pull} onPointerUp={release} onLostPointerCapture={release}
      onClick={() => { if (!suppressClick.current) setChatOpen(open => !open); }}
      onPointerCancel={() => { const start = drag.current; if (start) put(start.left, start.top, start.size); release(); }}
      onKeyDown={keys(false)} onPointerEnter={() => mood.setHovered(true)} onPointerLeave={() => mood.setHovered(false)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MATILDA_SHOTS_LIGHT.listening} alt="Matilda" width={size} height={size} draggable={false} className="matilda-avatar-light select-none" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MATILDA_SHOTS.listening} alt="" aria-hidden="true" width={size} height={size} draggable={false} className="matilda-avatar-dark select-none" />
      {MOODS.flatMap(name => ([
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${name}-light`} src={MATILDA_SHOTS_LIGHT[name]} alt="" aria-hidden="true" width={size} height={size} draggable={false} className="matilda-avatar-light matilda-mood select-none" data-mood={name} data-shown={mood.shown === name} />,
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${name}-dark`} src={MATILDA_SHOTS[name]} alt="" aria-hidden="true" width={size} height={size} draggable={false} className="matilda-avatar-dark matilda-mood select-none" data-mood={name} data-shown={mood.shown === name} />,
      ]))}
    </button>
    {chatOpen && <div className="hud-popover matilda-mini-popup" data-side={side} style={chatPlace()}><MatildaMiniChat chat={mini} /></div>}
    <button type="button" className="matilda-resize" aria-label="Resize Matilda" title="Drag to resize · + and − keys" style={{ touchAction: "none" }}
      onPointerDown={grab(true)} onPointerMove={pull} onPointerUp={release} onLostPointerCapture={release} onKeyDown={keys(true)} />
    <div className="matilda-float-controls">
      {/* Only while music plays (or she muted it), as an icon (29 Oct, Masih: "no music is playing!", "I don't want texts; I want visuals"). */}
      {track?.canMute && (track.status === "Playing" || track.muted) && <Button variant="ghost" size="icon-xs" aria-label={track.muted ? "Unmute music" : "Mute music"} aria-pressed={track.muted} disabled={busy} onClick={() => void act("toggle-mute")}>{track.muted ? <SoundOffIcon size={16} /> : <SoundIcon size={16} />}</Button>}
      <Button variant="ghost" size="icon-xs" aria-label="Unpin Matilda" aria-pressed="true" onClick={() => void act("unpin")}><PinIcon size={16} /></Button>
    </div>
  </section>;
  return <div className="flex min-w-0 shrink-0 items-center gap-1 pr-2">
    <MatildaHeartBurst />
    {floating ? createPortal(floating, document.body) : <Button variant="ghost" size="icon-sm" aria-label="Pin Matilda" title="Pin Matilda" disabled={busy} onClick={() => void act("pin")}><><img className="matilda-pin-face matilda-avatar-light" src={MATILDA_SHOTS_LIGHT.softSmile} alt="" /><img className="matilda-pin-face matilda-avatar-dark" src={MATILDA_SHOTS.softSmile} alt="" /></></Button>}
    {error && <p role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm border border-border bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
