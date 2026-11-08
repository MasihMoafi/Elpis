"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onPruneRequest, type PruneTarget } from "@/lib/smart-prune";
import { ListTree } from "lucide-react";
import { BrowserIcon, FileEditIcon, FolderIcon, TerminalIcon } from "@/components/elpis-icons";
import { type Browser } from "@/components/browser-panel";
import { endTerminal } from "@/components/terminal-view";
import { onRequest, useFiles, paneIn } from "@/lib/files-pane";
import { mergeOrder, neighbour } from "@/lib/panel-tabs";
import type { BrowserTab } from "@/lib/desktop";
import { SIDEBAR } from "@/lib/use-appearance";

/** A shell in the side panel. Its key names the shell in Electron; `threadId` is the chat "Open in Elpis TUI" resumed in it. */
export type TerminalTab = { key: string; n: number; cwd: string; threadId?: string };

export type Item =
  | { key: string; kind: "smartPrune"; target: PruneTarget }
  | { key: string; kind: "terminal"; terminal: TerminalTab }
  | { key: string; kind: "browser"; page: BrowserTab }
  | { key: string; kind: "changes" }
  | { key: string; kind: "files" }
  | { key: string; kind: "context" };

/** The Changes tab (components/changes-panel.tsx) is one tab for the open chat's folder, so it has one key. */
export const CHANGES = "c:changes";

/** The Files tab (components/files-pane.tsx) is one tab too: the open chat's folder. */
export const FILES = "f:files";

export const PRUNE = "p:prune";

export const CONTEXT = "x:context";

/** It opens as wide as the left sidebar and narrows as far as the sidebar can; a browser page needs 380px to keep its
 * address field (components/browser-panel.tsx). */
export const sideMinWidth = (shown: { kind: string } | null) => (shown?.kind === "browser" ? 380 : SIDEBAR.min);

/** What the side panel holds: terminals (kept here) and browser pages (kept by Electron, shown through `browser`).
 * The panel follows the browser: a page that opens or comes forward opens the panel on it, and the page stays
 * hidden whenever the panel is closed or shows a terminal. Full view makes it fill the work area; the chat then floats
 * over it as a card (`chatCollapsed`: a pill instead). */
