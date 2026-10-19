"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Ellipsis, RefreshCw, Square, PenLine, SquareDashedMousePointer, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AnnotationDock, type AttachToChat } from "@/components/browser-annotations";
import { DevServerPreview } from "@/components/dev-server-preview";
import { heldDrawing, holdDrawing, type DrawingDraft } from "@/lib/browser-drawing-store";
import type { MenuAction } from "@/components/action-menu";
import type { BrowserCommand, BrowserState, BrowserTab, DesktopBrowser } from "@/lib/desktop";

/** The desktop's built-in browser: tabs and pages live in the Electron main process. */
export function useBrowser(sessionId: string) {
  const [desktopApi, setApi] = useState<DesktopBrowser | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState("");
  const current = useRef(sessionId); current.current = sessionId;
  useLayoutEffect(() => {
    const browser = window.elpisDesktop?.browser; if (!browser) return;
    setApi(browser); setError(""); let disposed = false;
    const update = (value: BrowserState) => { if (!disposed && (!browser.sessionScoped || value.sessionId === sessionId)) { setState(value); setError(value.error ?? ""); } };
    const unsubscribe = browser.subscribe(update);
    void browser.command(browser.sessionScoped ? "session" : "state", browser.sessionScoped ? { sessionId } : undefined).then(update).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; unsubscribe(); };
  }, [sessionId]);
  const api = useMemo<DesktopBrowser | null>(() => desktopApi && ({ ...desktopApi,
    command: async (action, data) => {
      const response = await desktopApi.command(action, desktopApi.sessionScoped ? { ...data, sessionId } : data);
      if (current.current !== sessionId) throw Error("This browser session is no longer shown.");
      return response;
    },
    layout: value => desktopApi.layout(desktopApi.sessionScoped ? { ...value, sessionId } : value),
  }), [desktopApi, sessionId]);
  const command = useCallback(async (action: string, data?: BrowserCommand) => {
    if (!api) return undefined; setError("");
    try { return await api.command(action, data); } catch (e) { if (current.current === sessionId) setError(e instanceof Error ? e.message : String(e)); return undefined; }
  }, [api, sessionId]);
  const closeSession = useCallback((id: string) => { if (desktopApi?.sessionScoped) void desktopApi.command("sessionClose", { sessionId: id }).catch(e => setError(e.message)); }, [desktopApi]);
  const adoptSession = useCallback(async (from: string, to: string) => { if (desktopApi?.sessionScoped) await desktopApi.command("sessionAdopt", { fromSessionId: from, sessionId: to }); }, [desktopApi]);
  return { api, state: desktopApi?.sessionScoped && state?.sessionId !== sessionId ? null : state, error, command, closeSession, adoptSession, sessionId };
}
export type Browser = ReturnType<typeof useBrowser>;

// Excalidraw is loaded only when Draw is used.
const BrowserDrawing = lazy(() => import("@/components/browser-drawing"));
const measure = (src: string) => new Promise<{ width: number; height: number }>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(Error("The screenshot could not be read.")); image.src = src; });

/** The ChatGPT app's menu for a page tab (right-click in the side panel): reload, duplicate, copy the address, open it elsewhere, close. */
export function browserTabActions(browser: Browser, tab: BrowserTab, close: () => void): MenuAction[] {
  const page = /^https?:/.test(tab.url);
  return [
    ...(page ? [{ id: "reload", label: "Reload", run: () => void browser.command("reload", { id: tab.id }) },
      { id: "duplicate", label: "Duplicate", run: () => void browser.command("duplicate", { id: tab.id }) },
      { id: "copy", label: "Copy URL", run: () => void browser.command("copyUrl", { id: tab.id }) },
      { id: "external", label: "Open in external browser", run: () => void browser.command("external", { id: tab.id }) }] : []),
    { id: "close", label: "Close tab", hint: "Ctrl+W", run: close },
  ];
}

/** The page area of the side panel: address bar and the native page view placed over the viewport. `covered` hides the
 * page while something else is on top of it; `onAttach` gives annotations and screenshots to the chat's composer;
 * `imagesAllowed` is false for text-only models. */
