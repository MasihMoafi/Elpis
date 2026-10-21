"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SmartPruneDetail } from "@/components/smart-prune";
import { onPruneRequest, type PruneTarget } from "@/lib/smart-prune";
import { Maximize2, Minimize2, Scissors, X } from "lucide-react";
import { BrowserIcon, FileEditIcon, FolderIcon, PlusIcon, TerminalIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tab, TabStrip } from "@/components/tab-strip";
import { BrowserPanel, browserTabActions, type Browser } from "@/components/browser-panel";
import { TerminalView, endTerminal, type TerminalLaunch } from "@/components/terminal-view";
import { ViewBoundary } from "@/components/view-boundary";
import { ChangesPanel } from "@/components/changes-panel";
import { FilesPane } from "@/components/files-pane";
import type { AttachToChat } from "@/components/browser-annotations";
import { attach, detach, onOpenPage, onRequest, openRef } from "@/lib/files-pane";
import { mergeOrder, neighbour } from "@/lib/panel-tabs";
import { api } from "@/lib/api";
import type { BrowserTab } from "@/lib/desktop";
import { ResizeEdge } from "@/components/resize-edge";

/** A shell in the side panel. Its key names the shell in Electron; `threadId` is the chat "Open in Elpis TUI" resumed in it. */
export type TerminalTab = { key: string; n: number; cwd: string; threadId?: string };
type Item = { key: string; kind: "smartPrune"; target: PruneTarget } | { key: string; kind: "terminal"; terminal: TerminalTab } | { key: string; kind: "browser"; page: BrowserTab } | { key: string; kind: "changes" } | { key: string; kind: "files" };
/** The Changes tab (components/changes-panel.tsx) is one tab for the open chat's folder, so it has one key. */
const CHANGES = "c:changes";
/** The Files tab (components/files-pane.tsx) is one tab too: the open chat's folder. */
const FILES = "f:files";
const PRUNE = "p:prune";

/** Narrower than this the browser toolbar could not keep its address field (components/browser-panel.tsx). */
const MIN_WIDTH = 380;

/** What the side panel holds: terminals (kept here) and browser pages (kept by Electron, shown through `browser`).
 * The panel follows the browser: a page that opens or comes forward opens the panel on it, and the page stays
 * hidden whenever the panel is closed or shows a terminal. Full view makes it fill the work area; the chat then floats
 * over it as a card (`chatCollapsed`: a pill instead). */
