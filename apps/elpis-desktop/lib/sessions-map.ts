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

/** The map's grid: a card is 260 px wide with a title of up to two lines (`.agent-node[data-wide]`). */
const COLUMN = 330,
  ROW = 130,
  GROUP_GAP = 40,
  SINGLES_PER_ROW = 3;

/** Give each depth its own slots; groups are stacked with a clear gap, the most recently active first. */
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
  const place = (id: string, x: number, y: number) => ({ id, type: "session", position: { x, y }, data: byId.get(id)! });
  let top = 0;
  const trees = groups.filter(group => group.ids.length > 1).flatMap(group => {
    const slots = new Map<number, number>();
    const result = group.ids.map(({ id, depth }) => {
      const slot = slots.get(depth) ?? 0;
      slots.set(depth, slot + 1);
      return place(id, depth * COLUMN, top + slot * ROW);
    });
    top += Math.max(...slots.values()) * ROW + GROUP_GAP;
    return result;
  });
  // Sessions that started nobody sit together in rows, so a long history is not one tall column.
  const singles = groups
    .filter(group => group.ids.length === 1)
    .map((group, index) =>
      place(group.ids[0]!.id, (index % SINGLES_PER_ROW) * COLUMN, top + Math.floor(index / SINGLES_PER_ROW) * ROW),
    );
  return [...trees, ...singles];
}

/**
 * The cards of a new reading, each keeping the size the map measured for it. A card laid out again without its size
 * is hidden until it is measured again, and stays hidden when a second reading lands before that.
 */
export function keepMeasured<Card extends { id: string; measured?: { width?: number; height?: number } }>(
  next: Card[],
  current: Card[],
): Card[] {
  const sizes = new Map(current.map(card => [card.id, card.measured]));
  return next.map(card => {
    const measured = sizes.get(card.id);
    return measured ? { ...card, measured } : card;
  });
}
