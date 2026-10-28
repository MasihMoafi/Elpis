"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Textarea } from "@/components/ui/textarea";
import { api, unreadable } from "@/lib/api";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** What a slash command opens above the composer: it takes the focus, Escape closes it, and the page then gives the focus back to the composer. */
export function CommandPanel({ title, onClose, onBack, children }: { title: string; onClose: () => void; onBack?: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  // Whatever the panel shows first (a field, say) keeps the focus; otherwise the panel itself takes it.
  useEffect(() => { if (!panel.current?.contains(document.activeElement)) panel.current?.focus(); }, [title]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close.current(); } };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <section ref={panel} tabIndex={-1} role="dialog" aria-label={title} className="hud-popover mx-auto mb-2 w-full max-w-[var(--transcript-width,740px)] text-sm outline-none">
    <header className="mb-2 flex items-center gap-2">
      {onBack && <Button type="button" variant="ghost" size="icon-xs" aria-label="Back" onClick={onBack}><ArrowLeft size={14} /></Button>}
      <h2 className="hud-label min-w-0 flex-1 truncate">{title}</h2>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}><X size={14} /></Button>
    </header>
    {children}
  </section>;
}

/** The terminal's session card (/status and /usage): the configuration the next turn runs with, and how full the context window is. */
export function SessionPanel({ rows, threadId, onUsage, onClose }: { rows: [string, string][]; threadId?: string; onUsage: () => void; onClose: () => void }) {
  const [context, setContext] = useState("");
  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    api<{ tokenUsage: { last: { inputTokens?: number } | null; modelContextWindow: number | null } | null }>(`/threads/${encodeURIComponent(threadId)}/context`)
      .then(value => {
        const used = value.tokenUsage?.last?.inputTokens, window = value.tokenUsage?.modelContextWindow;
        if (disposed) return;
        setContext(typeof used === "number" && typeof window === "number" && window > 0 ? `${used.toLocaleString()} of ${window.toLocaleString()} tokens (${Math.round(Math.min(100, used / window * 100))}%)` : "Not reported yet");
      })
      .catch(() => { if (!disposed) setContext("Unavailable"); });
    return () => { disposed = true; };
  }, [threadId]);
  return <CommandPanel title="Session" onClose={onClose}>
    <dl className="grid gap-1">
      {[...rows, ...(threadId ? [["Context window", context || "Reading…"] as [string, string]] : [])].map(([label, value]) =>
        <div key={label} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
    </dl>
    <div className="mt-3"><Button type="button" variant="outline" size="sm" onClick={onUsage}>Usage &amp; limits</Button></div>
  </CommandPanel>;
}

export type ReviewTarget = { type: "uncommittedChanges" } | { type: "baseBranch"; branch: string } | { type: "commit"; sha: string; title: string } | { type: "custom"; instructions: string };
type Choices = { branches: string[]; current: string | null; commits: { sha: string; subject: string }[] };

/** The terminal's /review presets (codex-rs/tui/src/chatwidget/review_popups.rs): a base branch, the uncommitted changes, a commit, or your own instructions. */
export function ReviewPanel({ threadId, onStart, onClose }: { threadId: string; onStart: (target: ReviewTarget) => void; onClose: () => void }) {
  const [view, setView] = useState<"presets" | "branch" | "commit" | "custom">("presets");
  const [choices, setChoices] = useState<Choices | null>(null), [error, setError] = useState(""), [filter, setFilter] = useState(""), [instructions, setInstructions] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if ((view !== "branch" && view !== "commit") || choices) return;
    let disposed = false;
    api<Choices>(`/threads/${encodeURIComponent(threadId)}/git?view=review`).then(value => { if (!disposed) setChoices(value); }).catch(cause => { if (!disposed) setError(message(cause)); });
    return () => { disposed = true; };
  }, [view, choices, threadId]);
  const go = (next: typeof view) => { setView(next); setFilter(""); setError(""); };
  const start = () => { if (instructions.trim()) onStart({ type: "custom", instructions: instructions.trim() }); else field.current?.focus(); };
  const needle = filter.trim().toLowerCase();
  const list = (items: { key: string; label: string; detail?: string; pick: () => void }[], empty: string) => <>
    <SearchField autoFocus aria-label="Filter" placeholder="Type to filter" value={filter} onChange={event => setFilter(event.target.value)} className="mb-2" />
    {error ? <p role="alert" className="text-destructive">{error}</p> : !choices ? <p role="status" className="text-muted-foreground">Reading this folder…</p>
      : <div className="grid max-h-60 gap-1 overflow-y-auto">{items.filter(item => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle)).map(item =>
        <Button key={item.key} type="button" variant="ghost" className="h-auto justify-start gap-3 py-1.5 text-left font-normal" onClick={item.pick}><span className="min-w-0 break-words">{item.label}</span>{item.detail && <small className="ml-auto shrink-0 font-mono text-muted-foreground">{item.detail}</small>}</Button>)}
        {!items.length && <p className="text-muted-foreground">{empty}</p>}</div>}
  </>;
  if (view === "branch") return <CommandPanel title="Select a base branch" onClose={onClose} onBack={() => go("presets")}>
    {choices && <p className="mb-2 text-muted-foreground">Current branch: {choices.current ?? "(detached HEAD)"}</p>}
    {list((choices?.branches ?? []).map(branch => ({ key: branch, label: branch, pick: () => onStart({ type: "baseBranch", branch }) })), "No local branches.")}
  </CommandPanel>;
  if (view === "commit") return <CommandPanel title="Select a commit to review" onClose={onClose} onBack={() => go("presets")}>
    {list((choices?.commits ?? []).map(commit => ({ key: commit.sha, label: commit.subject, detail: commit.sha.slice(0, 7), pick: () => onStart({ type: "commit", sha: commit.sha, title: commit.subject }) })), "No commits yet.")}
  </CommandPanel>;
  if (view === "custom") return <CommandPanel title="Custom review instructions" onClose={onClose} onBack={() => go("presets")}>
    <Textarea ref={field} autoFocus aria-label="Custom review instructions" placeholder="Type instructions and press Enter" value={instructions} onChange={event => setInstructions(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); start(); } }} className="min-h-20" />
    <div className="mt-2 flex justify-end"><Button type="button" size="sm" onClick={start}>Start review</Button></div>
  </CommandPanel>;
  return <CommandPanel title="Select a review preset" onClose={onClose}>
    <div className="grid gap-1">
      <Button type="button" variant="ghost" className="h-auto justify-start gap-2 py-1.5 font-normal" onClick={() => go("branch")}>Review against a base branch<small className="text-muted-foreground">(PR Style)</small></Button>
      <Button type="button" variant="ghost" className="h-auto justify-start py-1.5 font-normal" onClick={() => onStart({ type: "uncommittedChanges" })}>Review uncommitted changes</Button>
      <Button type="button" variant="ghost" className="h-auto justify-start py-1.5 font-normal" onClick={() => go("commit")}>Review a commit</Button>
      <Button type="button" variant="ghost" className="h-auto justify-start py-1.5 font-normal" onClick={() => go("custom")}>Custom review instructions</Button>
    </div>
  </CommandPanel>;
}

