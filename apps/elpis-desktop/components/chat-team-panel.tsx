import type { Dispatch, SetStateAction } from "react";
import { ListFilter } from "lucide-react";
import { AgentIdentity } from "@/components/agent-identity";
import { AgentsIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { modelLabel, title, type Model, type Thread } from "@/lib/api";
import { agentState, stateLabels } from "@/lib/agents";

export function ChatTeamPanel({ selected, teamRoot, team, workingTeam, shownTeam, workingAgentsOnly, setWorkingAgentsOnly, waitingIds, activity, models, agentColours, openById, openThread }: {
  selected: Thread; teamRoot: Thread; team: Thread[]; workingTeam: Thread[]; shownTeam: Thread[];
  workingAgentsOnly: boolean; setWorkingAgentsOnly: Dispatch<SetStateAction<boolean>>;
  waitingIds: Set<string>; activity: Record<string, string>; models: Model[]; agentColours: Map<string, number>;
  openById: (id: string) => Promise<void>; openThread: (thread: Thread) => Promise<void>;
}) {
  return <aside className="team-panel" aria-label="Agents in this chat">
    <div className="team-heading"><span className="inline-flex items-center gap-2"><AgentsIcon size={16} />Agents</span><span className="inline-flex items-center gap-1"><small>{workingTeam.length} working · {team.length} total</small><Button variant="ghost" size="icon-xs" aria-label="Working agents only" aria-pressed={workingAgentsOnly} title={workingAgentsOnly ? "Show all agents" : "Show working agents only"} className={workingAgentsOnly ? "text-primary" : "text-muted-foreground"} onClick={() => setWorkingAgentsOnly(value => !value)}>{/* The Recents filter turned upside down (Masih, 31 Oct: "a simple ^ opposite of this ^"). */}<ListFilter size={13} viewBox="-2 -2 28 28" className="-scale-y-100" aria-hidden="true" /></Button></span></div>
    <button data-slot="team-row" className={`team-row root${selected.id === teamRoot.id ? " active" : ""}`} onClick={() => void openById(teamRoot.id)}><span className="team-state"><i /></span><span className="team-title">{title(teamRoot)}</span><small>Main chat</small></button>
    {workingAgentsOnly && !shownTeam.length && <p className="px-2 text-xs text-muted-foreground">No working agents</p>}
    {shownTeam.map(thread => { const state = agentState(thread, waitingIds), runtime = state === "working" && activity[thread.id] ? activity[thread.id] : [modelLabel(thread.model, models), thread.reasoningEffort].filter(Boolean).join(" · ");
      const colourSlot = agentColours.get(thread.id);
      return <button data-slot="team-row" data-thread-id={thread.id} key={thread.id} className={`team-row ${state}${selected.id === thread.id ? " active" : ""}`} onClick={() => void openThread(thread)} title={activity[thread.id] || title(thread)}>
        <span className="team-state" aria-label={stateLabels[state]}><i /></span>
        <AgentIdentity compact id={thread.id} {...(colourSlot === undefined ? {} : { colourSlot })} name={title(thread)} nameClassName="team-title" model={null} provider={null} {...(runtime ? { role: runtime } : {})} />
      </button>; })}
  </aside>;
}
