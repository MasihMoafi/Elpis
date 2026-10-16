"use client";

import { useState } from "react";
import { Bot, MessageSquare, Plus, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThreadActions } from "@/components/thread-actions";
import { agentState } from "@/lib/agents";
import { isAgent, isUnlinkedAgent, modelLabel, providerLabel, title, type Model, type ProviderSettings, type Thread } from "@/lib/api";

const stateLabel = (thread: Thread) => ({ working: "Working", idle: "Idle", error: "Error", waiting: "Needs input", unknown: "Status unavailable" })[agentState(thread)];
type Filter = "all" | "working" | "waiting" | "idle" | "error";
type Props = {
  threads: Thread[]; activity: Record<string, string>; models: Model[]; providers?: ProviderSettings["providers"]; loading: boolean;
  pendingThreadIds?: string[];
  moreConversations: boolean; loadingMore: boolean; onMoreConversations: () => Promise<void>;
  childCursors: Record<string, string | null>; loadingChildren: Record<string, boolean>; onMoreAgents: (id: string) => void;
  onOpen: (thread: Thread) => void; onStop: (thread: Thread) => Promise<void>; onDelete: (thread: Thread) => Promise<void>; onNewAgent: () => void;
};

export function AgentsView({ threads, activity, models, providers, loading, pendingThreadIds = [], moreConversations, loadingMore, onMoreConversations, childCursors, loadingChildren, onMoreAgents, onOpen, onStop, onDelete, onNewAgent }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const waiting = new Set(pendingThreadIds);
  const matches = (thread: Thread, value: Filter) => value === "all" || agentState(thread, waiting) === value;
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const visible = new Set<string>();
  for (const thread of threads.filter(thread => matches(thread, filter))) {
    let current: Thread | undefined = thread;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) { seen.add(current.id); visible.add(current.id); current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined; }
  }
  const roots = threads.filter(thread => !thread.parentThreadId && !isUnlinkedAgent(thread, threads) && visible.has(thread.id));
  const unlinked = threads.filter(thread => isUnlinkedAgent(thread, threads) && visible.has(thread.id));
  const filters: {id: Filter; label: string}[] = [{id:"all",label:"All"},{id:"working",label:"Working"},{id:"waiting",label:"Needs input"},{id:"idle",label:"Idle"},{id:"error",label:"Errors"}];
  function row(thread: Thread, depth: number) {
    const working = thread.status?.type === "active", needsInput = agentState(thread, waiting) === "waiting";
    const meta = [thread.agentRole && thread.agentRole !== "default" ? thread.agentRole : null, providerLabel(thread.model, thread.modelProvider, providers), modelLabel(thread.model, models), thread.reasoningEffort].filter(Boolean).join(" · ");
    const Icon = isAgent(thread) ? Bot : MessageSquare;
    return <div key={thread.id} className={`agent-row${!matches(thread,filter) ? " agent-context" : ""}`} data-thread-id={thread.id} style={{ marginLeft: `${Math.min(depth, 6) * 20}px` }}>
      <span className="agent-icon" aria-hidden="true"><Icon size={16}/></span>
      <div className="agent-main min-w-0 flex-1">
        <div className="agent-title-line"><button className="agent-title" title={title(thread)} onClick={() => onOpen(thread)}>{title(thread)}</button>{thread.agentNickname && thread.agentNickname !== title(thread) && <span className="agent-nickname">{thread.agentNickname}</span>}</div>
        <p className="agent-meta" title={meta}>{meta}</p>
        <p className="agent-activity" aria-live="polite">{needsInput ? (thread.status?.activeFlags?.includes("waitingOnApproval") ? "Waiting for approval" : "Waiting for input") : activity[thread.id] || (working ? "Working…" : "")}</p>
      </div>
      <span className={`agent-state${needsInput ? " waiting" : working ? " working" : ""}`}><i aria-hidden="true"/>{needsInput ? "Needs input" : stateLabel(thread)}</span>
      <div className="agent-actions">
        {working && <Button variant="outline" size="sm" aria-label={`Stop ${title(thread)}`} onClick={() => void onStop(thread)}><Square size={13} />Stop</Button>}
        <Button variant="ghost" size="sm" onClick={() => onOpen(thread)}>Open chat</Button>
        <ThreadActions thread={thread} onDelete={onDelete} />
      </div>
    </div>;
  }
  const moreAgents = (thread: Thread) => childCursors[thread.id] && <Button className="m-3" variant="outline" size="sm" disabled={loadingChildren[thread.id]} onClick={() => onMoreAgents(thread.id)}>Load more agents for {title(thread)}</Button>;
  function tree(parentId: string, depth: number, seen: Set<string>): React.ReactNode {
    if (seen.has(parentId) || depth > 12) return null;
    const next = new Set(seen).add(parentId);
    return threads.filter(thread => thread.parentThreadId === parentId && visible.has(thread.id)).map(child => <div key={child.id}>{row(child, depth)}{tree(child.id, depth + 1, next)}</div>);
  }
  return <section className="agents-view" aria-label="Agents">
    <div className="agents-toolbar"><div className="agent-filters" role="group" aria-label="Filter conversations and agents">{filters.map(option => <Button key={option.id} variant={filter === option.id ? "secondary" : "ghost"} size="sm" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}<span className="filter-count">{threads.filter(thread => matches(thread,option.id)).length}</span></Button>)}</div><Button size="sm" variant="outline" onClick={onNewAgent}><Plus size={14} />New agent</Button></div>
    {loading && <p role="status" className="agents-loading">Updating agents…</p>}
    {!visible.size && !loading && <p className="agents-empty-state">{threads.length ? "No conversations or agents match this status." : "No conversations yet. Start one, or create an agent."}</p>}
    {roots.map(rootThread => <div key={rootThread.id} className="agent-conversation-group">{row(rootThread, 0)}{tree(rootThread.id, 1, new Set())}{moreAgents(rootThread)}</div>)}
    {unlinked.length > 0 && <section className="agent-conversation-group" aria-label="Agents whose parent is not listed"><h2 className="agent-group-label"><span>Other agents</span><span className="agent-group-hint">Their parent conversation is not listed.</span></h2>{unlinked.map(thread => <div key={thread.id}>{row(thread, 0)}{tree(thread.id, 1, new Set())}{moreAgents(thread)}</div>)}</section>}
    {moreConversations && <Button className="m-3" variant="outline" disabled={loadingMore} onClick={() => void onMoreConversations()}>{loadingMore ? "Loading conversations…" : "Load more conversations"}</Button>}
  </section>;
}