export function BrowserPanel({ browser, covered, onAttach, imagesAllowed = true, cwd = "" }: { browser: Browser; covered: boolean; onAttach?: AttachToChat; imagesAllowed?: boolean; cwd?: string }) {
  const { api, state, command } = browser;
  const [notice, setNotice] = useState("");
  const [edit, setEdit] = useState<{ tab: string; value: string } | null>(null);
  const [modal, setModal] = useState(false);
  const [drawing, setDrawing] = useState<DrawingDraft | null>(null);
  const [held, setHeld] = useState(() => !!heldDrawing());
  const [drawFailure, setDrawFailure] = useState("");
  const [capturing, setCapturing] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), address = useRef<HTMLInputElement>(null);
  const active = state?.tabs.find(tab => tab.id === state.activeId);
  useEffect(() => {
    const refresh = () => setModal([...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[data-slot="popover-content"],[data-slot="combobox-content"]')].some(element => element.getClientRects().length > 0));
    const observer = new MutationObserver(refresh); observer.observe(document.body, { childList: true, subtree: true }); refresh();
    return () => observer.disconnect();
  }, []);
  const layout = useCallback(() => {
    const element = viewport.current; if (!api || !element) return;
    const rect = element.getBoundingClientRect();
    // A failed page shows Elpis's explanation instead of Chromium's empty error page.
    api.layout({ bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, obscured: covered || modal || !state?.visible || !!active?.failure });
  }, [api, covered, modal, state?.visible, state?.presentation, active?.failure]);
  useEffect(() => {
    if (!state?.visible || !viewport.current) return;
    const observer = new ResizeObserver(layout); observer.observe(viewport.current); window.addEventListener("resize", layout); layout();
    return () => { observer.disconnect(); window.removeEventListener("resize", layout); api?.layout({ bounds: { x: 0, y: 0, width: 0, height: 0 }, obscured: true }); };
  }, [api, layout, state?.visible]);
  useEffect(() => { if (state?.visible && state.focusAddress) { address.current?.focus(); address.current?.select(); } }, [state?.focusAddress, state?.visible]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); }, [notice]);
  // The page is captured before the drawing hides it; a failed capture leaves the page as it was and can be retried.
  async function startDrawing() {
    if (!api || !active || capturing) return;
    const unsent = heldDrawing();
    if (unsent) { setDrawing(unsent); return; }
    setCapturing(true); setDrawFailure("");
    try {
      const image = (await api.command("screenshot", { value: "attach" })).result?.image;
      if (!image) throw Error("The page could not be captured.");
      setDrawing({ shot: image, url: active.url, title: active.title, ...await measure(image) });
    } catch (e) { setDrawFailure(e instanceof Error ? e.message : String(e)); }
    finally { setCapturing(false); }
  }
  const drawingBlocked = !onAttach ? "Drawing needs a chat to add to" : !imagesAllowed ? "This model does not accept images" : "";
  if (!api || !state?.visible) return null;
  const value = edit && edit.tab === active?.id ? edit.value : active?.url === "about:blank" ? "" : active?.url ?? "";
  return <section className="browser-panel" aria-label="Built-in browser">
    <form className="browser-toolbar" aria-label="Browser navigation" onSubmit={event => { event.preventDefault(); const submitted = value; if (!submitted.trim()) return; void api.command("navigate", { url: submitted }).then(() => setEdit(current => current?.value === submitted ? null : current)).catch(() => {}); }}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Back" disabled={!active?.canGoBack} onClick={() => void command("back")}><ArrowLeft size={15} /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward" disabled={!active?.canGoForward} onClick={() => void command("forward")}><ArrowRight size={15} /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={active?.loading ? "Stop loading page" : "Reload page"} onClick={() => void command(active?.loading ? "stop" : "reload")}>{active?.loading ? <Square size={13} /> : <RefreshCw size={14} />}</Button>
      <div className="browser-address">
        {active?.security === "insecure" && <span className="browser-security" title="This site does not use a secure connection"><TriangleAlert size={12} aria-hidden="true" /><span className="browser-security-text">Not secure</span></span>}
        <Input ref={address} aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={value} onChange={e => active && setEdit({ tab: active.id, value: e.target.value })} onKeyDown={e => { if (e.key === "Escape") { setEdit(null); address.current?.blur(); } }} spellCheck={false} autoComplete="off" />
        {active && active.zoom !== 100 && <button type="button" className="browser-zoom" title="Reset zoom to 100%" onClick={() => void command("zoom", { value: "reset" })}>{active.zoom}%</button>}
      </div>
      <Button type="button" variant="ghost" size="sm" className="browser-annotate" aria-pressed={state.annotating} aria-label="Annotate this page" title="Annotate: point at items to ask about or change"
        disabled={!active || !/^https?:/.test(active.url)} onClick={() => void command("annotate")}>
        <SquareDashedMousePointer size={15} aria-hidden="true" /><span className="browser-annotate-label">Annotate</span>{!state.annotating && !!active?.comments && <span className="browser-badge" aria-label={`${active.comments} pending`}>{active.comments}</span>}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="browser-annotate" aria-label="Draw on this page" title={drawingBlocked || "Draw on this page: arrows, pen, shapes and text over a screenshot"}
        disabled={!active || !/^https?:/.test(active.url) || !!drawingBlocked || capturing} onClick={() => void startDrawing()}>
        <PenLine size={15} aria-hidden="true" /><span className="browser-annotate-label">Draw</span>
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" className="browser-external" aria-label="Open in external browser" title="Open in external browser" disabled={!active || active.url === "about:blank"} onClick={() => void command("external")}><ExternalLink size={14} /></Button>
      <BrowserOptions browser={browser} tab={active} onNotice={setNotice} onAttach={onAttach} imagesAllowed={imagesAllowed} />
    </form>
    <DevServerPreview key={cwd} cwd={cwd} browser={browser} />
    {state.agent && (!state.agent.enabled || state.agent.tabId) && <div role="status" className="alert flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-3 py-2 text-sm text-foreground">
      <span>{!state.agent.enabled ? "You have control. Agent browser access is paused." : state.agent.tabId === active?.id ? "Agent is using this tab" : `Agent is using ${state.tabs.find(tab => tab.id === state.agent?.tabId)?.title ?? "a browser tab"}`}</span>
      <Button type="button" variant="ghost" size="sm" className="btn btn-sm btn-ghost shrink-0" onClick={() => void command(state.agent?.enabled ? "agentStop" : "agentAllow")}>{state.agent.enabled ? "Take over" : "Allow agent control"}</Button>
    </div>}
    {state.find.open && active && <FindBar browser={browser} />}
    {(browser.error || active?.error && !active.failure) && <div role="alert" className="browser-error">{browser.error || active?.error}</div>}
    {notice && <div role="status" className="browser-notice">{notice}</div>}
    {drawFailure && <div role="alert" className="browser-error flex items-center justify-between gap-3">
      <span>Drawing could not start: {drawFailure}</span>
      <span className="flex shrink-0 gap-1"><Button type="button" variant="outline" size="xs" onClick={() => void startDrawing()}>Retry</Button><Button type="button" variant="ghost" size="xs" onClick={() => setDrawFailure("")}>Dismiss</Button></span>
    </div>}
    {held && !drawing && <div role="status" className="browser-notice flex items-center justify-between gap-3">
      <span>A drawing is waiting to be added to your message.</span>
      <span className="flex shrink-0 gap-1"><Button type="button" variant="outline" size="xs" onClick={() => void startDrawing()}>Resume</Button><Button type="button" variant="ghost" size="xs" onClick={() => { holdDrawing(null); setHeld(false); }}>Discard</Button></span>
    </div>}
    {active?.url === "about:blank" && <p className="browser-empty">Search or enter a web address.<span>Ctrl+L focuses the address</span></p>}
    <div ref={viewport} className="browser-viewport" id="browser-viewport" role="tabpanel">
      {active?.failure && <div className="browser-failure" role="alert">
        <h2>{active.failure.heading}</h2>
        <p>{active.failure.summary}</p>
        <p className="browser-failure-try">Try:</p>
        <ul>{active.failure.tips.map(tip => <li key={tip}>{tip}</li>)}</ul>
        <code>{active.failure.code}</code>
        <Button type="button" size="sm" onClick={() => void command("reload")}>Reload</Button>
      </div>}
    </div>
    <AnnotationDock browser={browser} onAttach={onAttach} imagesAllowed={imagesAllowed} />
    {drawing && onAttach && <Suspense fallback={<div role="dialog" aria-modal="true" aria-label="Draw on the page" className="fixed inset-0 z-40 grid place-items-center bg-background text-sm text-muted-foreground"><p role="status">Opening the drawing tools…</p></div>}>
      <BrowserDrawing draft={drawing} dark={document.documentElement.classList.contains("dark")} onAttach={onAttach}
        onClose={() => { setDrawing(null); setHeld(!!heldDrawing()); }} onAdded={() => { setDrawing(null); setHeld(false); setNotice("Drawing added to your message"); }} />
    </Suspense>}
  </section>;
}

