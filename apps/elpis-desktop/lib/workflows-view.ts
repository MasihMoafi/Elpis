/** Which view the Workflows page shows: the Map of his sessions, the Board, or the Scheduled list. */
export type WorkflowTab = "map" | "board" | "scheduled";

export const WORKFLOWS_VIEW_KEY = "elpis-workflows-view-v1";

/** Workflows opens on the Map, and after that on the view he last used. */
export function storedWorkflowTab(raw: string | null | undefined): WorkflowTab {
  return raw === "board" || raw === "scheduled" ? raw : "map";
}
