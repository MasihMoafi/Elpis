import type { CanvasController } from "./use-canvas-controller";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { STATUS_LABEL, TASKS_PER_AGENT, type TaskStatus } from "@/lib/canvas";
import { over } from "./run-state";
import { RUN_MINUTES } from "./constants";
import { CountField } from "./fields";
import { LiveFeed } from "./dashboard";

export function MotherSettingsPanel({
  mother,
  setMother,
  letElpis,
  ready,
  offlineReasonId,
  planning,
  modelPatch,
  modelOptions,
  subscriptions,
  subscriptionOptions,
  graph,
  run,
  setGraph,
  limit,
  agents,
  allowed,
  states,
  split,
  runState,
  onOpenChat,
  setSelection,
}: Pick<
  CanvasController,
  | "mother"
  | "setMother"
  | "letElpis"
  | "ready"
  | "offlineReasonId"
  | "planning"
  | "modelPatch"
  | "modelOptions"
  | "subscriptions"
  | "subscriptionOptions"
  | "graph"
  | "run"
  | "setGraph"
  | "limit"
  | "agents"
  | "allowed"
  | "states"
  | "split"
  | "runState"
  | "onOpenChat"
  | "setSelection"
>) {
  return (
    <aside className="canvas-side" aria-label="Mother agent">
      <p className="hud-menu-title">Mother agent · the run&rsquo;s chat</p>
      <p className="canvas-help">
        Every agent is her child: she starts the ones that wait for no one, and every report comes back to her. These
        settings apply to the whole run.
      </p>
      <label>
        Goal (every agent gets it)
        <Textarea
          aria-label="Goal"
          rows={4}
          value={mother.brief}
          placeholder="What should this run achieve? Elpis can design the team from it."
          onChange={event => setMother({ brief: event.target.value })}
        />
      </label>
      <Button
        size="sm"
        onClick={() => void letElpis(mother.brief)}
        aria-describedby={!ready ? offlineReasonId : undefined}
        disabled={!ready || !mother.brief.trim() || Boolean(planning)}
        title="Elpis designs the team from the goal: how many agents, their prompts, folders and wiring; Ctrl+Z undoes it"
      >
        {planning ? "Elpis is designing…" : "Let Elpis design the team"}
      </Button>
      <label>
        Her model
        <OptionSelect
          aria-label="Her model"
          value={mother.model ? `${mother.provider ?? ""}|${mother.model}` : ""}
          onChange={event => {
            const patch = modelPatch(event.target.value);
            setMother({ model: patch.model ?? null, provider: patch.provider ?? null });
          }}
        >
          {modelOptions()}
          {/* Her default is Claude Opus on the subscription (3 Nov); the subscriptions' models are hers to pick too (5 Nov: the menu showed "|claude/opus"). */}
          {subscriptions.flatMap(choice => subscriptionOptions(choice.id))}
        </OptionSelect>
      </label>
      {/* One switch for the whole run (1 Nov): when a child succeeds she may add, cancel or steer agents, at most 5 times. */}
      <label
        className="canvas-mother-switch"
        title="When an agent finishes, the Mother may add agents, cancel waiting ones or steer a running one (at most 5 times a run). Each decision shows in the run history."
      >
        Mother re-plans
        <Switch
          aria-label="Mother re-plans"
          checked={graph.replan !== false}
          disabled={Boolean(run && !over(run))}
          onCheckedChange={on => setGraph(current => ({ ...current, replan: on }))}
        />
      </label>
      {/* Per run (1 Nov): each agent's task runs on his CloudRoom VM (sign in under Settings → Models & accounts); her review and merge stay here. */}
      <label title="CloudRoom VM: each agent's worktree is copied to your CloudRoom VM, its Claude Code or Codex runs there, and the changes come back. The Mother's review and merge stay on this computer.">
        Runs on
        <OptionSelect
          aria-label="Runs on"
          value={graph.runsOn ?? "local"}
          disabled={Boolean(run && !over(run))}
          onChange={event => {
            const runsOn = event.target.value as "local" | "cloudroom";
            setGraph(current => ({ ...current, runsOn }));
          }}
        >
          <option value="local">This computer</option>
          <option value="cloudroom">CloudRoom VM</option>
        </OptionSelect>
      </label>
      <div className="canvas-mother-counts">
        <CountField
          label="Time limit (min)"
          value={graph.timeLimit ?? RUN_MINUTES}
          min={1}
          max={1440}
          onChange={minutes => setGraph(current => ({ ...current, timeLimit: minutes }))}
          why={typed => (typed < 1 ? "A run needs at least a minute." : "A run can last at most a day (1440 minutes).")}
        />
        <CountField
          label="Max agents"
          value={limit}
          min={Math.max(1, agents.length)}
          max={Math.floor(allowed.graph / TASKS_PER_AGENT)}
          onChange={count => setGraph(current => ({ ...current, maxAgents: count }))}
          why={typed =>
            typed > allowed.graph / TASKS_PER_AGENT
              ? `Elpis runs at most ${allowed.graph} tasks in a graph: ${Math.floor(allowed.graph / TASKS_PER_AGENT)} agents, each with its check.`
              : typed < agents.length
                ? `The graph already has ${agents.length} agents; remove some first.`
                : "Type a whole number from 1."
          }
        />
      </div>
      {run && (
        <p className="canvas-help" role="status">
          {(["running", "succeeded", "pending", "failed", "blocked"] as const)
            .map(status => [status, agents.filter(node => states[node.id]?.status === status).length] as const)
            .filter(([, count]) => count)
            .map(([status, count]) => `${count} ${STATUS_LABEL[status]}`)
            .join(" · ") || "Starting…"}
        </p>
      )}
      {split.father.length > 0 && (
        <p className="canvas-help" role="note">
          The Father agent runs {split.father.length} more {split.father.length === 1 ? "agent" : "agents"} in his own
          chat once her part has succeeded, and reports to her
          {run?.father
            ? `: ${run.father.threadId ? (STATUS_LABEL[run.father.status as TaskStatus] ?? run.father.status) : run.father.status === "cancelled" ? "not started, her part failed" : "waiting for her part"}`
            : "."}
        </p>
      )}
      <LiveFeed
        chat={run?.rootThreadId ?? null}
        working={runState === "running"}
        ready={ready}
        idle="Not started. Every agent's report arrives here once the graph runs."
      />
      <div className="canvas-inspector-actions">
        {run && (
          <Button variant="outline" size="sm" onClick={() => onOpenChat(run.rootThreadId)}>
            <ExternalLink size={14} />
            Open her chat
          </Button>
        )}
        {run?.father?.threadId && (
          <Button variant="outline" size="sm" onClick={() => onOpenChat(run.father!.threadId!)}>
            <ExternalLink size={14} />
            Open the Father agent&rsquo;s chat
          </Button>
        )}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>
          Done
        </Button>
      </div>
    </aside>
  );
}