/** Find in page (Ctrl+F on a page): Enter for the next match, Shift+Enter for the previous one, Escape closes. */
function FindBar({ browser }: { browser: Browser }) {
  const { state, command } = browser, find = state!.find;
  const [text, setText] = useState(find.text);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, [find.focus]);
  const search = (value: string, previous = false) => void command("find", { text: value, ...(previous ? { value: "previous" } : {}) });
  return <div className="browser-find" role="search" aria-label="Find in page">
    <Input ref={field} aria-label="Find in page" placeholder="Find in page…" value={text} spellCheck={false} autoComplete="off"
      onChange={event => { setText(event.target.value); search(event.target.value); }}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); search(text, event.shiftKey); }
        else if (event.key === "Escape") { event.preventDefault(); void command("findClose"); }
      }} />
    <span className="browser-find-count" aria-live="polite">{text ? find.matches ? `${find.active} of ${find.matches}` : "No results" : ""}</span>
    <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous match" disabled={!find.matches} onClick={() => search(text, true)}><ChevronUp size={14} /></Button>
    <Button type="button" variant="ghost" size="icon-xs" aria-label="Next match" disabled={!find.matches} onClick={() => search(text)}><ChevronDown size={14} /></Button>
    <Button type="button" variant="ghost" size="icon-xs" aria-label="Close find bar" onClick={() => void command("findClose")}><X size={13} /></Button>
  </div>;
}

