"use client";

import "@xterm/xterm/css/xterm.css";
import "@/components/terminal-panel.css";
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { RotateCcw, X } from "lucide-react";
import { TerminalIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { appStorage } from "@/lib/projects";
import type { DesktopTerminal, TerminalSession } from "@/lib/desktop";

/** ChatGPT's bottom panel: 280px at first, resized from its top edge and kept on this device. */
const HEIGHT_KEY = "elpis-terminal-height", DEFAULT_HEIGHT = 280, MIN_HEIGHT = 120;
const folderName = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) || cwd || "~";

/** One xterm per chat for this page's lifetime; its element moves into the panel when that chat is shown. */
type View = { term: Terminal; fit: FitAddon; element: HTMLDivElement; session: number | null; offset: number; pending: [number, number, string][]; shell: string; exited: number | null; changed: () => void };
const views = new Map<string, View>();
let modules: Promise<[typeof import("@xterm/xterm"), typeof import("@xterm/addon-fit"), typeof import("@xterm/addon-web-links")]> | null = null;
let subscribed = false;

/** Writes the part of a chunk this view has not shown yet: a reopened shell's replay and its live output may overlap. */
function write(view: View, id: number, end: number, data: string) {
  if (view.session === null) { view.pending.push([id, end, data]); return; }
  if (id !== view.session || end <= view.offset) return;
  const start = end - data.length;
  view.term.write(start < view.offset ? data.slice(view.offset - start) : data);
  view.offset = end;
}
function attach(view: View, session: TerminalSession) {
  view.session = session.id; view.offset = session.end - session.output.length; view.shell = session.shell; view.exited = session.exited;
  write(view, session.id, session.end, session.output);
  for (const [id, end, data] of view.pending.splice(0)) write(view, id, end, data);
  view.changed();
}