export function useSidePanel(browser: Browser, cwd = "") {
  const fileState = useFiles(),
    filePane = paneIn(fileState, cwd);
  const [emptyFilesWidth, setEmptyFilesWidth] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [prune, setPrune] = useState<PruneTarget | null>(null);
  const [terminals, setTerminals] = useState<TerminalTab[]>([]),
    [changes, setChanges] = useState(false),
    [filesTab, setFilesTab] = useState(false);
  const [contextTab, setContextTab] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [full, setFull] = useState(false),
    [chatCollapsed, setChatCollapsed] = useState(false);
  /** The panel's width in pixels once its edge has been dragged; until then it is as wide as the sidebar (app/globals.css). */
  const [width, setWidth] = useState<number | null>(null),
    [emptyWidth, setEmptyWidth] = useState<number | null>(null);
  const order = useRef<string[]>([]);
  const pages = browser.state?.tabs ?? [];
  order.current = mergeOrder(
    order.current,
    [
      ...terminals.map(tab => `t:${tab.key}`),
      ...pages.map(page => `b:${page.id}`),
      ...(changes ? [CHANGES] : []),
      ...(filesTab ? [FILES] : []),
      ...(prune ? [PRUNE] : []),
      ...(contextTab ? [CONTEXT] : []),
    ],
    pages.map(page => `b:${page.id}`),
  );
  const items = order.current.flatMap((key): Item[] => {
    if (key === PRUNE && prune) return [{ key, kind: "smartPrune", target: prune }];
    if (key === CHANGES) return [{ key, kind: "changes" }];
    if (key === FILES) return [{ key, kind: "files" }];
    if (key === CONTEXT) return [{ key, kind: "context" }];
    const terminal = key.startsWith("t:") && terminals.find(tab => `t:${tab.key}` === key),
      page = key.startsWith("b:") && pages.find(tab => `b:${tab.id}` === key);
    return terminal ? [{ key, kind: "terminal", terminal }] : page ? [{ key, kind: "browser", page }] : [];
  });
  const shown = items.find(item => item.key === active) ?? items.at(-1) ?? null;
  // Opened empty only on request (its chooser); otherwise a panel whose last tab or page went away closes itself.
  const [chooser, setChooser] = useState(false);
  useEffect(() => {
    if (!items.length) {
      setFull(false);
      setChatCollapsed(false);
      if (open && !chooser) setOpen(false);
    }
  }, [open, items.length, chooser]);
  useEffect(() => {
    if (items.length) setChooser(false);
  }, [items.length]);
  const { visible, activeId } = browser.state ?? {},
    command = browser.command;

  // A page that opens or comes forward in Electron (this window's "+", or the agent) opens the panel on it.
  useEffect(() => {
    if (visible && activeId) {
      setOpen(true);
      setActive(`b:${activeId}`);
    }
  }, [visible, activeId]);
  // Showing a page brings it forward in Electron; showing a terminal, or closing the panel, hides the page.
  const select = useCallback(
    (key: string) => {
      setOpen(true);
      setActive(key);
      if (key.startsWith("b:")) void command("select", { id: key.slice(2) });
      else if (visible) void command("hide");
    },
    [command, visible],
  );
  const closePanel = useCallback(() => {
    setOpen(false);
    setChooser(false);
    setFull(false);
    if (visible) void command("hide");
  }, [command, visible]);
  const openPanel = useCallback(() => {
    setOpen(true);
    if (!shown) setChooser(true);
    if (shown?.kind === "browser" && !visible) void command("select", { id: shown.page.id });
  }, [command, visible, shown]);
  /** Enters (or, given `false`, leaves) full view; with no argument it flips. Entering opens a closed panel and shows the chat as a card. */
  const toggleFull = useCallback(
    (next = !full || !open) => {
      if (next) {
        setChatCollapsed(false);
        if (!open) openPanel();
      }
      setFull(next);
    },
    [full, open, openPanel],
  );
  /** Opens a shell in `cwd`; the tab already opened for this chat is reused. Returns the shell's key. */
  const openTerminal = useCallback(
    (cwd: string, threadId?: string) => {
      const same = threadId ? terminals.find(tab => tab.threadId === threadId) : undefined;
      const tab = same ?? {
        key: `terminal-${crypto.randomUUID()}`,
        n: Math.max(0, ...terminals.map(item => item.n)) + 1,
        cwd,
        ...(threadId ? { threadId } : {}),
      };
      if (!same) setTerminals(previous => [...previous, tab]);
      select(`t:${tab.key}`);
      return tab.key;
    },
    [terminals, select],
  );
  useEffect(
    () =>
      onPruneRequest(target => {
        setPrune(target);
        select(PRUNE);
      }),
    [select],
  );
  const openPage = useCallback(() => {
    setOpen(true);
    void command("new");
  }, [command]);
  /** Shows the Changes tab, opening it first when it is not there. */
  const openChanges = useCallback(() => {
    setChanges(true);
    select(CHANGES);
  }, [select]);
  /** Shows the Files tab, opening it first when it is not there. A path clicked in a reply asks for it (lib/files-pane.ts). */
  const openFiles = useCallback(() => {
    setFilesTab(true);
    select(FILES);
  }, [select]);
  const openContext = useCallback(() => {
    setContextTab(true);
    select(CONTEXT);
  }, [select]);
  useEffect(() => onRequest(openFiles), [openFiles]);
  const close = useCallback(
    (key: string) => {
      const next = neighbour(order.current, key);
      if (shown?.key === key) {
        if (next) select(next);
        else setActive(null);
      }
      if (key === PRUNE) setPrune(null);
      else if (key === CHANGES) setChanges(false);
      else if (key === FILES) setFilesTab(false);
      else if (key === CONTEXT) setContextTab(false);
      else if (key.startsWith("t:")) {
        setTerminals(previous => previous.filter(tab => `t:${tab.key}` !== key));
        endTerminal(key.slice(2));
      } else void command("close", { id: key.slice(2) });
    },
    [shown?.key, command, select],
  );
  /** Ctrl+`: a shell, shown; pressed again on the shell, the panel closes (unless `canClose` is false). Returns whether a shell is shown. */
  const toggleTerminal = useCallback(
    (cwd: string, canClose = true) => {
      if (canClose && open && shown?.kind === "terminal") {
        closePanel();
        return false;
      }
      const last = [...items].reverse().find(item => item.kind === "terminal");
      if (last) select(last.key);
      else openTerminal(cwd);
      return true;
    },
    [open, shown, items, select, openTerminal, closePanel],
  );
  /** Ctrl+Shift+E: the Files tab, shown; pressed again on it, the panel closes (unless `canClose` is false). Returns whether it is shown. */
  const toggleFiles = useCallback(
    (canClose = true) => {
      if (canClose && open && shown?.kind === "files") {
        closePanel();
        return false;
      }
      openFiles();
      return true;
    },
    [open, shown, openFiles, closePanel],
  );
  // Ctrl+Shift+F on a page reaches the window as a count in the browser's state; each step is one press.
  const presses = browser.state?.fullView,
    seen = useRef<number | null>(null);
  useEffect(() => {
    seen.current = null;
  }, [browser.sessionId]);
  useEffect(() => {
    if (presses === undefined) return;
    if (seen.current !== null && presses !== seen.current) toggleFull();
    seen.current = presses;
  }, [presses, toggleFull]);
  const emptyFiles = shown?.kind === "files" && !filePane.open.some(file => file.path === filePane.active);
  return {
    open,
    full,
    width: emptyFiles ? emptyFilesWidth : shown ? (width ?? (shown.kind === "files" ? 640 : null)) : emptyWidth,
    setWidth: emptyFiles ? setEmptyFilesWidth : shown ? setWidth : setEmptyWidth,
    chatCollapsed,
    setChatCollapsed,
    toggleFull,
    items,
    shown,
    openPanel,
    closePanel,
    select,
    close,
    openTerminal,
    openPage,
    openChanges,
    openFiles,
    openContext,
    toggleFiles,
    toggleTerminal,
  };
}

export type SidePanelState = ReturnType<typeof useSidePanel>;

/** What a new tab can be, for the "+" menu and for an empty panel: one list. */
export function kindsOf(panel: SidePanelState, browser: Browser, hasTerminal: boolean, cwd: string, hasChat: boolean) {
  return [
    ...(hasTerminal
      ? [{ id: "terminal", label: "Terminal", icon: <TerminalIcon size={16} />, run: () => panel.openTerminal(cwd) }]
      : []),
    ...(browser.api
      ? [{ id: "browser", label: "Browser tab", icon: <BrowserIcon size={16} />, run: panel.openPage }]
      : []),
    ...(hasChat ? [{ id: "changes", label: "Changes", icon: <FileEditIcon size={16} />, run: panel.openChanges }] : []),
    ...(hasChat ? [{ id: "context", label: "Context", icon: <ListTree size={16} />, run: panel.openContext }] : []),
    ...(cwd ? [{ id: "files", label: "Files", icon: <FolderIcon size={16} />, run: panel.openFiles }] : []),
  ];
}
