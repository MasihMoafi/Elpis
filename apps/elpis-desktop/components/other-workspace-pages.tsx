import dynamic from "next/dynamic";
import type React from "react";
import { AgentsGuide } from "@/components/agents-guide";
import { CustomizeView } from "@/components/customize-view";
import { ExperimentLab } from "@/components/experiment-lab";
import { ObservabilityView } from "@/components/observability-view";
import type { SettingsDestination } from "@/components/settings-view";
import type { useSidePanel } from "@/components/side-panel";
import type { TerminalLaunch } from "@/components/terminal-view";
import { ViewBoundary } from "@/components/view-boundary";
import type { Thread } from "@/lib/api";
import type { View } from "@/lib/workspace-types";

const LoveSpot = dynamic(() => import("@/components/love-spot"), { ssr: false, loading: () => <p role="status">Opening Love Spot…</p> });
type Props = {
  view: View; selected: Thread | null; threads: Thread[]; cwd: string; dark: boolean; loveToolbarHost: HTMLDivElement | null;
  side: ReturnType<typeof useSidePanel>; hasTerminal: boolean; setTuiLaunch: React.Dispatch<React.SetStateAction<TerminalLaunch | null>>;
  show: (view: View) => void; openSettings: (tab: SettingsDestination) => void; newChat: () => void; editDraft: (value: string) => void;
};

export function WorkspaceGuideAndLab({ view, show }: Pick<Props, "view" | "show">) {
  return <>
    {view === "agentsGuide" && <div className="page-scroll"><ViewBoundary label="Guide to managing agents"><AgentsGuide onBack={() => show("canvas")} /></ViewBoundary></div>}
    {view === "experimentLab" && <ViewBoundary label="Lab"><ExperimentLab /></ViewBoundary>}
  </>;
}

export function OtherWorkspacePages({ view, selected, threads, cwd, dark, loveToolbarHost, side, hasTerminal, setTuiLaunch, show, openSettings, newChat, editDraft }: Props) {
  return <>
    {view === "loveSpot" && <ViewBoundary label="Love Spot"><LoveSpot dark={dark} toolbarHost={loveToolbarHost} /></ViewBoundary>}
    {view === "observability" && <ViewBoundary label="Observability"><ObservabilityView {...(selected ? { threadId: selected.id } : {})} chats={threads} /></ViewBoundary>}
    {view === "customize" && <div className="page-scroll"><ViewBoundary label="Customize"><CustomizeView cwd={cwd} onOpenSettings={() => openSettings("mcp")}
      {...(hasTerminal ? { onConnectGithub: () => { show("chat"); setTuiLaunch({ key: side.openTerminal(cwd), command: "github-login", token: Date.now() }); } } : {})}
      onCreateSkill={() => { newChat(); requestAnimationFrame(() => editDraft("Use $skill-creator to create a new skill that ")); }} /></ViewBoundary></div>}
  </>;
}
