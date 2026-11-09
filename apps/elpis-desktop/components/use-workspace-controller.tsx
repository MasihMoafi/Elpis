"use client";

import { useWorkspaceState } from "./use-workspace-state";
import { useWorkspaceConversation } from "./use-workspace-conversation";
import { useWorkspaceActions } from "./use-workspace-actions";
import { useWorkspaceSidebarModel } from "./use-workspace-sidebar-model";

/** Every store and action of the workspace page, wired together; WorkspaceShell draws them. */
export function useWorkspaceController() {
  return useWorkspaceSidebarModel(useWorkspaceActions(useWorkspaceConversation(useWorkspaceState())));
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