export function useSidePanel(browser: Browser) {
  const [open, setOpen] = useState(false);
  const [prune, setPrune] = useState<PruneTarget | null>(null);
  const [terminals, setTerminals] = useState<TerminalTab[]>([]), [changes, setChanges] = useState(false), [filesTab, setFilesTab] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [full, setFull] = useState(false), [chatCollapsed, setChatCollapsed] = useState(false);
  /** The panel's width in pixels once its edge has been dragged; until then it takes half the work area (app/globals.css). */
  const [width, setWidth] = useState<number | null>(null);
  const order = useRef<string[]>([]);
  const pages = browser.state?.tabs ?? [];
  order.current = mergeOrder(order.current, [...terminals.map(tab => `t:${tab.key}`), ...pages.map(page => `b:${page.id}`), ...(changes ? [CHANGES] : []), ...(filesTab ? [FILES] : []), ...(prune ? [PRUNE] : [])]);
  const items = order.current.flatMap((key): Item[] => {
    if (key === PRUNE && prune) return [{ key, kind: "smartPrune", target: prune }];
    if (key === CHANGES) return [{ key, kind: "changes" }];
    if (key === FILES) return [{ key, kind: "files" }];
    const terminal = key.startsWith("t:") && terminals.find(tab => `t:${tab.key}` === key), page = key.startsWith("b:") && pages.find(tab => `b:${tab.id}` === key);
    return terminal ? [{ key, kind: "terminal", terminal }] : page ? [{ key, kind: "browser", page }] : [];
  });
  const shown = items.find(item => item.key === active) ?? items.at(-1) ?? null;
  const { visible, activeId } = browser.state ?? {}, command = browser.command;

  // A page that opens or comes forward in Electron (this window's "+", or the agent) opens the panel on it.
  useEffect(() => { if (visible && activeId) { setOpen(true); setActive(`b:${activeId}`); } }, [visible, activeId]);
  // Showing a page brings it forward in Electron; showing a terminal, or closing the panel, hides the page.
  const select = useCallback((key: string) => {
    setOpen(true); setActive(key);
    if (key.startsWith("b:")) void command("select", { id: key.slice(2) }); else if (visible) void command("hide");
  }, [command, visible]);
  const closePanel = useCallback(() => { setOpen(false); setFull(false); if (visible) void command("hide"); }, [command, visible]);
  const openPanel = useCallback(() => { setOpen(true); if (shown?.kind === "browser" && !visible) void command("select", { id: shown.page.id }); }, [command, visible, shown]);
  /** Enters (or, given `false`, leaves) full view; with no argument it flips. Entering opens a closed panel and shows the chat as a card. */
  const toggleFull = useCallback((next = !full || !open) => {
    if (next) { setChatCollapsed(false); if (!open) openPanel(); }
    setFull(next);
  }, [full, open, openPanel]);
  /** Opens a shell in `cwd`; the tab already opened for this chat is reused. Returns the shell's key. */
  const openTerminal = useCallback((cwd: string, threadId?: string) => {
    const same = threadId ? terminals.find(tab => tab.threadId === threadId) : undefined;
    const tab = same ?? { key: `terminal-${crypto.randomUUID()}`, n: Math.max(0, ...terminals.map(item => item.n)) + 1, cwd, ...(threadId ? { threadId } : {}) };
    if (!same) setTerminals(previous => [...previous, tab]);
    select(`t:${tab.key}`); return tab.key;
  }, [terminals, select]);
  useEffect(() => onPruneRequest(target => { setPrune(target); select(PRUNE); }), [select]);
  const openPage = useCallback(() => { setOpen(true); void command("new"); }, [command]);
  /** Shows the Changes tab, opening it first when it is not there. */
  const openChanges = useCallback(() => { setChanges(true); select(CHANGES); }, [select]);
  /** Shows the Files tab, opening it first when it is not there. A path clicked in a reply asks for it (lib/files-pane.ts). */
  const openFiles = useCallback(() => { setFilesTab(true); select(FILES); }, [select]);
  useEffect(() => onRequest(openFiles), [openFiles]);
  const close = useCallback((key: string) => {
    const next = neighbour(order.current, key);
    if (shown?.key === key) { if (next) select(next); else setActive(null); }
    if (key === PRUNE) setPrune(null);
    else if (key === CHANGES) setChanges(false);
    else if (key === FILES) setFilesTab(false);
    else if (key.startsWith("t:")) { setTerminals(previous => previous.filter(tab => `t:${tab.key}` !== key)); endTerminal(key.slice(2)); }
    else void command("close", { id: key.slice(2) });
  }, [shown?.key, command, select]);
  /** Ctrl+`: a shell, shown; pressed again on the shell, the panel closes (unless `canClose` is false). Returns whether a shell is shown. */
  const toggleTerminal = useCallback((cwd: string, canClose = true) => {
    if (canClose && open && shown?.kind === "terminal") { closePanel(); return false; }
    const last = [...items].reverse().find(item => item.kind === "terminal");
    if (last) select(last.key); else openTerminal(cwd);
    return true;
  }, [open, shown, items, select, openTerminal, closePanel]);
  /** Ctrl+Shift+E: the Files tab, shown; pressed again on it, the panel closes (unless `canClose` is false). Returns whether it is shown. */
  const toggleFiles = useCallback((canClose = true) => {
    if (canClose && open && shown?.kind === "files") { closePanel(); return false; }
    openFiles(); return true;
  }, [open, shown, openFiles, closePanel]);
  // Ctrl+Shift+F on a page reaches the window as a count in the browser's state; each step is one press.
  const presses = browser.state?.fullView, seen = useRef<number | null>(null);
  useEffect(() => { seen.current = null; }, [browser.sessionId]);
  useEffect(() => {
    if (presses === undefined) return;
    if (seen.current !== null && presses !== seen.current) toggleFull();
    seen.current = presses;
  }, [presses, toggleFull]);
  return { open, full, width, setWidth, chatCollapsed, setChatCollapsed, toggleFull, items, shown, openPanel, closePanel, select, close, openTerminal, openPage, openChanges, openFiles, toggleFiles, toggleTerminal };
}
export type SidePanelState = ReturnType<typeof useSidePanel>;

