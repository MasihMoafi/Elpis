"use client";

/** Shows the root chat and its agents in the conversation's side panel. */
import { agentState, stateLabels } from "@/lib/agents";
import { modelLabel, title, type Model, type Thread } from "@/lib/api";

export function AgentsPanel({ team, root, selected, waitingIds, activity, models, onOpen, onLoad }: {
  team: Thread[]; root: Thread; selected: Thread; waitingIds: Set<string>; activity: Record<string, string>; models: Model[];
  onOpen: (id: string) => void; onLoad: (thread: Thread) => void | Promise<void>;
}) {
  return <aside className="team-panel" aria-label="Agents in this chat">
    <div className="team-heading"><span>Agents</span><small>{team.filter(thread => agentState(thread, waitingIds) === "working").length} working · {team.length} total</small></div>
    <button data-slot="team-row" className={`team-row root${selected.id === root.id ? " active" : ""}`} onClick={() => onOpen(root.id)}><span className="team-state"><i /></span><span className="team-title">{title(root)}</span><small>Main chat</small></button>
    {team.map(thread => { const state = agentState(thread, waitingIds);
      return <button data-slot="team-row" key={thread.id} className={`team-row ${state}${selected.id === thread.id ? " active" : ""}`} onClick={() => onLoad(thread)} title={activity[thread.id] || title(thread)}>
        <span className="team-state" aria-label={stateLabels[state]}><i /></span>
        <span className="team-title">{title(thread)}{thread.agentNickname && thread.agentNickname !== title(thread) && <em>{thread.agentNickname}</em>}</span>
        <small>{state === "working" && activity[thread.id] ? activity[thread.id] : [modelLabel(thread.model, models), thread.reasoningEffort].filter(Boolean).join(" · ")}</small>
      </button>; })}
  </aside>;
}
