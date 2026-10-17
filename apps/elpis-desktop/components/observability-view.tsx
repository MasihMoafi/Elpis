"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { FilePathText, FileRefLink } from "@/components/file-ref";
import { LedgerBar, LedgerRows, type Ledger } from "@/components/context-usage";
import { Button } from "@/components/ui/button";
import { RefreshButton, SettingsEmpty, SettingsNotice } from "@/components/settings/rows";
import { api } from "@/lib/api";
import { compactTokens as tokens } from "@/lib/tokens";

// Laid out as Langfuse lays out traces: a list of chats; a chat opens as a timeline of its turns; a turn opens to its steps
// (model calls, tool calls, Smart Prune); the selected turn's context by category in the Ledger's colours and words.
type Totals = { attempts: number; compacted: number; unchanged: number; failed: number; examined: number; shortened: number; before: number; after: number; saved: number; unlinked: number; prunerTokens: number; prunerRuns: number };
type Chat = { id: string; found: boolean | null; chat: { name?: string | null; preview?: string } | null; totals: Totals };
type Page<T> = { data: T[]; nextCursor: string | null };
type Overview = { available: boolean; records: string; totals: Totals; skipped: { unreadable: number; unlinkedAdmissions: number }; chats: Page<Chat> };
type Output = { callId: string; tool: string | null; sourceTokens: number | null; decision: "compact" | "unchanged" | null; admitted: boolean; admittedTokens: number | null; saved: number | null };
type Run = { id: string; turnId: string | null; at: string | null; status: string; outcome: "compacted" | "unchanged" | "failed"; model: string | null; effort: string | null; candidates: number; shortened: number; saved: number; latencyMs: number | null; prunerTokens: number | null; error: string | null; items: Output[]; admission: { before: number; after: number; saved: number; requestSequence: number | null } | null };
type Step = { at: string | null } & ({ kind: "tool"; name: string; detail: string | null } | { kind: "model"; input: number | null; cached: number | null; output: number | null; context: number });
type Turn = { turnId: string; at: string | null; contextTokens: number | null; window: number | null; requests: number; saved: number; steps: Step[]; stepsMore: number; ledger: Ledger | null };
type Detail = Chat & { record: string | null; turns: { available: boolean; reason?: string; data?: Turn[] }; attempts: Page<Run> };
type Item = Step | { kind: "prune"; at: string | null; run: Run };
type Entry = { key: string; at: string | null; turn: Turn | null; items: Item[]; prunes: number };