/** What a new tab can be, for the "+" menu and for an empty panel: one list. */
function kindsOf(panel: SidePanelState, browser: Browser, hasTerminal: boolean, cwd: string, hasChat: boolean) {
  return [
    ...(hasTerminal ? [{ id: "terminal", label: "Terminal", icon: <TerminalIcon size={14} />, run: () => panel.openTerminal(cwd) }] : []),
    ...(browser.api ? [{ id: "browser", label: "Browser tab", icon: <BrowserIcon size={14} />, run: panel.openPage }] : []),
    ...(hasChat ? [{ id: "changes", label: "Changes", icon: <FileEditIcon size={14} />, run: panel.openChanges }] : []),
    ...(cwd ? [{ id: "files", label: "Files", icon: <FolderIcon size={14} />, run: panel.openFiles }] : []),
  ];
}

type Props = {
  panel: SidePanelState; browser: Browser; hasTerminal: boolean; dark: boolean;
  /** The folder a new shell starts in: the open chat's. */
  cwd: string;
  /** The open chat, whose changes the Changes tab shows, and whether a turn is running in it. */
  threadId?: string; running?: boolean;
  launch: TerminalLaunch | null;
  /** The page is hidden while something else is on top of it. */
  covered: boolean;
  onAttach?: AttachToChat; imagesAllowed?: boolean;
};

/** The right-hand panel: its own row of tabs (terminals and browser pages), a "+" that asks which kind, and the
 * shown tab. Resizable from its left edge; closing it keeps the shells running. In full view it fills the work area
 * and `data-float` tells the CSS what floats over it (the chat's card or its pill), so the page and the shell leave
 * that corner free. */
