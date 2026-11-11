"use client";

import { Background, BackgroundVariant, Controls, ReactFlow, useNodesState, type Edge, type Node, type Viewport } from "@xyflow/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Switch } from "@/components/ui/switch";
import { EDGE_TYPES } from "@/components/agents-canvas/edges";
import { api, type Thread } from "@/lib/api";
import { keepMeasured, layoutSessions, type MapNode, type SessionsGraph } from "@/lib/sessions-map";
import { SessionNode } from "./session-node";

const NODE_TYPES = { session: SessionNode };
/** The map opens zoomed out, to show more of his sessions at once, and zooms out far enough to see them all
 * (11 Nov, Masih: "I like the map to be more zoomed-out, to have that option"); the controls zoom in, out and to fit. */
const OPEN_ZOOM = 0.7;
const MIN_ZOOM = 0.15;
/** A change in his chats refreshes the map at once; this beat catches what sends no event, such as a workflow run. */
const REFRESH_MS = 5000;

export function SessionsMap({ threads, dark, viewport, showAll, onShowAll, onOpenChat, runNames }: {
  threads: Thread[];
  dark: boolean;
  viewport: RefObject<Viewport | null>;
  showAll: boolean;
  onShowAll: (value: boolean) => void;
  onOpenChat: (id: string) => void;
  /** The names he gave his workflow runs, by run id. A run's card shows that name, as History and the sidebar do. */
  runNames?: Record<string, { name: string }>;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<MapNode>>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => {});
  const named = useRef(runNames);
  // A run he renames shows its new name at once, without restarting a reading that is under way.
  useEffect(() => { named.current = runNames; refresh.current(); }, [runNames]);
  useEffect(() => {
    let disposed = false, pending = false, again = false, shown = "";
    const show = (read: SessionsGraph) => {
      setError(""); setLoading(false);
      const value = { ...read, nodes: read.nodes.map(node => {
        const own = node.kind === "workflow" ? named.current?.[node.id.slice("workflow:".length)]?.name : undefined;
        return own ? { ...node, title: own } : node;
      }) };
      // A reading that says the same as the one on screen changes nothing.
      const reading = JSON.stringify(value);
      if (reading === shown) return;
      shown = reading;
      setNodes(current => keepMeasured<Node<MapNode>>(layoutSessions(value), current));
      setEdges(value.edges.map(edge => ({ ...edge, id: `${edge.source}:${edge.target}` })));
    };
    const read = () => {
      // A change that comes while a reading runs is read once more after it, not dropped and not run beside it.
      if (pending) { again = true; return; }
      pending = true;
      void api<SessionsGraph>(`/sessions-map${showAll ? "?all=1" : ""}`).then(value => {
        if (!disposed) show(value);
      }, reason => {
        if (!disposed) { setError(String(reason)); setLoading(false); }
      }).finally(() => {
        pending = false;
        if (again && !disposed) { again = false; read(); }
      });
    };
    refresh.current = read;
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [showAll, setNodes]);
  // A change in his chats refreshes the map without restarting a reading that is under way.
  useEffect(() => { refresh.current(); }, [threads]);
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
              // The map keeps what it measures of its cards, and nothing else: a card is not moved or selected.
              onNodesChange={changes => onNodesChange(changes.filter(change => change.type === "dimensions"))}
              defaultViewport={viewport.current ?? { x: 48, y: 48, zoom: OPEN_ZOOM }}
              onMoveEnd={(_, next) => { viewport.current = next; }}
              minZoom={MIN_ZOOM} maxZoom={2} nodesDraggable={false} nodesConnectable={false}
              onNodeClick={(_, node) => { if (node.data.threadId) onOpenChat(node.data.threadId); }}
              colorMode={dark ? "dark" : "light"} proOptions={{ hideAttribution: true }}>
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
              <Controls showInteractive={false} fitViewOptions={{ padding: 0.08, maxZoom: 1 }} />
            </ReactFlow>
          </div>
        )}
    </section>
  );
}