/** The ChatGPT browser's "…" menu: find, zoom, print, screenshots, developer tools and clearing data. */
function BrowserOptions({ browser, tab, onNotice, onAttach, imagesAllowed }: { browser: Browser; tab?: BrowserTab; onNotice: (text: string) => void; onAttach?: AttachToChat; imagesAllowed: boolean }) {
  const { command } = browser, page = !!tab && /^https?:/.test(tab.url);
  async function attachScreenshot() {
    const image = (await command("screenshot", { value: "attach" }))?.result?.image;
    if (!image || !onAttach) { onNotice("Unable to capture screenshot"); return; }
    if (await onAttach([{ id: crypto.randomUUID(), name: "Page screenshot.jpg", type: "image", mimeType: "image/jpeg", dataUrl: image }], false)) onNotice("Screenshot added to your message");
  }
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Browser options" title="Browser options" disabled={!tab} />}><Ellipsis size={15} /></DropdownMenuTrigger>
    <DropdownMenuContent className="browser-options">
      <DropdownMenuItem disabled={!page} onClick={() => void command("findOpen")}>Find in page<kbd className="kbd-hint" aria-hidden="true">Ctrl+F</kbd></DropdownMenuItem>
      <DropdownMenuItem disabled={!page} onClick={() => void command("print")}>Print<kbd className="kbd-hint" aria-hidden="true">Ctrl+P</kbd></DropdownMenuItem>
      <DropdownMenuItem disabled={!page} onClick={() => void command("external")}>Open in external browser</DropdownMenuItem>
      <div role="separator" className="browser-options-separator" />
      <div className="browser-zoom-row" role="group" aria-label="Zoom">
        <span>Zoom</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Zoom out" disabled={!page} onClick={() => void command("zoom", { value: "out" })}>−</Button>
        <button type="button" className="browser-zoom-value" title="Reset zoom" disabled={!page} onClick={() => void command("zoom", { value: "reset" })}>{tab?.zoom ?? 100}%</button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Zoom in" disabled={!page} onClick={() => void command("zoom", { value: "in" })}>+</Button>
      </div>
      <div role="separator" className="browser-options-separator" />
      <DropdownMenuItem disabled={!page} onClick={() => void command("screenshot", { value: "copy" }).then(response => onNotice(response?.result?.copied ? "Screenshot saved to clipboard" : "Unable to capture screenshot"))}>Take a screenshot</DropdownMenuItem>
      <DropdownMenuItem disabled={!page || !onAttach || !imagesAllowed} onClick={() => void attachScreenshot()}>Add a screenshot to your message</DropdownMenuItem>
      <DropdownMenuItem disabled={!page} onClick={() => void command("hardReload")}>Force reload<kbd className="kbd-hint" aria-hidden="true">Ctrl+Shift+R</kbd></DropdownMenuItem>
      <DropdownMenuItem disabled={!page} onClick={() => void command("devtools")}>Developer tools</DropdownMenuItem>
      <div role="separator" className="browser-options-separator" />
      <DropdownMenuItem onClick={() => void command("clearData", { value: "cookies" }).then(response => response && onNotice("Browser cookies cleared"))}>Clear cookies</DropdownMenuItem>
      <DropdownMenuItem onClick={() => void command("clearData", { value: "cache" }).then(response => response && onNotice("Browser cache cleared"))}>Clear cache</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
