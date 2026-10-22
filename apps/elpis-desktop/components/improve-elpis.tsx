"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Thread } from "@/lib/api";
import "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DiffLines } from "@/components/diff-view";
import { parseDiff } from "@/lib/diff";
import "./improve-elpis.css";

type Target = { id: string; label: string; image: string; component: string; file: string };
type Change = { id: string; branch: string; cwd: string; status: string; head?: string; dirty?: boolean; diff?: string; truncated?: boolean; error?: string; note?: string; thread: Thread; checks: { passed: boolean; head: string; commands: { command: string; code: number; output: string }[] } | null };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Pointing and review live alongside the ordinary chat; the engine and chat store stay the existing ones. */
export function ImproveElpis({ threadId, onChat }: { threadId?: string; onChat: (thread: Thread) => Promise<void> }) {
  const [open, setOpen] = useState(false), [request, setRequest] = useState("");
  const [target, setTarget] = useState<Target | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false), [change, setChange] = useState<Change | null>(null), [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<HTMLElement | null>(null), [fallback, setFallback] = useState<{ x: number; y: number } | null>(null);
  const pointed = useRef<Element | null>(null), contextActive = useRef(false);
  const [source, setSource] = useState<{ path: string | null; configured: boolean } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setSource(null); setSourceLoading(true);
    void api<{ path: string | null; configured: boolean }>("/improvements/source").then(value => { if (!disposed) setSource(value); }).catch(cause => { if (!disposed) setError(message(cause)); }).finally(() => { if (!disposed) setSourceLoading(false); });
    return () => { disposed = true; };
  }, [open]);
  async function chooseSource() {
    setError(""); setBusy(true);
    try {
      if (!window.elpisDesktop?.chooseFolder) throw Error("Open the desktop app to choose an Elpis source folder.");
      const path = await window.elpisDesktop?.chooseFolder?.();
      if (!path) return;
      setSource(await api<{ path: string; configured: boolean }>("/improvements/source", { path }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const shownReview = useRef<string | null>(null);
  const begin = useCallback(async (element: Element | null) => {
    contextActive.current = false; setMenu(null); setFallback(null); setError(""); setTarget(null); setRequest(""); setBusy(true);
    try {
      if (!window.elpisDesktop?.improve) throw Error("Open Elpis desktop to capture the region you want to change.");
      const pointed = element ?? document.querySelector(".app-shell");
      let owner = pointed?.closest("[data-elpis-source]");
      const id = owner?.getAttribute("data-elpis-source");
      // The source mapper marks every DOM node in a component. Capture its outer row, not just the clicked text.
      while (owner?.parentElement && owner.parentElement.getAttribute("data-elpis-source") === id) owner = owner.parentElement;
      const region = owner ?? pointed;
      const map: Record<string, { component: string; file: string }> = await fetch("/elpis-source-map.json").then(response => { if (!response.ok) throw Error("This build has no Elpis source map. Rebuild the desktop app."); return response.json(); });
      if (!region || !id || !Object.hasOwn(map, id)) throw Error("This region has no source entry in this build. Rebuild the desktop app.");
      await paint();
      const box = region.getBoundingClientRect();
      const { image } = await window.elpisDesktop.improve.capture({ x: box.x, y: box.y, width: box.width, height: box.height });
      setTarget({ id, label: (region.getAttribute("aria-label") || region.textContent || "Elpis window").trim().slice(0, 300), image, ...map[id] });
    } catch (cause) { setError(message(cause)); }
    finally { setOpen(true); setBusy(false); }
  }, []);
  useEffect(() => {
    const point = (event: MouseEvent) => {
      pointed.current = event.target instanceof Element ? event.target : null;
      contextActive.current = true; setMenu(null); setFallback(null);
      if (!window.elpisDesktop?.improve?.onPoint) { event.preventDefault(); setFallback({ x: event.clientX, y: event.clientY }); }
    };
    const findMenu = () => {
      if (!contextActive.current) return;
      // A submenu (Base UI marks it data-nested) is not the menu that was right-clicked open.
      const found = [...document.querySelectorAll<HTMLElement>('[role="menu"]:not([data-improve-menu]):not([data-nested]), .hud-menu:not([data-improve-menu]):not([data-nested])')].filter(node => node.getClientRects().length).at(-1) ?? null;
      setMenu(found); if (found) setFallback(null);
    };
    const command = () => { void begin(null); };
    const closeMenu = (event: KeyboardEvent) => { if (event.key === "Escape") { contextActive.current = false; setFallback(null); setMenu(null); } };
    const dismiss = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest('[role="menu"], [data-improve-menu], .hud-menu')) { contextActive.current = false; setFallback(null); setMenu(null); } };
    const observer = new MutationObserver(findMenu); observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("contextmenu", point, true); document.addEventListener("keydown", closeMenu); document.addEventListener("pointerdown", dismiss);
    window.addEventListener("elpis:improve", command);
    const detach = window.elpisDesktop?.improve?.onPoint?.(({ x, y }) => { void begin(pointed.current ?? document.elementFromPoint(x, y)); });
    return () => { observer.disconnect(); detach?.(); document.removeEventListener("contextmenu", point, true); document.removeEventListener("keydown", closeMenu); document.removeEventListener("pointerdown", dismiss); window.removeEventListener("elpis:improve", command); };
  }, [begin]);
  useEffect(() => {
    let disposed = false;
    setChange(null); setReviewOpen(false); setNotice("");
    if (!threadId) return;
    // A chat with a review follows it closely; any other chat looks rarely, and only while the window is shown.
    let timer: ReturnType<typeof setInterval> | undefined;
    const slow = setInterval(() => { if (!timer) void refresh(); }, 15000);
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const list = await api<{ data: { id: string; threadId: string }[] }>("/improvements");
        const row = list.data?.find(row => row.threadId === threadId);
        if (row) { const next = await api<Change>(`/improvements/${row.id}`); if (!disposed) { setChange(next); timer ??= setInterval(() => { void refresh(); }, 2500); } }
      } catch { /* An ordinary chat has no improvement review. The open dialog reports its own request failures. */ }
    };
    void refresh();
    return () => { disposed = true; clearInterval(timer); clearInterval(slow); };
  }, [threadId]);
  useEffect(() => {
    if (!change || !["review", "checks-failed", "needs-check"].includes(change.status)) return;
    const version = `${change.id}/${change.status}/${change.checks?.head ?? ""}`;
    if (shownReview.current !== version) { shownReview.current = version; setReviewOpen(true); }
  }, [change]);
  async function start() {
    if (startReason || !target) return;
    setBusy(true); setError("");
    try {
      const next = await api<Change>("/improvements", { request, target: { id: target.id, label: target.label, image: target.image } });
      setOpen(false); await onChat(next.thread); setChange(next);
      if (next.error) { setError(next.error); setReviewOpen(true); }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!change) return;
    setBusy(true); setError(""); setNotice("");
    try { setChange(await api<Change>(`/improvements/${change.id}/check`, {})); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const startReason = busy ? "Wait for the current action to finish."
    : !target ? "Capture a region to change. Close this dialog and choose Change this… on the region again."
    : sourceLoading || source === null && !error ? "Looking for the Elpis source folder…"
    : !source?.configured ? "Choose an Elpis source folder to start a change."
    : !request.trim() ? "Describe what should change."
    : "";
  const failedCheck = change?.checks?.commands.find(command => command.code !== 0);
  const blockedReason = !change ? "Loading change…"
    : change.status === "checking" ? "Checking build and tests…"
    : busy ? "Wait for the current action to finish."
    : change.dirty ? "Commit this change, then run build and tests."
    : !change.checks ? "Run build and tests on this commit."
    : !change.checks.passed ? failedCheck ? `Check failed: ${failedCheck.command} (exit ${failedCheck.code}). See the output below.` : change.error || "Build or test checks failed. Run build and tests again."
    : !change.head || change.checks.head !== change.head ? "The commit changed after checks passed. Run build and tests again."
    : "";
  const changeItem = <button data-slot="change-menuitem" type="button" role="menuitem" className="elpis-change-menuitem" onClick={() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); void begin(pointed.current); }}>Change this…</button>;
  return <>
    {menu?.isConnected && createPortal(changeItem, menu)}
    {fallback && !menu && createPortal(<div data-improve-menu role="menu" className="elpis-change-menu" style={{ left: Math.min(fallback.x, window.innerWidth - 170), top: Math.min(fallback.y, window.innerHeight - 50) }}>{changeItem}</div>, document.body)}
    {change && <Button className="elpis-improve-review-button" variant="outline" onClick={() => { setError(""); setReviewOpen(true); }}>Review Elpis change</Button>}
    <AlertDialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <AlertDialogContent role="dialog" className="elpis-improve-dialog">
        <AlertDialogHeader><AlertDialogTitle>Improve Elpis</AlertDialogTitle><AlertDialogDescription>Describe the change. Elpis will open a chat in a separate source worktree.</AlertDialogDescription></AlertDialogHeader>
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3 text-sm">
          <div className="min-w-0 flex-1"><p className="font-medium">Elpis source folder</p><p className="truncate text-muted-foreground" title={source?.path || undefined}>{source?.path || "Choose the source checkout for your changes."}</p></div>
          <Button type="button" variant="outline" size="sm" disabled={busy || sourceLoading} onClick={() => void chooseSource()}>Choose source folder</Button>
        </div>
        {target && <div className="grid min-w-0 gap-2"><div className="min-w-0 text-sm text-muted-foreground"><p>{target.component}</p><p data-slot="improve-source-path" className="truncate font-mono text-xs" title={target.file}>{target.file}</p></div><div className="elpis-improve-preview"><img className="elpis-improve-region" src={target.image} alt={`Pointed region: ${target.label.slice(0, 80)}`} /></div></div>}
        <label className="grid gap-2 text-sm">What should change?<Textarea aria-label="What should change?" value={request} maxLength={16000} onChange={event => setRequest(event.target.value)} disabled={busy} autoFocus /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!!startReason} disabledReason={startReason} onClick={() => void start()}>{busy ? "Starting…" : "Start change"}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={reviewOpen} onOpenChange={value => { if (!busy) setReviewOpen(value); }}>
      <AlertDialogContent role="dialog" className="elpis-improve-dialog elpis-improve-review">
        <AlertDialogHeader><AlertDialogTitle>Review Elpis change</AlertDialogTitle><AlertDialogDescription>{change?.branch ?? "Loading change…"}</AlertDialogDescription></AlertDialogHeader>
        <p role="status" className="text-sm">{blockedReason || "Build and tests passed"}</p>
        {change?.dirty && <p className="text-sm">There are uncommitted changes. Commit and check them before continuing.</p>}
        {change?.diff && <div className="diff-body elpis-improve-diff">{change.diff.split(/(?=^diff --git )/m).filter(Boolean).map((file, index) => <section key={index}><p className="px-2 py-1 text-xs font-mono">{file.split("\n")[0]}</p>{/^@@ /m.test(file) ? <DiffLines lines={parseDiff(file)} /> : <pre className="elpis-improve-log">{file}</pre>}</section>)}</div>}
        {change?.truncated && <p className="text-sm">The diff is truncated. Review the full diff in the worktree.</p>}
        {change?.checks?.commands.map((command, index) => <details key={index} open={command.code !== 0} className="text-sm"><DisclosureSummary>{command.command} · exit {command.code}</DisclosureSummary><pre className="elpis-improve-log">{command.output || (command.code !== 0 ? `Check exited with code ${command.code} without output.` : "")}</pre></details>)}
        {(error || change?.error) && <p role="alert" className="text-sm text-destructive">{error || change?.error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={() => setReviewOpen(false)}>Close</Button><Button variant="outline" disabled={busy || change?.status === "checking"} title={change?.status === "checking" ? "Checking build and tests…" : busy ? "Wait for the current action to finish." : undefined} onClick={() => void check()}>Check build &amp; tests</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
