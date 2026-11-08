import { TEMPLATES } from "./canvas-templates.ts";
import { withMother } from "./canvas-graph.ts";
import type { AgentData, CanvasNode, CanvasGraph } from "./canvas-types.ts";
import { appStorage } from "@/lib/projects";
export const KEY = "elpis-workflow-draft-v1";
/** The graph on this device, or null when none was saved (or it can't be read). Agents saved with a role from before
 * every agent wrote come back as writers. */
export function readGraph(): CanvasGraph | null {
  try {
    const value = JSON.parse(appStorage().getItem(KEY) ?? "null");
    if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || typeof value.name !== "string")
      return null;
    const nodes = value.nodes.map((node: CanvasNode) =>
      node.type === "agent"
        ? {
            ...node,
            data: (({
              kind: _kind,
              ...data
            }: AgentData & {
              kind?: string;
            }) => data)(node.data),
          }
        : node,
    );
    return withMother({ ...value, nodes });
  } catch {
    return null;
  }
}
/** Both Workflows and Lab start from the same board or starter. */
export function initialGraph(): CanvasGraph {
  return readGraph() ?? { ...withMother(TEMPLATES[0].build()), template: TEMPLATES[0].id };
}
export function saveGraph(graph: CanvasGraph) {
  try {
    appStorage().setItem(KEY, JSON.stringify(graph));
    return true;
  } catch {
    return false;
  }
}