const diffTone = (line: string) => line.startsWith("+") && !line.startsWith("+++") ? "text-success" : line.startsWith("-") && !line.startsWith("---") ? "text-destructive" : line.startsWith("@@") ? "text-muted-foreground" : "";

/** The terminal's /diff: the working tree's changes against HEAD, untracked files included. */
export function DiffPanel({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [result, setResult] = useState<{ diff: string; truncated: boolean } | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    api<{ diff: string; truncated: boolean }>(`/threads/${encodeURIComponent(threadId)}/git?view=diff`).then(value => { if (typeof value.diff !== "string") throw unreadable("diff"); if (!disposed) setResult(value); }).catch(cause => { if (!disposed) setError(message(cause)); });
    return () => { disposed = true; };
  }, [threadId]);
  return <CommandPanel title="Changes" onClose={onClose}>
    {error ? <p role="alert" className="text-destructive">{error}</p> : !result ? <p role="status" className="text-muted-foreground">Reading the changes…</p>
      : !result.diff.trim() ? <p className="text-muted-foreground">No changes in this folder.</p>
      : <><pre className="max-h-80 overflow-auto rounded-md border bg-background p-2 font-mono text-xs leading-relaxed">{result.diff.split("\n").map((line, index) => <span key={index} className={`block whitespace-pre ${diffTone(line)}`}>{line || " "}</span>)}</pre>
        {result.truncated && <p className="mt-2 text-muted-foreground">Showing the first part only; the changes are larger than this view keeps.</p>}</>}
  </CommandPanel>;
}
