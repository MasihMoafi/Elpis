"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { FilePathText } from "@/components/file-ref";
import { Button } from "@/components/ui/button";
import { RefreshButton, Segmented, SettingsEmpty, SettingsNotice } from "@/components/settings/rows";
import { api } from "@/lib/api";
import { compactTokens as tokens } from "@/lib/tokens";

type Totals = { attempts: number; compacted: number; unchanged: number; failed: number; examined: number; shortened: number; before: number; after: number; saved: number; unlinked: number; prunerTokens: number; prunerRuns: number };
type Chat = { id: string; found: boolean | null; chat: { name?: string | null; preview?: string } | null; totals: Totals };
type Page<T> = { data: T[]; nextCursor: string | null };
type Overview = { available: boolean; records: string; totals: Totals; skipped: { unreadable: number; unlinkedAdmissions: number }; chats: Page<Chat> };
type Output = { callId: string; tool: string | null; sourceTokens: number | null; decision: "compact" | "unchanged" | null; admitted: boolean; admittedTokens: number | null; saved: number | null };
type Run = { id: string; at: string | null; status: string; outcome: "compacted" | "unchanged" | "failed"; model: string | null; effort: string | null; candidates: number; shortened: number; saved: number; latencyMs: number | null; prunerTokens: number | null; error: string | null; items: Output[]; admission: { before: number; after: number; saved: number; requestSequence: number | null } | null };
type Turn = { turnId: string; contextTokens: number | null; window: number | null; requests: number; saved: number };
type Detail = Chat & { turns: { available: boolean; reason?: string; data?: Turn[] }; attempts: Page<Run> };
type Filter = "" | Run["outcome"];
const count = (value: number) => value.toLocaleString("en-US");
const estimate = (value: number) => `≈${tokens(value)}`;
const chatName = (chat: Chat) => chat.chat?.name || chat.chat?.preview || `${chat.found === false ? "Deleted chat" : "Chat"} · ${chat.id.slice(-8)}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function Stats({ totals: t }: { totals: Totals }) {
  const cards = [
    ["Smart Prune runs", count(t.attempts), `${count(t.compacted)} compacted · ${count(t.unchanged)} unchanged · ${count(t.failed)} failed`],
    ["Tokens saved", estimate(t.saved), `${estimate(t.before)} → ${estimate(t.after)} in ${count(t.shortened)} of ${count(t.examined)} outputs`],
    ["Pruner's own tokens", tokens(t.prunerTokens), `Input + output over ${count(t.prunerRuns)} runs · not recorded for ${count(t.attempts - t.prunerRuns)}`],
  ];
  return <><div className="observability-stats">{cards.map(([label, value, caption]) => <div className="settings-card stat-card stat" key={label}><div className="stat-title">{label}</div><div className="stat-value">{value}</div><div className="stat-desc">{caption}</div></div>)}</div>
    {t.unlinked > 0 && <SettingsNotice>Before and after not recorded for {count(t.unlinked)} compacted runs.</SettingsNotice>}</>;
}

function context(turn: Turn) {
  if (turn.contextTokens === null) return "not measured";
  return `${tokens(turn.contextTokens)}${turn.window ? ` of ${tokens(turn.window)}` : ""} tokens in context, ${turn.requests} ${turn.requests === 1 ? "request" : "requests"}${turn.saved ? `; Smart Prune saved ${estimate(turn.saved)}` : ""}`;
}

function ContextTurns({ turns }: { turns: Detail["turns"] }) {
  const data = turns.data ?? [], latest = data.findLast(turn => turn.contextTokens !== null);
  return <section aria-label="Context over the turns"><div className="customize-title"><h3>Context over the turns</h3></div>
    {!turns.available ? <SettingsNotice>{turns.reason === "chat-missing" ? "Not recorded: Elpis no longer has this chat, so its turns can't be read." : "Not recorded: this chat's context history is unavailable."}</SettingsNotice>
      : !data.length ? <SettingsEmpty title="No turns recorded yet" /> : <>
        <figure className="context-turns"><ol aria-label="Context per turn">{data.map((turn, index) => <li key={turn.turnId} tabIndex={0} aria-label={`Turn ${index + 1}: ${context(turn)}`}>
          {turn.contextTokens !== null && turn.window !== null && turn.window > 0 && <i style={{ height: `${Math.min(100, Math.max(0, 100 * turn.contextTokens / turn.window))}%` }} />}
          <span className="context-turn-tip" role="tooltip">{turn.contextTokens === null ? "Not measured" : `${tokens(turn.contextTokens)}${turn.window ? ` of ${tokens(turn.window)}` : ""} tokens`}<br />Turn {index + 1}</span><span className="context-turn-number">{index + 1}</span>
        </li>)}</ol><figcaption>{latest ? `Latest ${tokens(latest.contextTokens!)}${latest.window ? ` of ${tokens(latest.window)} (${Math.round(100 * latest.contextTokens! / latest.window)}%)` : " tokens · window not recorded"}` : "Context not measured"} · Each bar is a turn's last measured context as a share of its window.</figcaption></figure>
        <details className="observability-table"><summary>Turn measurements</summary><table><thead><tr><th>Turn</th><th>Context</th><th>Window</th><th>Requests</th><th>Saved</th></tr></thead><tbody>{data.map((turn, index) => <tr key={turn.turnId}><td>{index + 1}</td><td>{turn.contextTokens === null ? "Not measured" : tokens(turn.contextTokens)}</td><td>{turn.window === null ? "Not recorded" : tokens(turn.window)}</td><td>{turn.requests}</td><td>{estimate(turn.saved)}</td></tr>)}</tbody></table></details>
      </>}
  </section>;
}

function outputWhy(item: Output, run: Run) {
  if (item.admitted && item.admittedTokens !== null) return `Shortened to ${estimate(item.admittedTokens)} tokens, ${item.saved === null ? "savings not recorded" : `${estimate(item.saved)} saved`}`;
  if (run.outcome === "failed") return "Kept: the run failed";
  if (item.decision === "unchanged") return "Kept: the pruner left it as it was";
  if (item.decision === "compact" && run.outcome === "unchanged") return "Kept: the shorter text saved under 256 tokens or under 20%";
  return "Not recorded whether this output was shortened";
}

function PruneRun({ run }: { run: Run }) {
  const label = run.status === "model_error" ? "Model error" : run.outcome === "compacted" ? "Compacted" : run.outcome === "unchanged" ? "Unchanged" : "Failed";
  return <details className="observability-run"><summary><span className="customize-badge">{label}</span><span>{run.at ? new Date(run.at).toLocaleString() : "Time not recorded"}</span><span className="customize-description"><FilePathText text={run.error || `${estimate(run.saved)} saved`} /></span></summary>
    <div className="observability-run-body"><p>{run.model || "Model not recorded"}{run.effort ? ` · ${run.effort} effort` : ""} · {run.latencyMs === null ? "Timing not recorded" : `${(run.latencyMs / 1000).toFixed(1)}s`} · {run.prunerTokens === null ? "Pruner tokens not recorded" : `${tokens(run.prunerTokens)} pruner tokens`}</p>
      {run.admission && <p>Shortened {run.shortened} of {run.candidates} outputs · {estimate(run.admission.before)} → {estimate(run.admission.after)} · {estimate(run.admission.saved)} saved</p>}
      <ul className="customize-list">{run.items.map(item => <li className="observability-output" key={item.callId}><span>{item.tool || "Unknown tool"} · {item.sourceTokens === null ? "Tokens not recorded" : `${estimate(item.sourceTokens)} tokens`}</span><span className="customize-description">{outputWhy(item, run)}</span></li>)}</ul>
      {run.outcome === "compacted" && <p>{run.admission?.requestSequence != null ? `The main model got the shortened text in request ${run.admission.requestSequence}` : "Not recorded whether the main model got the shortened text"}</p>}
      {!run.items.length && <p>Output decisions not recorded.</p>}
    </div></details>;
}

export function ObservabilityView({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null), [selected, setSelected] = useState<Chat | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [filter, setFilter] = useState<Filter>(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function loadOverview(more = false) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const next = await api<Overview>(`/observability?limit=20${more && overview?.chats.nextCursor ? `&cursor=${encodeURIComponent(overview.chats.nextCursor)}` : ""}`);
      if (current === request.current) setOverview(previous => more && previous ? { ...next, chats: { ...next.chats, data: [...previous.chats.data, ...next.chats.data] } } : next);
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function loadChat(chat: Chat, status: Filter, more = false) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const next = await api<Detail>(`/observability/chats/${encodeURIComponent(chat.id)}?limit=25${status ? `&status=${status}` : ""}${more && detail?.attempts.nextCursor ? `&cursor=${encodeURIComponent(detail.attempts.nextCursor)}` : ""}`);
      if (current === request.current) setDetail(previous => more && previous ? { ...next, attempts: { ...next.attempts, data: [...previous.attempts.data, ...next.attempts.data] } } : next);
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  useEffect(() => { void loadOverview(); return () => { request.current++; }; }, []); // Initial read; subsequent reads are explicit actions.
  const choose = (chat: Chat) => { setSelected(chat); setDetail(null); setFilter(""); void loadChat(chat, ""); };
  return <div className="customize observability" aria-label="Observability">
    {selected && <button type="button" className="back-link" onClick={() => { request.current++; setBusy(false); setError(""); setSelected(null); }}><ArrowLeft size={18} />All chats</button>}
    {error && <SettingsNotice tone="alert"><FilePathText text={error} /> <Button variant="ghost" size="sm" onClick={() => void (selected ? loadChat(selected, filter) : loadOverview())}>Retry</Button></SettingsNotice>}
    {busy && <SettingsNotice>Reading records…</SettingsNotice>}
    {!selected && overview && <>
      <section aria-label="Smart Prune"><div className="customize-title"><h2>Smart Prune</h2><RefreshButton onClick={() => void loadOverview()} disabled={busy} /></div><p className="customize-note">Recorded pruning activity. Token savings are estimates; the pruner's own usage is shown separately.</p><Stats totals={overview.totals} /><p className="customize-note">Records: <code>{overview.records}</code></p>
        {overview.skipped.unreadable > 0 && <SettingsNotice>{count(overview.skipped.unreadable)} unreadable records are not counted.</SettingsNotice>}
        {!overview.chats.data.length && <SettingsEmpty title="No Smart Prune records yet">Records appear here after Smart Prune runs.</SettingsEmpty>}
      </section>
      {!!overview.chats.data.length && <section aria-label="Chats"><div className="customize-title"><h2>Chats</h2></div><p className="customize-note">Choose a chat to inspect its context and pruning records.</p>
        {overview.skipped.unlinkedAdmissions > 0 && <p className="customize-note">{count(overview.skipped.unlinkedAdmissions)} admission folders have no matching run, so they are not counted.</p>}
        <ul className="customize-list">{overview.chats.data.map(chat => <li className="customize-item" key={chat.id}><button type="button" className="customize-text observability-chat" aria-label={chatName(chat)} onClick={() => choose(chat)}><span className="customize-name">{chatName(chat)}</span><span className="customize-description">{count(chat.totals.attempts)} runs · {estimate(chat.totals.saved)} saved</span></button>{chat.found === true && <Button variant="ghost" size="sm" onClick={() => onOpenChat(chat.id)}>Open chat</Button>}</li>)}</ul>
        {overview.chats.nextCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadOverview(true)}>Show more chats</Button>}
      </section>}
    </>}
    {selected && <section aria-label={chatName(selected)}><div className="customize-title"><h2>{chatName(selected)}</h2>{selected.found === true && <Button variant="outline" size="sm" onClick={() => onOpenChat(selected.id)}>Open chat</Button>}</div>
      {selected.found === false && <p className="customize-note">Elpis no longer has this chat; its Smart Prune records remain.</p>}
      {detail && <><Stats totals={detail.totals} /><ContextTurns turns={detail.turns} /><section aria-label="Smart Prune runs"><div className="customize-title"><h3>Smart Prune runs</h3></div><Segmented label="Run status" value={filter} disabled={busy} options={[{ value: "", label: "All" }, { value: "compacted", label: "Compacted" }, { value: "unchanged", label: "Unchanged" }, { value: "failed", label: "Failed" }]} onChange={status => { setFilter(status); setDetail(previous => previous ? { ...previous, attempts: { data: [], nextCursor: null } } : null); void loadChat(selected, status); }} />
        {detail.attempts.data.map(run => <PruneRun key={run.id} run={run} />)}
        {!busy && !detail.attempts.data.length && <SettingsEmpty title="No matching runs" />}
        {detail.attempts.nextCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadChat(selected, filter, true)}>Show more runs</Button>}
      </section></>}
    </section>}
  </div>;
}
