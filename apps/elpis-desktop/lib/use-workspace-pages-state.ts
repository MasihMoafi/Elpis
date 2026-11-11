import { useCallback, useRef, useState } from "react";
import type { WorkflowPrefill } from "@/components/automations-view";
import type { SettingsDestination } from "@/components/settings-view";
import type { WorkflowRun } from "@/lib/workflow-identity";
import type { View } from "@/lib/workspace-types";
import { appStorage } from "@/lib/projects";
import { WORKFLOWS_VIEW_KEY, storedWorkflowTab, type WorkflowTab } from "@/lib/workflows-view";

/** The open workspace page, Settings navigation and the Workflows board's current view. */
export function useWorkspacePagesState() {
  const [recordedWorkflow, setRecordedWorkflow] = useState<Pick<WorkflowRun, "id" | "rootThreadId">>();
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [settingsNavigation, setSettingsNavigation] = useState(0);
  const [view, setView] = useState<View>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("workspace") === "canvas"
      ? "canvas"
      : "chat",
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const [workflowTab, showWorkflowTab] = useState<WorkflowTab>(() =>
    typeof window === "undefined" ? "map" : storedWorkflowTab(appStorage().getItem(WORKFLOWS_VIEW_KEY)),
  );
  const setWorkflowTab = useCallback((tab: WorkflowTab) => {
    showWorkflowTab(tab);
    appStorage().setItem(WORKFLOWS_VIEW_KEY, tab);
  }, []);
  const [workflowPrefill, setWorkflowPrefill] = useState<WorkflowPrefill | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsDestination>("general");
  return {
    recordedWorkflow,
    setRecordedWorkflow,
    settingsVisited,
    setSettingsVisited,
    settingsNavigation,
    setSettingsNavigation,
    view,
    setView,
    viewRef,
    workflowTab,
    setWorkflowTab,
    workflowPrefill,
    setWorkflowPrefill,
    settingsSection,
    setSettingsSection,
  };
}
