"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserIcon, ChatIcon, PlusIcon } from "@/components/elpis-icons";
import { ExternalLink, ArrowLeft, ArrowRight, RefreshCw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BrowserState, DesktopBrowser } from "@/lib/desktop";

/** The desktop's built-in browser: tabs and pages live in the Electron main process. */
export function useBrowser() {
  const [api, setApi] = useState<DesktopBrowser | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const browser = window.elpisDesktop?.browser; if (!browser) return;
    setApi(browser); let disposed = false;
    const update = (value: BrowserState) => { if (!disposed) setState(value); };
    const unsubscribe = browser.subscribe(update);
    void browser.command("state").then(update).catch(e => setError(e.message));
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const command = useCallback(async (action: string, data?: { id?: string; url?: string }) => {
    if (!api) return; setError("");
    try { await api.command(action, data); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [api]);
  return { api, state, error, command };
}
export type Browser = ReturnType<typeof useBrowser>;

/** The ChatGPT app's tab strip: the chat first, then each page, then a new-tab button. */
export function TaskTabs({ browser, chatTitle, chatActive, chatMenu, onChat, onPage }: {
  browser: Browser; chatTitle: string; chatActive: boolean; chatMenu?: ReactNode; onChat: () => void; onPage: () => void;
}) {
  const tabs = browser.state?.tabs ?? [];
  return <div className="task-tabs" role="tablist" aria-label="Task tabs">
    <div className={`task-tab chat-tab${chatActive ? " active" : ""}`}>
      <button type="button" role="tab" aria-selected={chatActive} onClick={onChat} title={chatTitle}><ChatIcon size={14} aria-hidden="true" /><span>{chatTitle || "New chat"}</span></button>
      {chatMenu}
    </div>
    {tabs.map(tab => {
      const active = !chatActive && browser.state?.visible && tab.id === browser.state.activeId;
      return <div key={tab.id} className={`task-tab${active ? " active" : ""}`}>
        <button type="button" role="tab" aria-selected={!!active} title={tab.url === "about:blank" ? tab.title : `${tab.title}\n${tab.url}`} onClick={() => { onPage(); void browser.command("select", { id: tab.id }); }}>
          {tab.loading ? <RefreshCw size={13} className="animate-spin" aria-hidden="true" /> : <BrowserIcon size={13} aria-hidden="true" />}<span>{tab.title}</span>
        </button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Close ${tab.title} tab`} onClick={() => void browser.command("close", { id: tab.id })}><X size={12} /></Button>
      </div>;
    })}
    <Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New tab" title="New browser tab" onClick={() => { onPage(); void browser.command("new"); }}><PlusIcon size={15} /></Button>
  </div>;
}

/** The page area: address bar and the native page view placed over the viewport. */
export function BrowserPanel({ browser, covered, full }: { browser: Browser; covered: boolean; full: boolean }) {
  const { api, state, command } = browser;
  const [edit, setEdit] = useState<{ tab: string; value: string } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [modal, setModal] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), address = useRef<HTMLInputElement>(null), panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const active = state?.tabs.find(tab => tab.id === state.activeId);
  useEffect(() => {
    const refresh = () => setModal([...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[data-slot="popover-content"],[data-slot="combobox-content"]')].some(element => element.getClientRects().length > 0));
    const observer = new MutationObserver(refresh); observer.observe(document.body, { childList: true, subtree: true }); refresh();
    return () => observer.disconnect();
  }, []);
  const layout = useCallback(() => {
    const element = viewport.current; if (!api || !element) return;
    const rect = element.getBoundingClientRect();
    api.layout({ bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, obscured: covered || modal || resizing || !state?.visible });
  }, [api, covered, modal, resizing, state?.visible]);
  useEffect(() => {
    if (!state?.visible || !viewport.current) return;
    const observer = new ResizeObserver(layout); observer.observe(viewport.current); window.addEventListener("resize", layout); layout();
    return () => { observer.disconnect(); window.removeEventListener("resize", layout); api?.layout({ bounds: { x: 0, y: 0, width: 0, height: 0 }, obscured: true }); };
  }, [api, layout, state?.visible, full]);
  useEffect(() => { if (state?.visible && state.focusAddress) { address.current?.focus(); address.current?.select(); } }, [state?.focusAddress, state?.visible]);
  if (!api || !state?.visible) return null;
  const value = edit && edit.tab === active?.id ? edit.value : active?.url === "about:blank" ? "" : active?.url ?? "";
  return <section ref={panel} className={`browser-panel${full ? " full" : ""}`} aria-label="Built-in browser" style={width && !full ? { width } : undefined}>
    {!full && <div className="browser-resize" role="separator" aria-label="Resize browser" aria-orientation="vertical" tabIndex={0}
      onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const current = panel.current?.getBoundingClientRect().width ?? 400; setWidth(Math.max(320, current + (e.key === "ArrowLeft" ? 32 : -32))); } }}
      onPointerDown={e => { drag.current = { x: e.clientX, width: panel.current?.getBoundingClientRect().width ?? 400 }; e.currentTarget.setPointerCapture(e.pointerId); setResizing(true); }}
      onPointerMove={e => { if (drag.current) setWidth(Math.max(320, drag.current.width + drag.current.x - e.clientX)); }}
      onPointerUp={() => { drag.current = null; setResizing(false); }} onPointerCancel={() => { drag.current = null; setResizing(false); }} />}
    <form className="browser-toolbar" aria-label="Browser navigation" onSubmit={event => { event.preventDefault(); const submitted = value; if (!submitted.trim()) return; void api.command("navigate", { url: submitted }).then(() => setEdit(current => current?.value === submitted ? null : current)).catch(() => {}); }}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Back" disabled={!active?.canGoBack} onClick={() => void command("back")}><ArrowLeft size={15} /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward" disabled={!active?.canGoForward} onClick={() => void command("forward")}><ArrowRight size={15} /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={active?.loading ? "Stop loading page" : "Reload page"} onClick={() => void command(active?.loading ? "stop" : "reload")}>{active?.loading ? <Square size={13} /> : <RefreshCw size={14} />}</Button>
      <Input ref={address} aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={value} onChange={e => active && setEdit({ tab: active.id, value: e.target.value })} onKeyDown={e => { if (e.key === "Escape") { setEdit(null); address.current?.blur(); } }} spellCheck={false} autoComplete="off" />
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Open in external browser" title="Open in external browser" disabled={!active || active.url === "about:blank"} onClick={() => void command("external")}><ExternalLink size={14} /></Button>
    </form>
    {(browser.error || active?.error) && <div role="alert" className="browser-error">{browser.error || active?.error}</div>}
    {active?.url === "about:blank" && <p className="browser-empty">Search or enter a web address.<span>Ctrl+L focuses the address · Ctrl+T opens a tab</span></p>}
    <div ref={viewport} className="browser-viewport" id="browser-viewport" role="tabpanel" />
  </section>;
}
