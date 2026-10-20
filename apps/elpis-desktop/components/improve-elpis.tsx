"use client";

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
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void api<{ path: string | null; configured: boolean }>("/improvements/source").then(value => { if (!disposed) setSource(value); }).catch(cause => { if (!disposed) setError(message(cause)); });
    return () => { disposed = true; };
  }, [open]);
  async function chooseSource() {
    setError("");
    try {
      const path = await window.elpisDesktop?.chooseFolder?.();
      if (!path) return;
      setBusy(true);
      setSource(await api<{ path: string; configured: boolean }>("/improvements/source", { path }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const shownReview = useRef<string | null>(null);
  const begin = useCallback(async (element: Element | null) => {
    contextActive.current = false; setMenu(null); setFallback(null); setError(""); setTarget(null); setRequest(""); setBusy(true);
    try {
      if (!window.elpisDesktop?.improve) throw Error("Open Elpis desktop to capture the region you want to change.");
      const region = element ?? document.querySelector(".app-shell"), owner = region?.closest("[data-elpis-source]");
      const id = owner?.getAttribute("data-elpis-source");
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
    if (!change || !["review", "checks-failed"].includes(change.status)) return;
    const version = `${change.id}/${change.status}/${change.checks?.head ?? ""}`;
    if (shownReview.current !== version) { shownReview.current = version; setReviewOpen(true); }
  }, [change]);
  async function start() {
    if (!target || busy) return;
    setBusy(true); setError("");
    try {
      const next = await api<Change>("/improvements", { request, target: { id: target.id, label: target.label, image: target.image } });
      setOpen(false); await onChat(next.thread); setChange(next);
      if (next.error) { setError(next.error); setReviewOpen(true); }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function action(kind: "check" | "keep" | "try") {
    if (!change) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (kind === "try") {
        if (!window.elpisDesktop?.improve) throw Error("Open the desktop app to try this change.");
        await window.elpisDesktop.improve.try(change.id); setNotice("Preview opened in a separate window.");
      } else {
        const next = await api<Change>(`/improvements/${change.id}/${kind}`, {}); setChange(next);
      }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const canKeep = !!change?.checks?.passed && !change.dirty && change.checks.head === change.head;
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
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void chooseSource()}>Choose source folder</Button>
        </div>
        {target && <><p className="text-sm text-muted-foreground">{target.component} · {target.file}</p><img className="elpis-improve-region" src={target.image} alt={`Pointed region: ${target.label.slice(0, 80)}`} /></>}
        <label className="grid gap-2 text-sm">What should change?<Textarea aria-label="What should change?" value={request} maxLength={16000} onChange={event => setRequest(event.target.value)} disabled={busy} autoFocus /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || !source?.configured || !target || !request.trim()} onClick={() => void start()}>{busy ? "Starting…" : "Start change"}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={reviewOpen} onOpenChange={value => { if (!busy) setReviewOpen(value); }}>
      <AlertDialogContent role="dialog" className="elpis-improve-dialog elpis-improve-review">
        <AlertDialogHeader><AlertDialogTitle>Review Elpis change</AlertDialogTitle><AlertDialogDescription>{change?.branch ?? "Loading change…"}</AlertDialogDescription></AlertDialogHeader>
        <p role="status" className="text-sm">{change?.status === "ready" ? "Ready for coordinator review. Your note has been written." : change?.status === "checking" ? "Checking build and tests…" : change?.dirty ? "Commit this change, then run build and tests before trying or keeping it." : change?.checks?.passed && change.checks.head !== change.head ? "The commit changed after checks passed. Run build and tests again before trying or keeping it." : canKeep ? "Build and tests passed" : change?.checks ? "Build or test checks failed" : "Run build and tests on this commit before trying or keeping it."}</p>
        {change?.dirty && <p className="text-sm">There are uncommitted changes. Commit and check them before continuing.</p>}
        {change?.diff && <div className="diff-body elpis-improve-diff">{change.diff.split(/(?=^diff --git )/m).filter(Boolean).map((file, index) => <section key={index}><p className="px-2 py-1 text-xs font-mono">{file.split("\n")[0]}</p>{/^@@ /m.test(file) ? <DiffLines lines={parseDiff(file)} /> : <pre className="elpis-improve-log">{file}</pre>}</section>)}</div>}
        {change?.truncated && <p className="text-sm">The diff is truncated. Review the full diff in the worktree before keeping.</p>}
        {change?.checks?.commands.map((command, index) => <details key={index} className="text-sm"><summary>{command.command} · exit {command.code}</summary><pre className="elpis-improve-log">{command.output}</pre></details>)}
        {(error || change?.error) && <p role="alert" className="text-sm text-destructive">{error || change?.error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={() => setReviewOpen(false)}>Close</Button><Button variant="outline" disabled={busy || change?.status === "checking"} onClick={() => void action("check")}>Check build &amp; tests</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
