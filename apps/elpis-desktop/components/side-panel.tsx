"use client";

import { sideMinWidth, kindsOf } from "./use-side-panel";
import type { Item, SidePanelState } from "./use-side-panel";
export { sideMinWidth, useSidePanel } from "./use-side-panel";
export type { TerminalTab, SidePanelState } from "./use-side-panel";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { SmartPruneDetail } from "@/components/smart-prune";

import { Maximize2, Minimize2, Scissors, X, ListTree, VolumeX } from "lucide-react";
import { ContextPanel } from "@/components/context-usage";
import { BrowserIcon, FileEditIcon, FolderIcon, PlusIcon, TerminalIcon } from "@/components/elpis-icons";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tab, TabStrip } from "@/components/tab-strip";
import { BrowserPanel, browserTabActions, type Browser } from "@/components/browser-panel";
import { TerminalView, type TerminalLaunch } from "@/components/terminal-view";
import { ViewBoundary } from "@/components/view-boundary";
import { ChangesPanel } from "@/components/changes-panel";
import { FilesPane } from "@/components/files-pane";
import type { AttachToChat } from "@/components/browser-annotations";
import { attach, detach, docKey, isDirty, onOpenPage, openFile, openRef, setFileView, snapshot } from "@/lib/files-pane";
import { resolveRef } from "@/lib/file-refs";

import { api } from "@/lib/api";
import type { BrowserTab } from "@/lib/desktop";
import { ResizeEdge } from "@/components/resize-edge";
import { useBrowserPins } from "@/lib/browser-pins";
import { SIDEBAR } from "@/lib/use-appearance";

type Props = {
  panel: SidePanelState;
  browser: Browser;
  hasTerminal: boolean;
  dark: boolean;
  /** The folder a new shell starts in: the open chat's. */
  cwd: string;
  /** The open chat, whose changes the Changes tab shows, and whether a turn is running in it. */
  threadId?: string | undefined;
  running?: boolean;
  launch: TerminalLaunch | null;
  /** The page is hidden while something else is on top of it. */
  covered: boolean;
  onAttach?: AttachToChat;
  imagesAllowed?: boolean;
};

/** The right-hand panel: its own row of tabs (terminals and browser pages), a "+" that asks which kind, and the
 * shown tab. Resizable from its left edge; closing it keeps the shells running. In full view it fills the work area
 * and `data-float` tells the CSS what floats over it (the chat's card or its pill), so the page and the shell leave
 * that corner free. */
