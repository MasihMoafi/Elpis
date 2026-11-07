import { ReactFlowProvider } from "@xyflow/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkflowSources } from "@/components/workflow-sources";
import { Props } from "./types";
import { CanvasHeader } from "./canvas-header";
import { SelectedAgent } from "./selected-agent";
import { SelectedAgents } from "./selected-agents";
import { MotherSettingsPanel } from "./mother-settings-panel";
import { Architectures } from "./architectures";
import { CanvasBoard } from "./canvas-board";
import { useCanvasController } from "./use-canvas-controller";

export function AgentsCanvas(props: Props) {
  return <ReactFlowProvider><Canvas key={props.recordedRun?.id ?? "draft"} {...props} /></ReactFlowProvider>;
}

function Canvas(props: Props) {
  const view = useCanvasController(props);
  const { recordedRun, panelOpen, sourceId, setSourceId, selected, chosen, motherOpen, notice, historicalNotice, runReasonId, setNotice } = view;
  return <section className="agents-canvas" aria-label="Workflows" data-recorded={recordedRun ? true : undefined} data-panel={panelOpen ? "open" : "closed"}>
    <CanvasHeader {...view} />
    <CanvasBoard {...view} />
    {!panelOpen ? null : sourceId ? <WorkflowSources id={sourceId} onBack={() => setSourceId(null)} /> : selected ? <SelectedAgent {...view} selected={selected} /> : chosen.length > 1 ? <SelectedAgents {...view} /> : motherOpen ? <MotherSettingsPanel {...view} /> : <Architectures {...view} />}
    {notice && !historicalNotice && <div id={runReasonId} className="canvas-notice canvas-error-notice" role="alert">
      <div className="canvas-error-details" role="region" aria-label="Workflow error details" tabIndex={0}>{notice}</div>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice("")}><X size={13} /></Button>
    </div>}
  </section>;
}