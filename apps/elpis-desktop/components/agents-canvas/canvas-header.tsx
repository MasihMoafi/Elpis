import type { CanvasController } from "./use-canvas-controller";
import { CalendarClock, Copy, ExternalLink, FileText, ListOrdered, Pencil, Play } from "lucide-react";
import { AgentsIcon, FolderIcon, StopIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { WorkflowProgress } from "@/components/workflow-progress";
import { WorkflowHistory } from "@/components/workflow-history";
import { WorkflowColourMenu, WorkflowIdentityEditor } from "@/components/workflow-identity";
import { ViewToggle } from "@/components/agents-iso";
import { api } from "@/lib/api";
import { languageOf, MOTHER, TEMPLATES } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { over, ENDED, OFFLINE_WORKFLOW } from "./run-state";
import { ENTRY_PATTERNS } from "./constants";
import { LanguageField } from "./fields";

export function CanvasHeader({ recordedRun, run, onLeaveRecordedRun, letElpis, requestText, setGraph, graph, planning, starting, setSelection, setMorePatterns, showPanel, readyMade, pickReadyMade, setNotice, loadTemplate, chosenWorkflow, ready, cwd, chooseFolderFor, offlineReasonId, done, agents, runClock, openResult, savedRecord, liveTeam, onOpenChat, workflowCatalog, onOpenRecordedRun, identity, presetName, renamingPreset, setRenamingPreset, setRun, setStates, projectMenu, iso, setIso, motherOpen, autoLayout, toggleAuto, panelOpen, start, notice, runReasonId, onSchedule }: Pick<CanvasController, "recordedRun" | "run" | "onLeaveRecordedRun" | "letElpis" | "requestText" | "setGraph" | "graph" | "planning" | "starting" | "setSelection" | "setMorePatterns" | "showPanel" | "readyMade" | "pickReadyMade" | "setNotice" | "loadTemplate" | "chosenWorkflow" | "ready" | "cwd" | "chooseFolderFor" | "offlineReasonId" | "done" | "agents" | "runClock" | "openResult" | "savedRecord" | "liveTeam" | "onOpenChat" | "workflowCatalog" | "onOpenRecordedRun" | "identity" | "presetName" | "renamingPreset" | "setRenamingPreset" | "setRun" | "setStates" | "projectMenu" | "iso" | "setIso" | "motherOpen" | "autoLayout" | "toggleAuto" | "panelOpen" | "start" | "notice" | "runReasonId" | "onSchedule">) {
  return <header className="canvas-header">
      {recordedRun ? <div className="flex w-full flex-wrap items-center justify-between gap-2"><span className="text-sm text-muted-foreground">Saved workflow{!run && " · Loading…"}</span><Button size="sm" onClick={onLeaveRecordedRun} disabled={!onLeaveRecordedRun}>New workflow</Button></div> : <form className="flex w-full min-w-0 flex-wrap items-end gap-2" aria-label="New workflow" onSubmit={event => { event.preventDefault(); void letElpis(requestText, undefined, true); }}>
        <label className="field canvas-request">What should the workflow do?<Input aria-label="Workflow request" value={requestText} maxLength={8000} placeholder="Describe what you want to achieve" onChange={event => setGraph(current => ({ ...current, request: event.target.value }))} /></label>
        <OptionSelect aria-label="Workflow pattern" value={graph.planningPattern ?? "auto"} disabled={Boolean(planning || starting)} onChange={event => {
          const value = event.target.value;
          // The catalogue stays open to read during a run; loading a pattern waits for the run.
          if (value === "more") { setSelection([]); setMorePatterns(true); showPanel(true); return; }
          if (value === "auto") { setGraph(current => ({ ...current, planningPattern: "auto" })); return; }
          const workflow = readyMade(value);
          if (workflow) { setGraph(current => ({ ...current, planningPattern: workflow.id })); void pickReadyMade(workflow); return; }
          if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return; }
          const template = TEMPLATES.find(item => item.id === value); if (template) loadTemplate(template);
        }}>{ENTRY_PATTERNS.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}
          {graph.planningPattern && graph.planningPattern !== "auto" && !ENTRY_PATTERNS.some(pattern => pattern.id === graph.planningPattern) && <option value={graph.planningPattern}>{TEMPLATES.find(pattern => pattern.id === graph.planningPattern)?.name ?? "Custom pattern"}</option>}
          <option value="more">More patterns…</option></OptionSelect>
        {chosenWorkflow && <Button type="button" variant="outline" size="sm" disabled={!ready || Boolean(planning || starting)} title={cwd ? `The folder of ${chosenWorkflow.what}: ${cwd}` : undefined} onClick={() => void chooseFolderFor(chosenWorkflow)}><FolderIcon size={14} />Choose folder</Button>}
        {chosenWorkflow?.id === "translate" && <LanguageField value={languageOf(graph.language).name} disabled={Boolean(planning || starting)} onChange={name => {
          // The language stays with the board; a translation team already built is rebuilt for the new one.
          const language = languageOf(name); setGraph(current => ({ ...current, language: language.id }));
          if (graph.planningPattern === "translate" && graph.result) void pickReadyMade(chosenWorkflow, language);
        }} />}
        <Button type="submit" size="sm" aria-describedby={!ready ? offlineReasonId : undefined} disabled={!ready || !cwd || !requestText.trim() && !chosenWorkflow || Boolean(planning || starting)}>{planning ? "Designing…" : "New workflow"}</Button>
        <Button type="button" variant="outline" size="sm" aria-describedby={!ready ? offlineReasonId : undefined} disabled={!ready || !cwd || !requestText.trim() || Boolean(planning || starting || run && !over(run))} onClick={() => void letElpis(requestText)}>Update current</Button>
        {/* The run's status sits beside the request, which gives up the room, so the controls below stay on one row
            while it runs (28 Oct: a running board wrapped them onto a second row). */}
        {run && <span className="canvas-chip" role="status"><i className="canvas-dot" data-status={over(run) ? run.father?.status ?? run.status : "running"} />{over(run) ? ENDED[run.status === "succeeded" ? run.father?.status ?? run.status : run.status] ?? "Finished" : run.father?.threadId ? "Running · the Father agent's part" : "Running"} · {done} of {agents.length} done</span>}
        {run && runClock}
        {/* Stop cancels the whole run: the engine treats an interrupt of the run's own chat as cancelling it (28 Oct:
            "a running workflow has no cancel control anywhere"). */}
        {run && !over(run) && <Button type="button" variant="outline" size="sm" aria-label="Stop run" title="Stop this run: every agent stops, finished work is kept" onClick={() => void api(`/threads/${encodeURIComponent(run.rootThreadId)}/interrupt`, {}).catch((cause: unknown) => setNotice(errorText(cause)))}><StopIcon size={14} />Stop</Button>}
        {run && over(run) && graph.result && <Button type="button" variant="outline" size="sm" onClick={openResult}><FileText size={14} />Open {graph.result.split("/").at(-1)}</Button>}
        {!ready && <p id={offlineReasonId} role="status" className="w-full text-xs text-muted-foreground">{OFFLINE_WORKFLOW}</p>}
      </form>}
      {recordedRun && savedRecord && <div className="w-full"><WorkflowProgress compact run={savedRecord} team={liveTeam} onOpenChat={onOpenChat} /></div>}
      <WorkflowHistory catalog={workflowCatalog} revision={`${run?.graphId ?? ""}:${run?.status ?? ""}`} onOpenChat={onOpenChat} {...(onOpenRecordedRun ? { onOpenCanvas: onOpenRecordedRun } : {})} />
      <div className="canvas-name-group relative flex min-w-0 max-w-full items-center gap-2">
        {identity && presetName && !renamingPreset && !recordedRun && <WorkflowColourMenu identity={identity} catalog={workflowCatalog} onError={setNotice} />}
        {presetName && !renamingPreset && !recordedRun ? <Button variant="ghost" size="icon-sm" aria-label="Rename workflow" title="Rename workflow" onClick={() => setRenamingPreset(true)}><Pencil size={14} /></Button>
          : identity ? <WorkflowIdentityEditor key={identity.id} identity={identity} catalog={workflowCatalog} name={graph.name} onName={name => setGraph(current => ({ ...current, name }))} /> : <Input aria-label="Graph name" className="canvas-name" value={graph.name} readOnly />}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Duplicate workflow" title="Duplicate workflow" onClick={() => { setGraph(current => ({ ...current, workflowId: undefined, name: identity?.name ?? current.name })); setRun(null); setStates({}); setSelection([]); }}><Copy size={14} /></Button>
      {projectMenu}
      <span className="canvas-spacer" />
      <ViewToggle iso={iso} onChange={setIso} />
      {run && <Button variant="ghost" size="icon-sm" aria-label="Open run chat" title="Open run chat" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} /></Button>}
      <Button variant="ghost" size="sm" aria-pressed={motherOpen} onClick={() => setSelection([MOTHER])} title="The run's settings: the brief every agent gets, her model, how many agents"><i className="canvas-kind" data-kind="mother" />Mother agent</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Auto-arrange" aria-pressed={autoLayout} onClick={toggleAuto} title={autoLayout ? "Auto-arrange is on: the board keeps run-order columns (Kahn's waves) after every change. Click to place agents freely." : "Auto-arrange is off. Click to arrange by run order and keep it so."}><ListOrdered size={14} /></Button>
      <Button variant="ghost" size="sm" aria-label="Side panel" aria-pressed={panelOpen} title={panelOpen ? "Hide the side panel: the board takes the whole width" : "Show the side panel: patterns and the selected agent"} onClick={() => showPanel(!panelOpen)}><AgentsIcon size={16} /></Button>
      {!recordedRun && <div className="canvas-run-control">
        <Button variant="outline" size="sm" onClick={() => void start()} aria-describedby={!ready ? offlineReasonId : notice || starting || run && !over(run) ? runReasonId : undefined} disabled={!ready || starting || Boolean(planning || run && !over(run))}><Play size={14} />{starting ? "Starting…" : "Run graph"}</Button>
        {onSchedule && <Button variant="ghost" size="sm" title={requestText.trim() ? "Run this workflow on a schedule" : "Write what the workflow should do first"} disabled={!requestText.trim()}
          onClick={() => onSchedule({ id: graph.workflowId || graph.name || "workflow", name: identity?.name || graph.name || "Workflow", request: requestText.trim(), ...(cwd ? { cwd } : {}), board: graph })}><CalendarClock size={14} />Schedule</Button>}
        {!notice && (starting || run && !over(run)) && <span id={runReasonId} className="sr-only" role="status">{starting ? "Starting the team. Wait for the run to start." : "Wait for this run to finish before starting another."}</span>}
      </div>}
    </header>;
}