export function SidePanel({
  panel,
  browser,
  hasTerminal,
  dark,
  cwd,
  threadId,
  running = false,
  launch,
  covered,
  onAttach,
  imagesAllowed,
}: Props) {
  const [resizing, setResizing] = useState(false);
  const [pinError, setPinError] = useState("");
  const browserPins = useBrowserPins(setPinError);
  const [selection, setSelection] = useState<string[]>([]),
    anchor = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<BrowserTab | null>(null),
    [name, setName] = useState(""),
    [renameError, setRenameError] = useState(""),
    [savingName, setSavingName] = useState(false);
  const pageKeys = panel.items.filter(item => item.kind === "browser").map(item => item.key);
  const selectedKeys = selection.filter(key => pageKeys.includes(key));
  const selected = selectedKeys.length ? selectedKeys : panel.shown?.kind === "browser" ? [panel.shown.key] : [];
  useEffect(() => {
    setSelection([]);
    anchor.current = null;
    setRenaming(null);
  }, [browser.sessionId]);
  useEffect(() => {
    const key = browser.state?.activeId ? `b:${browser.state.activeId}` : null;
    if (key) setSelection(previous => (previous.includes(key) ? previous : [key]));
  }, [browser.state?.activeId]);
  function selectPage(key: string, event: MouseEvent<HTMLButtonElement>) {
    let next: string[];
    if (event.shiftKey) {
      const from = pageKeys.indexOf(anchor.current ?? (panel.shown?.kind === "browser" ? panel.shown.key : key)),
        to = pageKeys.indexOf(key);
      const range = pageKeys.slice(Math.min(Math.max(0, from), to), Math.max(from, to) + 1);
      next = event.ctrlKey || event.metaKey ? [...new Set([...selected, ...range])] : range;
    } else if (event.ctrlKey || event.metaKey) {
      next =
        selected.includes(key) && selected.length > 1
          ? selected.filter(item => item !== key)
          : [...new Set([...selected, key])];
      anchor.current = key;
    } else {
      next = [key];
      anchor.current = key;
    }
    setSelection(next);
    panel.select(next.includes(key) ? key : next.at(-1)!);
  }
  const closePages = async (keys: string[]) => {
    const closing = new Set(keys);
    if (panel.shown && closing.has(panel.shown.key)) {
      const at = panel.items.findIndex(item => item.key === panel.shown?.key);
      const survivor =
        panel.items.slice(at + 1).find(item => !closing.has(item.key)) ??
        panel.items.slice(0, at).findLast(item => !closing.has(item.key));
      if (survivor) panel.select(survivor.key);
      else panel.closePanel();
    }
    setSelection(previous => previous.filter(key => !closing.has(key)));
    for (const key of keys) if (!(await browser.command("close", { id: key.slice(2) }))) break;
  };
  async function saveName() {
    if (!renaming || savingName) return;
    setSavingName(true);
    setRenameError("");
    const response = await browser.command("rename", { id: renaming.id, text: name });
    setSavingName(false);
    if (response) setRenaming(null);
    else setRenameError("The tab could not be renamed. Try again.");
  }
  // Tells the Files tab where this chat works and that it can open files (a path clicked in a reply is a file ref only then).
  useEffect(() => {
    attach(cwd);
  }, [cwd]);
  useEffect(() => detach, []);
  useEffect(
    () =>
      window.elpisDesktop?.onOpenFile?.(target => {
        openRef(target, { onError: setPinError });
      }),
    [],
  );
  const documentSession = useRef({ cwd, threadId });
  documentSession.current = { cwd, threadId };
  useEffect(
    () =>
      window.elpisDesktop?.documents?.subscribe(async request => {
        const current = documentSession.current;
        if (!current.threadId || current.threadId !== request.threadId)
          throw Error("Open this document's chat before continuing.");
        const file = resolveRef({ path: request.path }, current.cwd);
        if (request.action === "open") {
          const loaded = openFile(current.cwd, file.rel, { show: true, present: true });
          setFileView(current.cwd, file.rel, request.view === "preview" ? "preview" : "source");
          await loaded;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }
        if (documentSession.current.threadId !== request.threadId)
          throw Error("The document's chat changed before it could respond.");
        if (request.action === "open" && !document.querySelector(".files-pane")?.getClientRects().length)
          throw Error("The document editor is not visible. Open this chat and try again.");
        const doc = snapshot().docs[docKey(current.cwd, file.rel)];
        if (request.action === "open" && doc?.status !== "ready")
          throw Error(doc?.status === "error" ? doc.message : "This file could not be opened for editing.");
        return { unsavedChanges: !!(isDirty(doc) || (doc?.status === "ready" && doc.saving)) };
      }),
    [],
  );
  // An HTML file opens as a page in this session's browser, served from its folder so its CSS and images load; if the
  // page cannot be served, the file opens as text in the Files tab instead.
  const { api: browserApi, command } = browser;
  useEffect(() => {
    if (!browserApi) return;
    const openPage = async (abs: string) => {
      try {
        const { url } = await api<{ url: string }>("/dev-servers/page", {
          cwd: abs.slice(0, abs.lastIndexOf("/")) || "/",
          path: abs.slice(abs.lastIndexOf("/") + 1),
        });
        await command("new", { url });
      } catch {
        openRef({ path: abs }, { asText: true });
      }
    };
    return onOpenPage(abs => {
      void openPage(abs);
    });
  }, [browserApi, command]);
  if (!panel.open) return null;
  const kinds = kindsOf(panel, browser, hasTerminal, cwd, !!threadId),
    { shown } = panel,
    minWidth = sideMinWidth(shown);
  const full = panel.full,
    floating = full ? (panel.chatCollapsed ? "pill" : "card") : undefined;
  return (
    <section
      className={`side-panel${full ? " full" : ""}`}
      data-float={floating}
      aria-label="Side panel"
      style={{ "--side-min": `${minWidth}px` } as CSSProperties}
    >
      <ResizeEdge
        className="side-resize"
        label="Resize side panel"
        width={panel.width}
        min={minWidth}
        initial={SIDEBAR.initial}
        grows="left"
        step={32}
        onResize={panel.setWidth}
        onClose={panel.closePanel}
        onDraggingChange={setResizing}
      />
      <div className="side-header">
        <TabStrip
          multiple
          label="Side panel tabs"
          activeKey={shown?.key ?? null}
          add={
            kinds.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="task-tab-new"
                      aria-label="New side panel tab"
                      title="New tab: terminal, browser, changes or files"
                    />
                  }
                >
                  <PlusIcon size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {kinds.map(kind => (
                    <DropdownMenuItem key={kind.id} onClick={kind.run}>
                      {kind.icon}
                      {kind.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        >
          {panel.items.map(item => {
            const active = item.key === shown?.key,
              close = () => panel.close(item.key),
              select = () => panel.select(item.key);
            if (item.kind === "smartPrune")
              return (
                <Tab
                  key={item.key}
                  icon={<Scissors size={16} />}
                  label="Smart Prune"
                  title={item.target.prune.tool}
                  active={active}
                  closeLabel="Close Smart Prune tab"
                  actions={[{ id: "close", label: "Close tab", run: close }]}
                  onSelect={select}
                  onClose={close}
                />
              );
            if (item.kind === "changes")
              return (
                <Tab
                  key={item.key}
                  icon={<FileEditIcon size={16} />}
                  label="Changes"
                  title="Changes in this chat's folder"
                  active={active}
                  closeLabel="Close Changes tab"
                  actions={[{ id: "close", label: "Close tab", run: close }]}
                  onSelect={select}
                  onClose={close}
                />
              );
            if (item.kind === "files")
              return (
                <Tab
                  key={item.key}
                  icon={<FolderIcon size={16} />}
                  label="Files"
                  title="The files in this chat's folder"
                  active={active}
                  closeLabel="Close Files tab"
                  actions={[{ id: "close", label: "Close tab", run: close }]}
                  onSelect={select}
                  onClose={close}
                />
              );
            if (item.kind === "context")
              return (
                <Tab
                  key={item.key}
                  icon={<ListTree size={16} />}
                  label="Context"
                  title="This chat's goal and context files"
                  active={active}
                  closeLabel="Close Context tab"
                  actions={[{ id: "close", label: "Close tab", run: close }]}
                  onSelect={select}
                  onClose={close}
                />
              );
            if (item.kind === "terminal")
              return (
                <Tab
                  key={item.key}
                  icon={<TerminalIcon size={16} />}
                  label={item.terminal.n > 1 ? `Terminal ${item.terminal.n}` : "Terminal"}
                  title={item.terminal.cwd}
                  active={active}
                  closeLabel={`Close Terminal ${item.terminal.n} tab`}
                  actions={[{ id: "close", label: "Close tab", run: close }]}
                  onSelect={select}
                  onClose={close}
                />
              );
            const { page } = item,
              targets = selected.includes(item.key) ? selected : [item.key];
            const selectedPages = panel.items
              .filter(
                (candidate): candidate is Item & { kind: "browser" } =>
                  candidate.kind === "browser" && targets.includes(candidate.key),
              )
              .map(candidate => candidate.page);
            const others = pageKeys.filter(key => !targets.includes(key)),
              right = pageKeys.slice(Math.max(...targets.map(key => pageKeys.indexOf(key))) + 1);
            return (
              <Tab
                key={item.key}
                icon={page.muted ? <VolumeX size={16} /> : <BrowserIcon size={16} />}
                label={page.title}
                title={page.url === "about:blank" ? page.title : `${page.title}\n${page.url}`}
                active={active}
                selected={selected.includes(item.key)}
                closeLabel={`Close ${page.title} tab`}
                actions={browserTabActions(browser, page, {
                  selected: selectedPages,
                  close: () => {
                    void closePages(targets);
                  },
                  ...(others.length
                    ? {
                        closeOthers: () => {
                          void closePages(others);
                        },
                      }
                    : {}),
                  ...(right.length
                    ? {
                        closeRight: () => {
                          void closePages(right);
                        },
                      }
                    : {}),
                  pin: () => {
                    setPinError("");
                    void browserPins.toggle({ url: page.url, title: page.title });
                  },
                  pinned: browserPins.pins.some(pin => pin.url === page.url),
                  rename: () => {
                    setName(page.title);
                    setRenameError("");
                    setRenaming(page);
                  },
                })}
                onContextMenu={() => {
                  if (!selected.includes(item.key)) {
                    setSelection([item.key]);
                    anchor.current = item.key;
                  }
                }}
                onSelect={event => selectPage(item.key, event)}
                onClose={() => {
                  void closePages(targets);
                }}
              />
            );
          })}
        </TabStrip>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="side-action"
          aria-pressed={full}
          aria-label={full ? "Exit full view" : "Enter full view"}
          title={full ? "Exit full view (Ctrl+Shift+F)" : "Full view (Ctrl+Shift+F)"}
          onClick={() => panel.toggleFull()}
        >
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="side-action"
          aria-label="Close side panel"
          title="Close side panel (Ctrl+`)"
          onClick={panel.closePanel}
        >
          <X size={16} />
        </Button>
      </div>
      <div className="side-body">
        <ViewBoundary label="This panel" resetKey={`${shown?.key}:${threadId}`}>
          {shown?.kind === "smartPrune" && <SmartPruneDetail target={shown.target} />}
          {shown?.kind === "terminal" && (
            <TerminalView termKey={shown.terminal.key} cwd={shown.terminal.cwd} dark={dark} launch={launch} />
          )}
          {shown?.kind === "changes" && <ChangesPanel threadId={threadId} running={running} />}
          {shown?.kind === "files" && <FilesPane cwd={cwd} />}
          {shown?.kind === "context" && <ContextPanel {...(threadId === undefined ? {} : { threadId })} />}
          {shown?.kind === "browser" && (
            <BrowserPanel
              onReturnToChat={panel.closePanel}
              browser={browser}
              cwd={cwd}
              covered={covered || resizing}
              {...(onAttach ? { onAttach } : {})}
              {...(imagesAllowed === undefined ? {} : { imagesAllowed })}
            />
          )}
          {!shown && (
            <Empty>
              {kinds.map(kind => (
                <Button key={kind.id} type="button" variant="outline" size="sm" onClick={kind.run}>
                  {kind.icon}
                  {kind.label}
                </Button>
              ))}
            </Empty>
          )}
        </ViewBoundary>
        {pinError && (
          <p role="alert" className="browser-error">
            {pinError}
          </p>
        )}
      </div>
      <AlertDialog
        open={!!renaming}
        onOpenChange={value => {
          if (!value && !savingName) setRenaming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename tab</AlertDialogTitle>
            <AlertDialogDescription>
              The name is saved with this chat’s browser. Leave it empty to use the page title.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <form
            className="grid gap-4"
            aria-label="Rename tab"
            onSubmit={event => {
              event.preventDefault();
              void saveName();
            }}
          >
            <Input
              aria-label="Tab name"
              maxLength={200}
              value={name}
              onChange={event => setName(event.target.value)}
              autoFocus
            />
            {renameError && (
              <p role="alert" className="text-sm text-destructive">
                {renameError}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button type="button" variant="outline" disabled={savingName} />}>
                Cancel
              </AlertDialogClose>
              <Button type="submit" disabled={savingName}>
                {savingName ? "Saving…" : "Save"}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="side-empty">
      <p>Nothing open here yet.</p>
      <div>{children}</div>
    </div>
  );
}
