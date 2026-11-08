import { type CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, X } from "lucide-react";
import { PlusIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { WorkflowMark } from "@/components/workflow-identity";
import { NoteText } from "@/components/agents-iso";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import { agentCount, agentColor, CHECK_LABEL, STATUS_LABEL, type NoteData } from "@/lib/canvas";
import { AgentNodeData, MotherData } from "./types";

/** An agent on the canvas: it writes. Its run-order wave, name, model and state, with an input on the left (what it
 * waits for) and an output on the right (what waits for it), as Deus Ex's hacking screen links its nodes. The ring at
 * its corner is its check: empty until it runs, turning while it runs, then a tick or a cross. Clicking a dot opens
 * the command bar to add agents on that side. */
export function AgentNode({ id, data }: NodeProps<Node<AgentNodeData>>) {
  const status = data.status ?? "idle",
    check = data.check ?? "idle";
  const summary = data.muted ? "muted · skipped in runs" : data.clash ? "clash" : STATUS_LABEL[status];
  return (
    <div
      className="agent-node"
      data-kind="agent"
      data-status={status}
      data-muted={data.muted || undefined}
      style={{ "--agent-color": agentColor(id, data) } as CSSProperties}
    >
      <Handle
        type="target"
        position={Position.Left}
        title="Add agents this one waits for"
        onClick={event => data.onHandle?.(id, "target", event)}
      />
      <span className="agent-node-kind">Agent</span>
      <strong className="agent-node-title" title={data.title || "Untitled"}>
        {data.title || "Untitled"}
      </strong>
      <small
        className="agent-node-meta"
        title={
          status === "running"
            ? `Now: ${data.activity || data.title}`
            : `${data.modelLabel ?? "Default model"} · ${summary}`
        }
      >
        {status === "running" ? (
          `Now: ${data.activity || data.title}`
        ) : (
          <>
            {data.modelLabel ?? "Default model"} · {summary}
          </>
        )}
      </small>
      <span
        className="agent-node-mark"
        role="img"
        data-check={check}
        aria-label={CHECK_LABEL[check]}
        title={CHECK_LABEL[check]}
      >
        {check === "succeeded" ? (
          <Check size={12} />
        ) : check === "failed" || check === "blocked" ? (
          <X size={12} />
        ) : null}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        title="Add agents that wait for this one"
        onClick={event => data.onHandle?.(id, "source", event)}
      />
      {/* Both quick-create buttons add one successor linked only from this agent. */}
      <Button
        variant="outline"
        size="icon-xs"
        className="agent-node-plus nodrag"
        data-side="right"
        aria-label={`Add the next agent after ${data.title || "this one"}`}
        title="Add the next agent: it waits for this one"
        onClick={event => {
          event.stopPropagation();
          data.onQuick?.(id);
        }}
      >
        <PlusIcon />
      </Button>
      <Button
        variant="outline"
        size="icon-xs"
        className="agent-node-plus nodrag"
        data-side="bottom"
        aria-label={`Add an agent after ${data.title || "this one"}`}
        title="Add an agent after this one, connected only from this one"
        onClick={event => {
          event.stopPropagation();
          data.onQuick?.(id);
        }}
      >
        <PlusIcon />
      </Button>
    </div>
  );
}

/** The Mother: the run's chat. She starts the agents that wait for no one (her wires) and receives every report. */
export function MotherNode({ id, data }: NodeProps<Node<MotherData>>) {
  return (
    <div
      className="agent-node mother-node"
      data-kind="mother"
      data-status={data.run === "running" ? "running" : undefined}
      title="The Mother agent is the run's chat: every agent is her child, she starts the ones that wait for no one, and every report comes back to her."
    >
      <span className="agent-node-kind">{data.identity && <WorkflowMark identity={data.identity} />}Mother agent</span>
      <strong className="agent-node-title">This run&rsquo;s chat</strong>
      <small className="agent-node-meta">
        {agentCount(data.children)} · {data.run === "idle" ? "not run" : data.run}
      </small>
      <Handle
        type="source"
        position={Position.Right}
        title="Add agents she starts"
        onClick={event => data.onHandle?.(id, "source", event)}
      />
    </div>
  );
}

/** A FigJam-style sticky note: free text on the canvas, never sent to Elpis. */
export function NoteNode({ id, data }: NodeProps<Node<NoteData & { onText?: (id: string, text: string) => void }>>) {
  // The strip is the handle: dragging it moves the note, while the text below takes the keys.
  return (
    <div className="canvas-note">
      <span className="canvas-note-grip" title="A note for you, never sent to an agent; drag here to move it">
        Note · for you
      </span>
      <NoteText text={data.text} onText={text => data.onText?.(id, text)} />
    </div>
  );
}

/** The Father: he runs the agents past the Mother's ten, in his own chat, once her part has succeeded, and reports to
 * her. Drawn only when the graph needs him. */
export function FatherNode({ data }: NodeProps<Node<MotherData>>) {
  return (
    <div
      className="agent-node mother-node"
      data-kind="mother"
      data-status={data.run === "running" ? "running" : undefined}
      title="The Father agent runs the agents past the Mother agent's ten, in his own chat, after her part has succeeded, and reports to her."
    >
      <span className="agent-node-kind">Father agent</span>
      <strong className="agent-node-title">Reports to the Mother agent</strong>
      <small className="agent-node-meta">
        {agentCount(data.children)} · {data.run === "idle" ? "after her part" : data.run}
      </small>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

export type FrameData = {
  title: string;
  renaming: boolean;
  onPick: () => void;
  onName: (title: string | null) => void;
};

export function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  return (
    <div className="canvas-frame">
      <div className="canvas-frame-title" onClick={data.onPick}>
        {data.renaming ? (
          <CanvasTextEdit
            label="Frame name"
            value={data.title}
            maxLength={120}
            onSave={data.onName}
            onCancel={() => data.onName(null)}
          />
        ) : (
          <strong>{data.title}</strong>
        )}
      </div>
    </div>
  );
}

export const NODE_TYPES = {
  agent: AgentNode,
  mother: MotherNode,
  father: FatherNode,
  note: NoteNode,
  frame: FrameNode,
};
