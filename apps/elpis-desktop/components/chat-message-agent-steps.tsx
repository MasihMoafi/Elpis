"use client";

import { text, list, readable, Activity } from "./chat-message-parts";
import { BranchIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { AgentInline } from "@/components/agent-inline";
import { type Item, type Thread, taskFromPath, title } from "@/lib/api";
import "@/components/message-actions.css";
import "@/components/message-body.css";

type AgentStepProps = { item: Item; threads: Thread[]; onOpenThread?: ((id: string) => void) | undefined };

/** A sub-agent's lifecycle event in the transcript, with a link to its chat. */
export function SubAgentStep({ item, threads, onOpenThread }: AgentStepProps) {
  const id = text(item.agentThreadId),
    agent = threads.find(thread => thread.id === id);
  const label =
    (
      {
        started: "Agent started",
        interacted: "Agent interaction",
        interrupted: "Agent interrupted",
        completed: "Agent completed",
      } as Record<string, string>
    )[text(item.kind)] || "Agent activity";
  const identity = agent ? title(agent) : taskFromPath(item.agentPath) || text(item.agentPath);
  return (
    <div className="activity-card">
      <div className="activity-heading">
        <span className="activity-icon">
          <BranchIcon size={15} />
        </span>
        <span className="activity-title">{label}</span>
        {identity && (
          <span className="activity-preview" title={text(item.agentPath) || identity}>
            {identity}
          </span>
        )}
        {id && onOpenThread && (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => onOpenThread(id)}>
            Open chat
          </Button>
        )}
      </div>
      {id && <AgentInline id={id} threads={threads} />}
      {(text(item.model) || text(item.reasoningEffort)) && (
        <p className="activity-location px-3 pb-2 text-xs text-muted-foreground">
          {[text(item.model), text(item.reasoningEffort) && `${text(item.reasoningEffort)} reasoning`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/** A tool call that started, messaged or waited for other agents. */
export function CollabAgentStep({
  item,
  threads,
  onOpenThread,
  activityLabel,
}: AgentStepProps & { activityLabel?: string | undefined }) {
  const ids = list(item.receiverThreadIds).filter((id): id is string => typeof id === "string");
  const agentTool = (
    {
      spawn_agent: "Started an agent",
      spawnAgent: "Started an agent",
      wait: "Waited for agents",
      wait_agent: "Waited for agents",
      close_agent: "Closed an agent",
      closeAgent: "Closed an agent",
      send_input: "Messaged an agent",
      sendInput: "Messaged an agent",
      resume_agent: "Resumed an agent",
      interrupt_agent: "Interrupted an agent",
    } as Record<string, string>
  )[text(item.tool)];
  return (
    <Activity
      label={activityLabel ?? (agentTool || readable(text(item.tool)) || "Agent activity")}
      status={item.status}
    >
      {text(item.prompt) && <p className="step-note">{text(item.prompt)}</p>}
      {text(item.model) && <p className="step-note">{text(item.model)}</p>}
      <div className="step-agents">
        {ids.filter(Boolean).map(id => (
          <Button key={id} variant="outline" size="sm" onClick={() => onOpenThread?.(id)} disabled={!onOpenThread}>
            {threads.some(t => t.id === id) ? title(threads.find(t => t.id === id)!) : "Open agent conversation"}
          </Button>
        ))}
      </div>
      {ids.filter(Boolean).map(id => (
        <AgentInline key={id} id={id} threads={threads} />
      ))}
    </Activity>
  );
}