export function SidePanel({ panel, browser, hasTerminal, dark, cwd, threadId, running = false, launch, covered, onAttach, imagesAllowed }: Props) {
  const [resizing, setResizing] = useState(false);
  // Tells the Files tab where this chat works and that it can open files (a path clicked in a reply is a file ref only then).
  useEffect(() => { attach(cwd); }, [cwd]);
  useEffect(() => detach, []);
  useEffect(() => window.elpisDesktop?.onOpenFile?.(target => { openRef(target); }), []);
  // An HTML file opens as a page in this session's browser, served from its folder so its CSS and images load; if the
  // page cannot be served, the file opens as text in the Files tab instead.
  const { api: browserApi, command } = browser;
  useEffect(() => browserApi ? onOpenPage(async abs => {
    try {
      const { url } = await api<{ url: string }>("/dev-servers/page", { cwd: abs.slice(0, abs.lastIndexOf("/")) || "/", path: abs.slice(abs.lastIndexOf("/") + 1) });
      await command("new", { url });
    } catch { openRef({ path: abs }, { asText: true }); }
  }) : undefined, [browserApi, command]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!panel.open) return null;
  const kinds = kindsOf(panel, browser, hasTerminal, cwd, !!threadId), { shown } = panel;
  const full = panel.full, floating = full ? panel.chatCollapsed ? "pill" : "card" : undefined;
  return <section className={`side-panel${full ? " full" : ""}`} data-float={floating} aria-label="Side panel" style={{ "--side-min": `${MIN_WIDTH}px` } as CSSProperties}>
    <ResizeEdge className="side-resize" label="Resize side panel" width={panel.width} min={MIN_WIDTH} initial={400} grows="left" step={32}
      onResize={panel.setWidth} onClose={panel.closePanel} onDraggingChange={setResizing} />
    <div className="side-header">
      <TabStrip label="Side panel tabs" activeKey={shown?.key ?? null} add={kinds.length > 0 && <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New side panel tab" title="New tab: terminal, browser, changes or files" />}><PlusIcon size={15} /></DropdownMenuTrigger>
        <DropdownMenuContent align="start">{kinds.map(kind => <DropdownMenuItem key={kind.id} onClick={kind.run}>{kind.icon}{kind.label}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu>}>
        {panel.items.map(item => {
          const active = item.key === shown?.key, close = () => panel.close(item.key), select = () => panel.select(item.key);
          if (item.kind === "smartPrune") return <Tab key={item.key} icon={<Scissors size={14} />} label="Smart Prune" title={item.target.prune.tool} active={active} closeLabel="Close Smart Prune tab" actions={[{ id: "close", label: "Close tab", run: close }]} onSelect={select} onClose={close} />;
          if (item.kind === "changes") return <Tab key={item.key} icon={<FileEditIcon size={14} />} label="Changes" title="Changes in this chat's folder" active={active} closeLabel="Close Changes tab"
            actions={[{ id: "close", label: "Close tab", run: close }]} onSelect={select} onClose={close} />;
          if (item.kind === "files") return <Tab key={item.key} icon={<FolderIcon size={14} />} label="Files" title="The files in this chat's folder" active={active} closeLabel="Close Files tab"
            actions={[{ id: "close", label: "Close tab", run: close }]} onSelect={select} onClose={close} />;
          if (item.kind === "terminal") return <Tab key={item.key} icon={<TerminalIcon size={14} />} label={item.terminal.n > 1 ? `Terminal ${item.terminal.n}` : "Terminal"} title={item.terminal.cwd} active={active}
            closeLabel={`Close Terminal ${item.terminal.n} tab`} actions={[{ id: "close", label: "Close tab", run: close }]} onSelect={select} onClose={close} />;
          const { page } = item;
          return <Tab key={item.key} icon={<BrowserIcon size={13} />} label={page.title} title={page.url === "about:blank" ? page.title : `${page.title}\n${page.url}`} active={active}
            closeLabel={`Close ${page.title} tab`} actions={browserTabActions(browser, page, close)} onSelect={select} onClose={close} />;
        })}
      </TabStrip>
      <Button type="button" variant="ghost" size="icon-sm" className="side-action" aria-pressed={full} aria-label={full ? "Exit full view" : "Enter full view"} title={full ? "Exit full view (Ctrl+Shift+F)" : "Full view (Ctrl+Shift+F)"} onClick={() => panel.toggleFull()}>{full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</Button>
      <Button type="button" variant="ghost" size="icon-sm" className="side-action" aria-label="Close side panel" title="Close side panel (Ctrl+`)" onClick={panel.closePanel}><X size={15} /></Button>
    </div>
    <div className="side-body"><ViewBoundary label="This panel" resetKey={`${shown?.key}:${threadId}`}>
      {shown?.kind === "smartPrune" && <SmartPruneDetail target={shown.target} />}
      {shown?.kind === "terminal" && <TerminalView termKey={shown.terminal.key} cwd={shown.terminal.cwd} dark={dark} launch={launch} />}
      {shown?.kind === "changes" && <ChangesPanel threadId={threadId} running={running} />}
      {shown?.kind === "files" && <FilesPane cwd={cwd} />}
      {shown?.kind === "browser" && <BrowserPanel browser={browser} cwd={cwd} covered={covered || resizing} onAttach={onAttach} imagesAllowed={imagesAllowed} />}
      {!shown && <Empty>{kinds.map(kind => <Button key={kind.id} type="button" variant="outline" size="sm" onClick={kind.run}>{kind.icon}{kind.label}</Button>)}</Empty>}
    </ViewBoundary></div>
  </section>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="side-empty"><p>Nothing open here yet.</p><div>{children}</div></div>;
}
