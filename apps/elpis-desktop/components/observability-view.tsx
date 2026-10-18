"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ChatMessage, CommandStep } from "@/components/chat-message";
import { Step } from "@/components/step";
import { FilePathText, FileRefLink } from "@/components/file-ref";
import { LedgerBar, LedgerRows, type Ledger } from "@/components/context-usage";
import { Button } from "@/components/ui/button";
import { RefreshButton, SettingsEmpty, SettingsNotice } from "@/components/settings/rows";
import { api, mediaUrl, modelLabel, title, type Item, type Thread } from "@/lib/api";
import { stepFailed, stepLabel } from "@/lib/steps";
import { compactTokens as tokens } from "@/lib/tokens";

type Totals = { attempts: number; saved: number };
type Chat = { id: string; found: boolean; chat: Thread; totals: Totals };
type Page<T> = { data: T[]; nextCursor: string | null };
type Overview = { totals: Totals; chats: Page<Chat> };
type Agent = { id: string; name: string; model: string | null; role: string | null };
type Prune = { id: string; outcome: string; status: string; error: string | null; saved: number; shortened: number; candidates: number };
type Turn = { turnId: string; status: string; error: { message?: string } | null; items: Item[]; contextTokens: number | null; window: number | null; outputTokens: number | null; requests: number; saved: number; ledger: Ledger | null; prunes: Prune[] };
type Detail = Chat & { agentId: string; agents: Agent[]; record: string | null; turns: Page<Turn> };
const plural = (value: number, word: string) => `${value.toLocaleString("en-US")} ${word}${value === 1 ? "" : "s"}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const short = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";

/** Keep the chat's work components, with a short sentence in the closed row and full recorded details inside. */
function Work({ item }: { item: Item }) {
  if (item.type === "commandExecution") return <CommandStep item={item} open={false} />;
  if (item.type === "collabAgentToolCall") return <ChatMessage item={item} activityLabel={item.prompt ? `Asked a subagent: ${short(item.prompt)}` : "Worked with a subagent"} />;
  if (item.type === "fileChange") return <Step title={<FilePathText text={stepLabel(item)} />} failed={stepFailed(item)} body={<ChatMessage item={item} />} />;
  return <ChatMessage item={item} />;
}

function TurnLedger({ turn }: { turn: Turn }) {
  return <details className="observed-metrics">
    <summary>Context {turn.contextTokens === null ? "not measured" : `${tokens(turn.contextTokens)}${turn.window ? ` / ${tokens(turn.window)}` : ""}`} · {turn.outputTokens === null ? "Output not measured" : `${tokens(turn.outputTokens)} output tokens`} · {plural(turn.requests, "request")} · Smart Prune ≈{tokens(turn.saved)} saved</summary>
    <LedgerBar ledger={turn.ledger} />
    {turn.ledger?.categories.length ? <><LedgerRows ledger={turn.ledger} /><p className="customize-note">Measured total · category shares estimated{turn.ledger.basis === "transcript" ? " from the saved chat" : ""}.</p></> : <p className="customize-note">Category shares not recorded for this turn.</p>}
    {turn.prunes.map(run => <p key={run.id} className="customize-note">Smart Prune: {run.outcome === "failed" ? `failed · ${run.error || "No reason recorded"}` : `${run.outcome} · ${run.shortened} of ${run.candidates} outputs shortened · ≈${tokens(run.saved)} saved`}.</p>)}
  </details>;
}

function AgentTurns({ rootId, agent, initial }: { rootId: string; agent: Agent; initial?: Detail }) {
  const [read, setRead] = useState<Detail | null>(initial ?? null), [busy, setBusy] = useState(!initial), [error, setError] = useState("");
  const request = useRef(0), retryMore = useRef(false);
  async function load(more = false) {
    const current = ++request.current; retryMore.current = more; setBusy(true); setError("");
    try {
      const page = await api<Detail>(`/observability/chats/${encodeURIComponent(rootId)}?limit=20${agent.id === rootId ? "" : `&agent=${encodeURIComponent(agent.id)}`}${more && read?.turns.nextCursor ? `&cursor=${encodeURIComponent(read.turns.nextCursor)}` : ""}`);
      if (current !== request.current) return;
      setRead(previous => more && previous ? { ...page, turns: { ...page.turns, data: [...previous.turns.data, ...page.turns.data.filter(turn => !previous.turns.data.some(known => known.turnId === turn.turnId))] } } : page);
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  useEffect(() => { if (!initial) void load(); return () => { request.current++; }; }, []); // One first page per agent; subsequent pages need a click.
  const identity = read?.agents.find(value => value.id === agent.id) ?? agent;
  return <section className="observed-agent" aria-label={agent.name}>
    <div className="customize-title"><h3>{agent.name}</h3>{read?.record && <FileRefLink target={{ path: read.record }}>Open record</FileRefLink>}</div>
    <p className="customize-note">{modelLabel(identity.model)}{identity.role ? ` · ${identity.role}` : ""}</p>
    {error && <SettingsNotice tone="alert"><FilePathText text={error} /> <Button variant="ghost" size="sm" onClick={() => void load(retryMore.current)}>Retry</Button></SettingsNotice>}
    {busy && <SettingsNotice>Reading turns…</SettingsNotice>}
    {read && !read.turns.data.length && <SettingsEmpty title="No turns recorded yet" />}
    {read?.turns.data.map((turn, index) => <article className="observed-turn" key={turn.turnId} aria-label={`${agent.name} · Turn ${index + 1}`}>
      <p className="observed-turn-number">Turn {index + 1}</p>
      {turn.items.map(item => <div key={item.id} className="observed-item">{item.type === "userMessage" || item.type === "agentMessage" ? <ChatMessage item={item} mediaBase={mediaUrl(agent.id, { turnId: turn.turnId, item })} /> : <Work item={item} />}</div>)}
      {(turn.status === "failed" || turn.status === "interrupted") && <p className="observed-failure">{turn.status === "failed" ? "Turn failed" : "Turn interrupted"}: {turn.error?.message || (turn.status === "interrupted" ? "Stopped before completion" : "No reason was recorded")}</p>}
      <TurnLedger turn={turn} />
    </article>)}
    {read?.turns.nextCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(true)}>Show more turns</Button>}
  </section>;
}

export function ObservabilityView({ onOpenChat, hiddenChats }: { onOpenChat: (id: string) => void; hiddenChats?: ReadonlySet<string> }) {
  const [overview, setOverview] = useState<Overview | null>(null), [selected, setSelected] = useState<Chat | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function loadOverview(more = false) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const next = await api<Overview>(`/observability?limit=20${more && overview?.chats.nextCursor ? `&cursor=${encodeURIComponent(overview.chats.nextCursor)}` : ""}`);
      if (current === request.current) setOverview(previous => more && previous ? { ...next, chats: { ...next.chats, data: [...previous.chats.data, ...next.chats.data.filter(chat => !previous.chats.data.some(known => known.id === chat.id))] } } : next);
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function loadChat(chat: Chat) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const page = await api<Detail>(`/observability/chats/${encodeURIComponent(chat.id)}?limit=20`);
      if (current === request.current) setDetail(page);
    } catch (cause) { if (current === request.current) setError(message(cause)); }
    finally { if (current === request.current) setBusy(false); }
  }
  const hiddenKey = [...(hiddenChats ?? [])].sort().join(",");
  useEffect(() => {
    // Native deletion/archive events also invalidate this mounted page's cached rows, totals and agent groups.
    setOverview(null); setDetail(null);
    if (selected && !hiddenChats?.has(selected.id)) void loadChat(selected);
    else { setSelected(null); void loadOverview(); }
    return () => { request.current++; };
  }, [hiddenKey]);
  const choose = (chat: Chat) => { setSelected(chat); setDetail(null); void loadChat(chat); };
  return <div className="customize observability" aria-label="Observability">
    {selected && <button type="button" className="back-link" onClick={() => { request.current++; setBusy(false); setError(""); setSelected(null); void loadOverview(); }}><ArrowLeft size={18} />All chats</button>}
    {error && <SettingsNotice tone="alert"><FilePathText text={error} /> <Button variant="ghost" size="sm" onClick={() => void (selected ? loadChat(selected) : loadOverview())}>Retry</Button></SettingsNotice>}
    {busy && <SettingsNotice>Reading chats…</SettingsNotice>}
    {!selected && overview && <section aria-label="Chats">
      <div className="customize-title"><h2>Chats</h2><RefreshButton onClick={() => void loadOverview()} disabled={busy} /></div>
      {!overview.chats.data.length ? <SettingsEmpty title="No active chats" /> : <>
        <p className="customize-note">Choose a chat to read each agent's turns. {plural(overview.totals.attempts, "Smart Prune run")} · ≈{tokens(overview.totals.saved)} tokens saved (estimated).</p>
        <ul className="customize-list">{overview.chats.data.map(chat => <li className="customize-item observed-chat-row" key={chat.id}><button type="button" className="customize-text observability-chat" aria-label={title(chat.chat)} onClick={() => choose(chat)}><span className="customize-name">{title(chat.chat)}</span><span className="customize-description">{plural(chat.totals.attempts, "Smart Prune run")} · ≈{tokens(chat.totals.saved)} saved</span></button><Button variant="ghost" size="sm" onClick={() => onOpenChat(chat.id)}>Open chat</Button></li>)}</ul>
        {overview.chats.nextCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadOverview(true)}>Show more chats</Button>}
      </>}
    </section>}
    {selected && <section aria-label={title(selected.chat)}><div className="customize-title"><h2>{title(selected.chat)}</h2><Button variant="outline" size="sm" onClick={() => onOpenChat(selected.id)}>Open chat</Button></div>
      {detail?.agents.map(agent => <AgentTurns key={`${selected.id}:${agent.id}`} rootId={selected.id} agent={agent} initial={agent.id === detail.agentId ? detail : undefined} />)}
    </section>}
  </div>;
}