const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, word: string, many = `${word}s`) => `${count(value)} ${value === 1 ? word : many}`;
const estimate = (value: number) => `≈${tokens(value)}`;
const chatName = (chat: Chat) => chat.chat?.name || chat.chat?.preview || `${chat.found === false ? "Deleted chat" : "Chat"} · ${chat.id.slice(-8)}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const clock = (at: string | null) => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hourCycle: "h23" }) : "--:--:--";
const when = (at: string | null) => { const time = Date.parse(at ?? ""); return Number.isFinite(time) ? time : Infinity; };
const percent = (part: number, whole: number) => `${Math.round(100 * part / whole)}%`;

/** The chat's turns in order, each with its steps and its Smart Prunes placed by time. Runs whose turn the chat cannot
 * show (the chat is gone, or the turn is not in its saved items) get a turn of their own, so no record is dropped. */
function timeline(detail: Detail, runs: Run[]): Entry[] {
  const turns = detail.turns.data ?? [], known = new Set(turns.map(turn => turn.turnId));
  const byTurn = (id: string | null) => runs.filter(run => run.turnId === id);
  const place = (steps: Step[], own: Run[]): Item[] => [...steps, ...own.map((run): Item => ({ kind: "prune", at: run.at, run }))].sort((a, b) => when(a.at) - when(b.at));
  const entries: Entry[] = turns.map(turn => ({ key: turn.turnId, at: turn.at, turn, items: place(turn.steps, byTurn(turn.turnId)), prunes: byTurn(turn.turnId).length }));
  const orphans = [...new Set(runs.filter(run => !known.has(run.turnId ?? "")).map(run => run.turnId))];
  for (const id of orphans) { const own = byTurn(id); entries.push({ key: id ?? "no-turn", at: own[0]?.at ?? null, turn: null, items: place([], own), prunes: own.length }); }
  return entries.sort((a, b) => when(a.at) - when(b.at));
}

function turnMeta(entry: Entry) {
  const parts: string[] = [], { turn } = entry;
  if (turn) {
    if (turn.contextTokens === null) parts.push("Not measured");
    else { parts.push(`${tokens(turn.contextTokens)}${turn.window ? ` of ${tokens(turn.window)}` : ""} tokens`); parts.push(plural(turn.requests, "request")); }
  }
  if (entry.prunes) parts.push(plural(entry.prunes, "Smart Prune"));
  return parts.join(" · ");
}

function outputLine(item: Output, run: Run) {
  const tool = item.tool || "Unknown tool", source = item.sourceTokens === null ? "Tokens not recorded" : estimate(item.sourceTokens);
  if (item.admitted && item.admittedTokens !== null) {
    const removed = item.saved === null ? "Removed: not recorded" : `Removed ${estimate(item.saved)}${item.sourceTokens ? ` (${percent(item.saved, item.sourceTokens)})` : ""}`;
    return [tool, `${source} → ${estimate(item.admittedTokens)}`, removed];
  }
  const why = run.outcome === "failed" ? "Kept: the run failed"
    : item.decision === "unchanged" ? "Kept: the pruner left it as it was"
    : item.decision === "compact" && run.outcome === "unchanged" ? "Kept: the shorter text saved under 256 tokens or under 20%"
    : "Not recorded whether this output was shortened";
  return [tool, source, why];
}

function pruneSummary(run: Run) {
  if (run.outcome === "failed") return `${run.status === "model_error" ? "Model error" : "Failed"} · ${run.error || "no reason recorded"}`;
  const shortened = `${run.shortened} of ${run.candidates} ${run.candidates === 1 ? "output" : "outputs"} shortened`;
  if (run.outcome === "unchanged") return `Unchanged · ${shortened}`;
  return `Compacted · ${shortened}${run.admission ? ` · ${estimate(run.admission.before)} → ${estimate(run.admission.after)}` : ""} · ${estimate(run.saved)} saved`;
}

function PruneStep({ run, record }: { run: Run; record: string | null }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="trace-head" aria-expanded={open} onClick={() => setOpen(value => !value)}><span className="customize-badge">Smart Prune</span><span className="trace-text">{pruneSummary(run)}</span></button>
    {open && <div className="trace-body">
      <p>{run.model || "Model not recorded"}{run.effort ? ` · ${run.effort} effort` : ""} · {run.latencyMs === null ? "Timing not recorded" : `${(run.latencyMs / 1000).toFixed(1)}s`} · {run.prunerTokens === null ? "Pruner tokens not recorded" : `${tokens(run.prunerTokens)} pruner tokens`}</p>
      <ul className="trace-outputs">{run.items.map(item => <li className="trace-output" key={item.callId}>{outputLine(item, run).map((part, index) => <span key={index}>{part}</span>)}</li>)}</ul>
      {!run.items.length && <p>Output decisions not recorded.</p>}
      {run.outcome === "compacted" && <p>{run.admission?.requestSequence != null ? `The main model got the shortened text in request ${run.admission.requestSequence}` : "Not recorded whether the main model got the shortened text"}</p>}
      <p>{record ? <FileRefLink target={{ path: record }}>Open record</FileRefLink> : "No readable record has been written for this chat yet."}</p>
    </div>}
  </>;
}

function StepRow({ item, record }: { item: Item; record: string | null }) {
  return <li className="trace-step" data-kind={item.kind}>
    <time>{clock(item.at)}</time>
    {item.kind === "prune" ? <PruneStep run={item.run} record={record} />
      : item.kind === "tool" ? <div className="trace-head"><span className="customize-badge">Tool call</span><span className="trace-text">{item.name}{item.detail ? ` · ${item.detail}` : ""}</span></div>
      : <div className="trace-head"><span className="customize-badge">Model call</span><span className="trace-text">{[item.input === null ? null : `${tokens(item.input)} in`, item.output === null ? null : `${tokens(item.output)} out`, item.cached ? `${tokens(item.cached)} cached` : null, `${tokens(item.context)} in context`].filter(Boolean).join(" · ")}</span></div>}
  </li>;
}

function TurnContext({ entry, number }: { entry: Entry; number: number }) {
  const turn = entry.turn, ledger = turn?.ledger ?? null;
  return <section className="trace-context" aria-label={`Context in turn ${number}`}><h3>Context in turn {number}</h3>
    {!turn ? <p className="customize-note">Not recorded: this turn is not in the chat's saved items.</p>
      : turn.contextTokens === null ? <p className="customize-note">Not measured: no request finished in this turn.</p> : <>
        <p className="customize-note">{tokens(turn.contextTokens)}{turn.window ? ` of ${tokens(turn.window)} tokens in context (${percent(turn.contextTokens, turn.window)})` : " tokens in context · window not recorded"}{turn.saved ? ` · Smart Prune saved ${estimate(turn.saved)}` : ""}</p>
        {ledger?.categories.length ? <><LedgerBar ledger={ledger} /><LedgerRows ledger={ledger} />
          <p className="customize-note">{ledger.basis === "engine" ? "Measured total · estimated category shares" : "Measured total · category shares estimated from the saved chat"}</p></>
          : <p className="customize-note">Categories not recorded for this turn.</p>}
      </>}
  </section>;
}

function Timeline({ detail, runs }: { detail: Detail; runs: Run[] }) {
  const entries = timeline(detail, runs);
  const latest = entries.findLastIndex(entry => entry.turn?.contextTokens != null);
  const [picked, setPicked] = useState<string | null>(null), [open, setOpen] = useState<string[]>([]);
  const selected = entries.find(entry => entry.key === picked) ?? entries[latest] ?? null;
  const choose = (entry: Entry) => { setPicked(entry.key); setOpen(keys => entry.key === selected?.key && keys.includes(entry.key) ? keys.filter(key => key !== entry.key) : keys.includes(entry.key) ? keys : [...keys, entry.key]); };
  const reason = detail.turns.reason === "chat-missing" ? "Elpis no longer has this chat, so its turns can't be read." : "this chat's context history is unavailable.";
  return <section aria-label="Timeline">
    <div className="customize-title"><h3>Turns</h3></div>
    {!detail.turns.available && <SettingsNotice>Turns not recorded: {reason}</SettingsNotice>}
    {!entries.length ? <SettingsEmpty title="No turns recorded yet" /> : <div className="trace-layout">
      <ol className="trace-turns" aria-label="Turns">{entries.map((entry, index) => {
        const isOpen = open.includes(entry.key), fill = entry.turn?.contextTokens != null && entry.turn.window ? Math.min(100, 100 * entry.turn.contextTokens / entry.turn.window) : null;
        return <li key={entry.key} data-selected={entry.key === selected?.key || undefined}>
          <button type="button" className="trace-turn" aria-expanded={isOpen} onClick={() => choose(entry)}>
            <span className="trace-turn-name">Turn {index + 1}</span><time>{clock(entry.at)}</time><span className="trace-turn-meta">{turnMeta(entry)}</span>
            {fill !== null && <span className="trace-fill" aria-hidden="true"><i style={{ width: `${fill}%` }} /></span>}
          </button>
          {isOpen && (entry.items.length ? <ol className="trace-steps" aria-label={`Steps of turn ${index + 1}`}>{entry.items.map((item, at) => <StepRow key={at} item={item} record={detail.record} />)}</ol> : <p className="trace-none">No steps recorded for this turn.</p>)}
          {isOpen && entry.turn && entry.turn.stepsMore > 0 && <p className="trace-none">{plural(entry.turn.stepsMore, "more step")} not shown.</p>}
        </li>;
      })}</ol>
      {selected && <TurnContext entry={selected} number={entries.indexOf(selected) + 1} />}
    </div>}
  </section>;
}

export function ObservabilityView({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null), [selected, setSelected] = useState<Chat | null>(null), [detail, setDetail] = useState<Detail | null>(null), [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function loadOverview(more = false) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const next = await api<Overview>(`/observability?limit=20${more && overview?.chats.nextCursor ? `&cursor=${encodeURIComponent(overview.chats.nextCursor)}` : ""}`);
      if (current === request.current) setOverview(previous => more && previous ? { ...next, chats: { ...next.chats, data: [...previous.chats.data, ...next.chats.data] } } : next);
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  /** A chat's timeline needs all of its runs, so every page is read (a hundred at a time). */
  async function loadChat(chat: Chat) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      let cursor = "", first: Detail | null = null; const all: Run[] = [];
      do {
        const page = await api<Detail>(`/observability/chats/${encodeURIComponent(chat.id)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (current !== request.current) return;
        first ??= page; all.push(...page.attempts.data); cursor = page.attempts.nextCursor ?? "";
      } while (cursor);
      setDetail(first); setRuns(all.reverse());
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  useEffect(() => { void loadOverview(); return () => { request.current++; }; }, []); // Initial read; subsequent reads are explicit actions.
  const choose = (chat: Chat) => { setSelected(chat); setDetail(null); setRuns([]); void loadChat(chat); };
  return <div className="customize observability" aria-label="Observability">
    {selected && <button type="button" className="back-link" onClick={() => { request.current++; setBusy(false); setError(""); setSelected(null); }}><ArrowLeft size={18} />All chats</button>}
    {error && <SettingsNotice tone="alert"><FilePathText text={error} /> <Button variant="ghost" size="sm" onClick={() => void (selected ? loadChat(selected) : loadOverview())}>Retry</Button></SettingsNotice>}
    {busy && <SettingsNotice>Reading records…</SettingsNotice>}
    {!selected && overview && <>
      <section aria-label="Smart Prune"><div className="customize-title"><h2>Smart Prune</h2><RefreshButton onClick={() => void loadOverview()} disabled={busy} /></div>
        {overview.chats.data.length > 0 && <p className="customize-note">{plural(overview.totals.attempts, "run")} · {estimate(overview.totals.saved)} tokens saved (estimated) · {count(overview.totals.compacted)} compacted, {count(overview.totals.unchanged)} unchanged, {count(overview.totals.failed)} failed.</p>}
        {overview.chats.data.length > 0 && <p className="customize-note">Records: <code>{overview.records}</code></p>}
        {overview.totals.unlinked > 0 && <SettingsNotice>Before and after not recorded for {plural(overview.totals.unlinked, "compacted run")}.</SettingsNotice>}
        {overview.skipped.unreadable > 0 && <SettingsNotice>{count(overview.skipped.unreadable)} unreadable records are not counted.</SettingsNotice>}
        {!overview.chats.data.length && <SettingsEmpty title="No Smart Prune records yet">Records appear here after Smart Prune runs.</SettingsEmpty>}
      </section>
      {!!overview.chats.data.length && <section aria-label="Chats"><div className="customize-title"><h2>Chats</h2></div><p className="customize-note">Choose a chat to see its turns and what Smart Prune did in them.</p>
        {overview.skipped.unlinkedAdmissions > 0 && <p className="customize-note">{count(overview.skipped.unlinkedAdmissions)} admission folders have no matching run, so they are not counted.</p>}
        <ul className="customize-list">{overview.chats.data.map(chat => <li className="customize-item trace-row" key={chat.id}><button type="button" className="customize-text observability-chat" aria-label={chatName(chat)} onClick={() => choose(chat)}><span className="customize-name">{chatName(chat)}</span><span className="customize-description">{plural(chat.totals.attempts, "run")} · {estimate(chat.totals.saved)} saved</span></button>{chat.found === true && <Button variant="ghost" size="sm" onClick={() => onOpenChat(chat.id)}>Open chat</Button>}</li>)}</ul>
        {overview.chats.nextCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadOverview(true)}>Show more chats</Button>}
      </section>}
    </>}
    {selected && <section aria-label={chatName(selected)}><div className="customize-title"><h2>{chatName(selected)}</h2>{selected.found === true && <Button variant="outline" size="sm" onClick={() => onOpenChat(selected.id)}>Open chat</Button>}</div>
      {selected.found === false && <p className="customize-note">Elpis no longer has this chat; its Smart Prune records remain.</p>}
      {detail && <>
        <p className="customize-note">{plural(detail.totals.attempts, "run")} · {estimate(detail.totals.saved)} tokens saved (estimated){detail.record && <> · <FileRefLink target={{ path: detail.record }}>Open record</FileRefLink></>}</p>
        <p className="customize-note">Cost is not recorded by Elpis. Tokens are the engine's own counts; savings are estimates.</p>
        <Timeline detail={detail} runs={runs} />
      </>}
    </section>}
  </div>;
}
