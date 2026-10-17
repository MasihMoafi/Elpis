"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { BrowserIcon, PlusIcon, TerminalIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tab, TabStrip } from "@/components/tab-strip";
import { BrowserPanel, browserTabActions, type Browser } from "@/components/browser-panel";
import { TerminalView, endTerminal } from "@/components/terminal-view";
import type { AttachToChat } from "@/components/browser-annotations";
import { mergeOrder, neighbour } from "@/lib/panel-tabs";
import type { BrowserTab } from "@/lib/desktop";

/** A shell in the side panel. Its key names the shell in Electron; `threadId` is the chat "Open in Elpis TUI" resumed in it. */
export type TerminalTab = { key: string; n: number; cwd: string; threadId?: string };
type Item = { key: string; kind: "terminal"; terminal: TerminalTab } | { key: string; kind: "browser"; page: BrowserTab };

const MIN_WIDTH = 320;

/** What the side panel holds: terminals (kept here) and browser pages (kept by Electron, shown through `browser`).
 * The panel follows the browser: a page that opens or comes forward opens the panel on it, and the page stays
 * hidden whenever the panel is closed or shows a terminal. */
export function useSidePanel(browser: Browser) {
  const [open, setOpen] = useState(false);
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const order = useRef<string[]>([]);
  const pages = browser.state?.tabs ?? [];
  order.current = mergeOrder(order.current, [...terminals.map(tab => `t:${tab.key}`), ...pages.map(page => `b:${page.id}`)]);
  const items = order.current.flatMap((key): Item[] => {
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
  const closePanel = useCallback(() => { setOpen(false); if (visible) void command("hide"); }, [command, visible]);
  const openPanel = useCallback(() => { setOpen(true); if (shown?.kind === "browser" && !visible) void command("select", { id: shown.page.id }); }, [command, visible, shown]);
  /** Opens a shell in `cwd`; the tab already opened for this chat is reused. Returns the shell's key. */
  const openTerminal = useCallback((cwd: string, threadId?: string) => {
    const same = threadId ? terminals.find(tab => tab.threadId === threadId) : undefined;
    const tab = same ?? { key: `terminal-${crypto.randomUUID()}`, n: Math.max(0, ...terminals.map(item => item.n)) + 1, cwd, ...(threadId ? { threadId } : {}) };
    if (!same) setTerminals(previous => [...previous, tab]);
    select(`t:${tab.key}`); return tab.key;
  }, [terminals, select]);
  const openPage = useCallback(() => { setOpen(true); void command("new"); }, [command]);
  const close = useCallback((key: string) => {
    const next = neighbour(order.current, key);
    if (shown?.key === key) { if (next) select(next); else setActive(null); }
    if (key.startsWith("t:")) { setTerminals(previous => previous.filter(tab => `t:${tab.key}` !== key)); endTerminal(key.slice(2)); }
    else void command("close", { id: key.slice(2) });
  }, [shown?.key, command, select]);
  /** Ctrl+`: a shell, shown; pressed again on the shell, the panel closes (unless `canClose` is false). Returns whether a shell is shown. */
  const toggleTerminal = useCallback((cwd: string, canClose = true) => {
    if (canClose && open && shown?.kind === "terminal") { closePanel(); return false; }
    const last = [...items].reverse().find(item => item.kind === "terminal");
    if (last) select(last.key); else openTerminal(cwd);
    return true;
  }, [open, shown, items, select, openTerminal, closePanel]);
  return { open, items, shown, openPanel, closePanel, select, close, openTerminal, openPage, toggleTerminal };
}
export type SidePanelState = ReturnType<typeof useSidePanel>;

/** What a new tab can be, for the "+" menu and for an empty panel: one list. */
function kindsOf(panel: SidePanelState, browser: Browser, hasTerminal: boolean, cwd: string) {
  return [
    ...(hasTerminal ? [{ id: "terminal", label: "Terminal", icon: <TerminalIcon size={14} />, run: () => panel.openTerminal(cwd) }] : []),
    ...(browser.api ? [{ id: "browser", label: "Browser tab", icon: <BrowserIcon size={14} />, run: panel.openPage }] : []),
  ];
}

type Props = {
  panel: SidePanelState; browser: Browser; hasTerminal: boolean; dark: boolean;
  /** The folder a new shell starts in: the open chat's. */
  cwd: string;
  launch: { key: string; threadId: string; token: number } | null;
  /** The page is hidden while something else is on top of it. */
  covered: boolean;
  onAttach?: AttachToChat; imagesAllowed?: boolean;
};

/** The right-hand panel: its own row of tabs (terminals and browser pages), a "+" that asks which kind, and the
 * shown tab. Resizable from its left edge; closing it keeps the shells running. */
export function SidePanel({ panel, browser, hasTerminal, dark, cwd, launch, covered, onAttach, imagesAllowed }: Props) {
  const [width, setWidth] = useState<number | null>(null), [resizing, setResizing] = useState(false);
  const element = useRef<HTMLElement>(null), drag = useRef<{ x: number; width: number } | null>(null);
  if (!panel.open) return null;
  const kinds = kindsOf(panel, browser, hasTerminal, cwd), { shown } = panel;
  const resizeTo = (next: number) => setWidth(Math.max(MIN_WIDTH, Math.round(next)));
  return <section ref={element} className="side-panel" aria-label="Side panel" style={width ? { width } : undefined}>
    <div className="side-resize" role="separator" aria-label="Resize side panel" aria-orientation="vertical" tabIndex={0}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeTo((element.current?.getBoundingClientRect().width ?? 400) + (event.key === "ArrowLeft" ? 32 : -32)); } }}
      onPointerDown={event => { drag.current = { x: event.clientX, width: element.current?.getBoundingClientRect().width ?? 400 }; event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
      onPointerMove={event => { if (drag.current) resizeTo(drag.current.width + drag.current.x - event.clientX); }}
      onPointerUp={() => { drag.current = null; setResizing(false); }} onPointerCancel={() => { drag.current = null; setResizing(false); }} />
    <div className="side-header">
      <TabStrip label="Side panel tabs" activeKey={shown?.key ?? null} add={kinds.length > 0 && <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New side panel tab" title="New terminal or browser tab" />}><PlusIcon size={15} /></DropdownMenuTrigger>
        <DropdownMenuContent align="start">{kinds.map(kind => <DropdownMenuItem key={kind.id} onClick={kind.run}>{kind.icon}{kind.label}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu>}>
        {panel.items.map(item => {
          const active = item.key === shown?.key, close = () => panel.close(item.key), select = () => panel.select(item.key);
          if (item.kind === "terminal") return <Tab key={item.key} icon={<TerminalIcon size={14} />} label={item.terminal.n > 1 ? `Terminal ${item.terminal.n}` : "Terminal"} title={item.terminal.cwd} active={active}
            closeLabel={`Close Terminal ${item.terminal.n} tab`} actions={[{ id: "close", label: "Close tab", run: close }]} onSelect={select} onClose={close} />;
          const { page } = item;
          return <Tab key={item.key} icon={<BrowserIcon size={13} />} label={page.title} title={page.url === "about:blank" ? page.title : `${page.title}\n${page.url}`} active={active}
            closeLabel={`Close ${page.title} tab`} actions={browserTabActions(browser, page, close)} onSelect={select} onClose={close} />;
        })}
      </TabStrip>
      <Button type="button" variant="ghost" size="icon-sm" className="side-close" aria-label="Close side panel" title="Close side panel (Ctrl+`)" onClick={panel.closePanel}><X size={15} /></Button>
    </div>
    <div className="side-body">
      {shown?.kind === "terminal" && <TerminalView termKey={shown.terminal.key} cwd={shown.terminal.cwd} dark={dark} launch={launch} />}
      {shown?.kind === "browser" && <BrowserPanel browser={browser} covered={covered || resizing} onAttach={onAttach} imagesAllowed={imagesAllowed} />}
      {!shown && <Empty>{kinds.map(kind => <Button key={kind.id} type="button" variant="outline" size="sm" onClick={kind.run}>{kind.icon}{kind.label}</Button>)}</Empty>}
    </div>
  </section>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="side-empty"><p>Nothing open here yet.</p><div>{children}</div></div>;
}
