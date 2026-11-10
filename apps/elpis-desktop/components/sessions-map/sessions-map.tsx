"use client";

import { Background, BackgroundVariant, ReactFlow, type Viewport } from "@xyflow/react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { Switch } from "@/components/ui/switch";
import { EDGE_TYPES } from "@/components/agents-canvas/edges";
import { api, type Thread } from "@/lib/api";
import { layoutSessions, type SessionsGraph } from "@/lib/sessions-map";
import { SessionNode } from "./session-node";

const NODE_TYPES = { session: SessionNode };
const EMPTY: SessionsGraph = { nodes: [], edges: [] };

export function SessionsMap({ threads, dark, viewport, showAll, onShowAll, onOpenChat }: {
  threads: Thread[];
  dark: boolean;
  viewport: RefObject<Viewport | null>;
  showAll: boolean;
  onShowAll: (value: boolean) => void;
  onOpenChat: (id: string) => void;
}) {
  const [graph, setGraph] = useState<SessionsGraph>(EMPTY);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false, pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void api<SessionsGraph>(`/sessions-map${showAll ? "?all=1" : ""}`).then(value => {
        if (!disposed) { setGraph(value); setError(""); setLoading(false); }
      }, reason => {
        if (!disposed) { setError(String(reason)); setLoading(false); }
      }).finally(() => { pending = false; });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [showAll, threads]);
  const nodes = useMemo(() => layoutSessions(graph), [graph]);
  const edges = useMemo(() => graph.edges.map(edge => ({ ...edge, id: `${edge.source}:${edge.target}` })), [graph]);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Sessions map">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Switch aria-label="Show all chats" checked={showAll} onCheckedChange={onShowAll} />
        <span>Show all chats</span>
      </div>
      {error ? <p role="alert" className="p-4">Could not load the map: {error}</p> :
        loading ? <p className="p-4">Loading map…</p> : !nodes.length ? (
          <p className="p-4">No chats with agents yet. Start a workflow on the Board, or ask Elpis to run something.</p>
        ) : (
          <div className="canvas-board flex-1 min-h-0">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
              defaultViewport={viewport.current ?? { x: 48, y: 48, zoom: 1 }}
              onInit={instance => {
                if (viewport.current || !nodes[0]) return;
                const group = new Set([nodes[0].id]);
                let previous = 0;
                while (previous !== group.size) {
                  previous = group.size;
                  for (const edge of edges) if (group.has(edge.source)) group.add(edge.target);
                }
                const members = nodes.filter(node => group.has(node.id));
                const right = Math.max(...members.map(node => node.position.x + 190));
                const bottom = Math.max(...members.map(node => node.position.y + 90));
                void instance.setCenter(right / 2, (nodes[0].position.y + bottom) / 2, { zoom: 1 });
              }}
              onMoveEnd={(_, next) => { viewport.current = next; }}
              minZoom={0.86} maxZoom={2} nodesDraggable={false} nodesConnectable={false}
              onNodeClick={(_, node) => { if (node.data.threadId) onOpenChat(node.data.threadId); }}
              colorMode={dark ? "dark" : "light"} proOptions={{ hideAttribution: true }}>
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
            </ReactFlow>
          </div>
        )}
    </section>
  );
}
