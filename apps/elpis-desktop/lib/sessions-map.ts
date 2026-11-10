export type MapState = "working" | "needs you" | "done" | "failed" | "idle";
export type MapNode = {
  id: string;
  kind: "router" | "worker" | "chat" | "agent" | "workflow";
  title: string;
  state: MapState;
  model?: string;
  threadId?: string;
};

export type SessionsGraph = {
  nodes: (MapNode & { updatedAt?: number })[];
  edges: { source: string; target: string }[];
};

/** Give each depth its own slots; groups are stacked with a clear gap. */
export function layoutSessions(graph: SessionsGraph) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>(), incoming = new Set<string>();
  for (const { source, target } of graph.edges) {
    if (!byId.has(source) || !byId.has(target)) continue;
    children.set(source, [...(children.get(source) ?? []), target]);
    incoming.add(target);
  }
  const visited = new Set<string>();
  const groups: { ids: { id: string; depth: number }[]; activity: number }[] = [];
  const walk = (id: string, depth: number, group: { ids: { id: string; depth: number }[]; activity: number }) => {
    if (visited.has(id)) return;
    visited.add(id);
    group.ids.push({ id, depth });
    group.activity = Math.max(group.activity, byId.get(id)?.updatedAt ?? 0);
    for (const child of children.get(id) ?? []) walk(child, depth + 1, group);
  };
  const roots = [...graph.nodes.filter(node => !incoming.has(node.id)), ...graph.nodes];
  for (const root of roots) {
    if (visited.has(root.id)) continue;
    const group = { ids: [] as { id: string; depth: number }[], activity: 0 };
    walk(root.id, 0, group);
    groups.push(group);
  }
  groups.sort((a, b) => b.activity - a.activity);
  let top = 0;
  return groups.flatMap(group => {
    const slots = new Map<number, number>();
    const result = group.ids.map(({ id, depth }) => {
      const slot = slots.get(depth) ?? 0;
      slots.set(depth, slot + 1);
      return { id, type: "session", position: { x: depth * 260, y: top + slot * 120 }, data: byId.get(id)! };
    });
    top += Math.max(...slots.values()) * 120 + 40;
    return result;
  });
}
