import type { CanvasEdge, CanvasGraph } from "./canvas";

/** Whether a link orders its agents rather than carrying parallel or previous-round context. */
export const waits = (edge: CanvasEdge) => edge.kind !== "alongside" && !edge.feedback;
const roots = (graph: CanvasGraph) => {
  const agents = graph.nodes.filter(node => node.type === "agent"), ids = new Set(agents.map(node => node.id));
  return agents.filter(node => !graph.edges.some(edge => waits(edge) && ids.has(edge.source) && edge.target === node.id)).map(node => node.id);
};

/** Contract paths through removed nodes. Alongside links can be traversed in either direction.
 * A contracted path keeps its non-ordering/previous-round semantics and the downstream label.
 * Mother's links stay implicit: count only the new root links that actually appear after removal. */
export function deleteKeepingFlow(graph: CanvasGraph, ids: string[]) {
  const gone = new Set(graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id)).map(node => node.id));
  const nodes = graph.nodes.filter(node => !gone.has(node.id));
  const edges = graph.edges.filter(edge => !gone.has(edge.source) && !gone.has(edge.target));
  const arcs = graph.edges.flatMap(edge => edge.kind === "alongside" ? [edge, { ...edge, source: edge.target, target: edge.source }] : [edge]);
  const outgoing = new Map<string, CanvasEdge[]>();
  for (const edge of arcs) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  const reaches = (from: string, to: string) => {
    const todo = [from], seen = new Set<string>();
    while (todo.length) {
      const at = todo.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const edge of edges) {
        if (edge.source === at) todo.push(edge.target);
        else if (edge.kind === "alongside" && edge.target === at) todo.push(edge.source);
      }
    }
    return false;
  };
  let keptLinks = 0;
  for (const node of nodes) {
    const todo = (outgoing.get(node.id) ?? []).filter(edge => gone.has(edge.target));
    const seen = new Set<string>();
    while (todo.length) {
      const path = todo.shift()!, at = path.target;
      const key = `${at}|${path.kind ?? ""}|${!!path.feedback}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!gone.has(at)) {
        if (node.id === at || edges.some(edge => (edge.source === node.id && edge.target === at) || ((path.kind === "alongside" || edge.kind === "alongside") && edge.source === at && edge.target === node.id)) || reaches(at, node.id)) continue;
        edges.push({ ...path, id: `${node.id}${path.kind ? "~" : "->"}${at}`, source: node.id });
        keptLinks++;
        continue;
      }
      for (const edge of outgoing.get(at) ?? []) todo.push({ ...edge, ...(path.kind ? { kind: path.kind } : {}), ...(path.feedback ? { feedback: true } : {}), ...(!edge.label && path.label ? { label: path.label } : {}) });
    }
  }
  const result = { ...graph, nodes, edges };
  const previousRoots = new Set(roots(graph));
  keptLinks += roots(result).filter(id => !previousRoots.has(id)).length;
  return { graph: result, keptLinks };
}