/** Resolves a CSS colour (the app's tokens use color-mix) to #rrggbb for xterm. */
function rgb(value: string, alpha?: number) {
  const context = document.createElement("canvas").getContext("2d"); if (!context) return value;
  context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return alpha === undefined ? `#${[r, g, b].map(part => part.toString(16).padStart(2, "0")).join("")}` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function theme(element: HTMLElement) {
  const style = getComputedStyle(element), token = (name: string) => style.getPropertyValue(name).trim();
  return { background: rgb(token("--background")), foreground: rgb(token("--foreground")), cursor: rgb(token("--primary")), cursorAccent: rgb(token("--background")), selectionBackground: rgb(token("--primary"), 0.3) };
}

/** Copy and paste as in the ChatGPT app on Linux: Ctrl+Shift+C/V, Ctrl+C with a selection, Ctrl/Shift+Insert. */
function clipboardKey(event: KeyboardEvent, term: Terminal, api: DesktopTerminal) {
  if (event.type !== "keydown" || event.altKey || event.metaKey) return false;
  const key = event.key.toLowerCase();
  const copy = (event.ctrlKey && key === "c" && (event.shiftKey || term.hasSelection())) || (event.ctrlKey && !event.shiftKey && key === "insert");
  const paste = (event.ctrlKey && event.shiftKey && key === "v") || (!event.ctrlKey && event.shiftKey && key === "insert");
  if (!copy && !paste) return false;
  event.preventDefault(); event.stopPropagation();
  if (copy) { const text = term.getSelection(); if (text) void api.copy(text).catch(() => {}); if (!event.shiftKey) term.clearSelection(); }
  else void api.paste().then(text => { if (text) term.paste(text); }).catch(() => {});
  return true;
}

type Props = {
  /** The chat whose shell this is (its id), and the folder that shell starts in. */
  chatKey: string; cwd: string; dark: boolean;
  /** "Open in Elpis TUI": resume this chat in its shell once the shell is attached. */
  launch: { threadId: string; token: number } | null;
  onClose: () => void;
};

/** The integrated terminal under the chat, as in the ChatGPT app's Codex mode (Ctrl+`). */
export function TerminalPanel({ chatKey, cwd, dark, launch, onClose }: Props) {
  const api = typeof window === "undefined" ? undefined : window.elpisDesktop?.terminal;
  const panel = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null), drag = useRef<{ y: number; height: number } | null>(null);
  const [height, setHeight] = useState(() => { try { return Number(appStorage().getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT; } catch { return DEFAULT_HEIGHT; } });
  const [state, setState] = useState<{ shell: string; exited: number | null }>({ shell: "", exited: null });
  const [error, setError] = useState("");
  const current = useRef<View | null>(null), launched = useRef(0);

  // The page's one subscription routes each shell's output to its chat's view.
  useEffect(() => {
    if (!api || subscribed) return; subscribed = true;
    api.subscribe((key, id, end, data) => { const view = views.get(key); if (view) write(view, id, end, data); },
      (key, id, code) => { const view = views.get(key); if (view && view.session === id) { view.exited = code; view.changed(); } });
  }, [api]);

  useEffect(() => {
    if (!api || !host.current) return;
    let disposed = false; const target = host.current; setError("");
    modules ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-web-links")]);
    void modules.then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
      if (disposed) return;
      let view = views.get(chatKey);
      if (!view) {
        const term = new Terminal({ fontFamily: getComputedStyle(target).getPropertyValue("--mono").trim() || "monospace", fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: false, minimumContrastRatio: 4.5, theme: theme(target) });
        const fit = new FitAddon(), element = document.createElement("div");
        element.className = "terminal-view";
        term.loadAddon(fit); term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank")));
        const created: View = { term, fit, element, session: null, offset: 0, pending: [], shell: "", exited: null, changed: () => {} };
        term.attachCustomKeyEventHandler(event => !clipboardKey(event, term, api) && !(event.ctrlKey && event.code === "Backquote"));
        term.onData(data => api.input(chatKey, data));
        term.onResize(({ cols, rows }) => api.resize(chatKey, cols, rows));
        target.replaceChildren(element); term.open(element); fit.fit();
        views.set(chatKey, view = created);
        void api.open(chatKey, cwd, term.cols, term.rows).then(session => attach(created, session)).catch(cause => { views.delete(chatKey); setError(cause instanceof Error ? cause.message : String(cause)); });
      } else { target.replaceChildren(view.element); view.fit.fit(); }
      const shown = view;
      current.current = shown;
      shown.changed = () => { if (!disposed) setState({ shell: shown.shell, exited: shown.exited }); };
      shown.changed(); shown.term.focus();
    });
    return () => { disposed = true; const shown = current.current; if (shown) shown.changed = () => {}; current.current = null; };
  }, [api, chatKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resize: the panel's size gives the shell its rows and columns.
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(() => { const view = current.current; if (view && host.current?.contains(view.element)) view.fit.fit(); });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => { const frame = requestAnimationFrame(() => { if (panel.current) for (const view of views.values()) view.term.options.theme = theme(panel.current); }); return () => cancelAnimationFrame(frame); }, [dark]);

  // "Open in Elpis TUI": once this chat's shell is attached, type `elpis resume <id>` at its prompt.
  useEffect(() => {
    if (!api || !launch || launch.threadId !== chatKey || launched.current === launch.token) return;
    launched.current = launch.token;
    const run = () => {
      const view = views.get(chatKey);
      if (!view || view.session === null) { requestAnimationFrame(run); return; }
      void api.tui(chatKey, cwd, launch.threadId, view.term.cols, view.term.rows).then(() => { setError(""); view.term.focus(); })
        .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    run();
  }, [api, launch, chatKey, cwd]);

  async function restart() {
    const view = views.get(chatKey); if (!api || !view) return;
    view.session = null; view.pending = []; view.term.reset(); setError("");
    try { attach(view, await api.restart(chatKey, cwd, view.term.cols, view.term.rows)); view.term.focus(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const resizeTo = (next: number) => {
    const limit = Math.max(MIN_HEIGHT, (panel.current?.parentElement?.clientHeight ?? 800) - 160), value = Math.round(Math.min(limit, Math.max(MIN_HEIGHT, next)));
    setHeight(value); try { appStorage().setItem(HEIGHT_KEY, String(value)); } catch { /* the height is only a preference */ }
  };

  const status = error || (state.exited !== null ? `Shell exited with code ${state.exited}. Restart the terminal to open a new shell.` : "");
  return <section ref={panel} className="terminal-panel" aria-label="Terminal" style={{ height }}>
    <div className="terminal-resize" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" tabIndex={0}
      onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); resizeTo(height + (event.key === "ArrowUp" ? 24 : -24)); } }}
      onPointerDown={event => { drag.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) resizeTo(drag.current.height + drag.current.y - event.clientY); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    <div className="terminal-header">
      <span className="terminal-tab"><TerminalIcon size={14} aria-hidden="true" />{state.shell || "Terminal"}</span>
      <span className="terminal-folder" title={cwd}>{folderName(cwd)}</span>
      <span className="terminal-actions">
        <Button variant="ghost" size="icon-xs" aria-label="Restart terminal" title="Restart terminal" onClick={() => void restart()}><RotateCcw size={13} /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close panel" title="Close panel (Ctrl+`)" onClick={onClose}><X size={14} /></Button>
      </span>
    </div>
    <div ref={host} className="terminal-host" />
    {status && <p className="terminal-status" role="status">{status}</p>}
  </section>;
}
