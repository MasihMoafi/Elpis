import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bell, Check, X } from "lucide-react";
import type { CSSProperties } from "react";
import { agentColor } from "@/lib/canvas";
import type { MapNode } from "@/lib/sessions-map";

export function SessionNode({ id, data }: NodeProps<Node<MapNode>>) {
  const status = { working: "running", "needs you": "blocked", done: "succeeded", failed: "failed", idle: "idle" }[data.state];
  return (
    <div className="agent-node" data-kind="agent" data-status={status}
      style={{ "--agent-color": agentColor(id, {
        title: data.title, instruction: "", model: null, writeScopes: [], acceptanceCriteria: [],
      }) } as CSSProperties}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="agent-node-kind">{data.kind.toUpperCase()}</span>
      <strong className="agent-node-title" title={data.title}>{data.title}</strong>
      <small className="agent-node-meta" title={[data.model, data.state].filter(Boolean).join(" · ")}>
        {[data.model, data.state].filter(Boolean).join(" · ")}
      </small>
      <span className="agent-node-mark" data-check={status} role="img" aria-label={data.state}>
        {status === "succeeded" ? <Check size={12} /> : status === "failed" ? <X size={12} /> : status === "blocked" ? <Bell size={12} /> : null}
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
