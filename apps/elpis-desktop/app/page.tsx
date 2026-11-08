"use client";

import { useWorkspaceController } from "@/components/use-workspace-controller";
import { WorkspaceShell } from "@/components/workspace-shell";

export default function Home() {
  return <WorkspaceShell workspace={useWorkspaceController()} />;
}
