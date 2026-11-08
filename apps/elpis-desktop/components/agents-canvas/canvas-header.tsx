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

export function CanvasHeader({ view }: { view: CanvasController }) {
  const { run, chosenWorkflow, onSchedule } = view;
  return (
    <header className="canvas-header">
      {view.recordedRun ? (
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Saved workflow{!run && " · Loading…"}</span>
          <Button size="sm" onClick={view.onLeaveRecordedRun} disabled={!view.onLeaveRecordedRun}>
            New workflow
          </Button>
        </div>
      ) : (
        <form
          className="flex w-full min-w-0 flex-wrap items-end gap-2"
          aria-label="New workflow"
          onSubmit={event => {
            event.preventDefault();
            void view.letElpis(view.requestText, undefined, true);
          }}
        >
          <label className="field canvas-request">
            What should the workflow do?
            <Input
              aria-label="Workflow request"
              value={view.requestText}
              maxLength={8000}
              placeholder="Describe what you want to achieve"
              onChange={event => view.setGraph(current => ({ ...current, request: event.target.value }))}
            />
          </label>
          <OptionSelect
            aria-label="Workflow pattern"
            value={view.graph.planningPattern ?? "auto"}
            disabled={Boolean(view.planning || view.starting)}
            onChange={event => {
              const value = event.target.value;
              // The catalogue stays open to read during a run; loading a pattern waits for the run.
              if (value === "more") {
                view.setSelection([]);
                view.setMorePatterns(true);
                view.showPanel(true);
                return;
              }
              if (value === "auto") {
                view.setGraph(current => ({ ...current, planningPattern: "auto" }));
                return;
              }
              const workflow = view.readyMade(value);
              if (workflow) {
                view.setGraph(current => ({ ...current, planningPattern: workflow.id }));
                void view.pickReadyMade(workflow);
                return;
              }
              if (run && !over(run)) {
                view.setNotice("Wait for this run to finish before changing its pattern.");
                return;
              }
              const template = TEMPLATES.find(item => item.id === value);
              if (template) view.loadTemplate(template);
            }}
          >
            {ENTRY_PATTERNS.map(pattern => (
              <option key={pattern.id} value={pattern.id}>
                {pattern.label}
              </option>
            ))}
            {view.graph.planningPattern &&
              view.graph.planningPattern !== "auto" &&
              !ENTRY_PATTERNS.some(pattern => pattern.id === view.graph.planningPattern) && (
                <option value={view.graph.planningPattern}>
                  {TEMPLATES.find(pattern => pattern.id === view.graph.planningPattern)?.name ?? "Custom pattern"}
                </option>
              )}
            <option value="more">More patterns…</option>
          </OptionSelect>
          {chosenWorkflow && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!view.ready || Boolean(view.planning || view.starting)}
              title={view.cwd ? `The folder of ${chosenWorkflow.what}: ${view.cwd}` : undefined}
              onClick={() => void view.chooseFolderFor(chosenWorkflow)}
            >
              <FolderIcon size={14} />
              Choose folder
            </Button>
          )}
          {chosenWorkflow?.id === "translate" && (
            <LanguageField
              value={languageOf(view.graph.language).name}
              disabled={Boolean(view.planning || view.starting)}
              onChange={name => {
                // The language stays with the board; a translation team already built is rebuilt for the new one.
                const language = languageOf(name);
                view.setGraph(current => ({ ...current, language: language.id }));
                if (view.graph.planningPattern === "translate" && view.graph.result)
                  void view.pickReadyMade(chosenWorkflow, language);
              }}
            />
          )}
          <Button
            type="submit"
            size="sm"
            aria-describedby={!view.ready ? view.offlineReasonId : undefined}
            disabled={
              !view.ready ||
              !view.cwd ||
              (!view.requestText.trim() && !chosenWorkflow) ||
              Boolean(view.planning || view.starting)
            }
          >
            {view.planning ? "Designing…" : "New workflow"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={!view.ready ? view.offlineReasonId : undefined}
            disabled={
              !view.ready ||
              !view.cwd ||
              !view.requestText.trim() ||
              Boolean(view.planning || view.starting || (run && !over(run)))
            }
            onClick={() => void view.letElpis(view.requestText)}
          >
            Update current
          </Button>
          {view.planning && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Stop designing"
              title="Stop designing: your workflow stays as it is"
              onClick={view.stopPlanning}
            >
              Stop
            </Button>
          )}
          {/* The run's status sits beside the request, which gives up the room, so the controls below stay on one row
            while it runs (28 Oct: a running board wrapped them onto a second row). */}
          {run && (
            <span className="canvas-chip" role="status">
              <i className="canvas-dot" data-status={over(run) ? (run.father?.status ?? run.status) : "running"} />
              {over(run)
                ? (ENDED[run.status === "succeeded" ? (run.father?.status ?? run.status) : run.status] ?? "Finished")
                : run.father?.threadId
                  ? "Running · the Father agent's part"
                  : "Running"}{" "}
              · {view.done} of {view.agents.length} done
            </span>
          )}
          {run && view.runClock}
          {/* Stop cancels the whole run: the engine treats an interrupt of the run's own chat as cancelling it (28 Oct:
            "a running workflow has no cancel control anywhere"). */}
          {run && !over(run) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Stop run"
              title="Stop this run: every agent stops, finished work is kept"
              onClick={() =>
                void api(`/threads/${encodeURIComponent(run.rootThreadId)}/interrupt`, {}).catch((cause: unknown) =>
                  view.setNotice(errorText(cause)),
                )
              }
            >
              <StopIcon size={14} />
              Stop
            </Button>
          )}
          {run && over(run) && view.graph.result && (
            <Button type="button" variant="outline" size="sm" onClick={view.openResult}>
              <FileText size={14} />
              Open {view.graph.result.split("/").at(-1)}
            </Button>
          )}
          {!view.ready && (
            <p id={view.offlineReasonId} role="status" className="w-full text-xs text-muted-foreground">
              {OFFLINE_WORKFLOW}
            </p>
          )}
        </form>
      )}
      {view.recordedRun && view.savedRecord && (
        <div className="w-full">
          <WorkflowProgress compact run={view.savedRecord} team={view.liveTeam} onOpenChat={view.onOpenChat} />
        </div>
      )}
      <WorkflowHistory
        catalog={view.workflowCatalog}
        revision={`${run?.graphId ?? ""}:${run?.status ?? ""}`}
        onOpenChat={view.onOpenChat}
        {...(view.onOpenRecordedRun ? { onOpenCanvas: view.onOpenRecordedRun } : {})}
      />
      <div className="canvas-name-group relative flex min-w-0 max-w-full items-center gap-2">
        {view.identity && view.presetName && !view.renamingPreset && !view.recordedRun && (
          <WorkflowColourMenu identity={view.identity} catalog={view.workflowCatalog} onError={view.setNotice} />
        )}
        {view.presetName && !view.renamingPreset && !view.recordedRun ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Rename workflow"
            title="Rename workflow"
            onClick={() => view.setRenamingPreset(true)}
          >
            <Pencil size={14} />
          </Button>
        ) : view.identity ? (
          <WorkflowIdentityEditor
            key={view.identity.id}
            identity={view.identity}
            catalog={view.workflowCatalog}
            name={view.graph.name}
            onName={name => view.setGraph(current => ({ ...current, name }))}
          />
        ) : (
          <Input aria-label="Graph name" className="canvas-name" value={view.graph.name} readOnly />
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Duplicate workflow"
        title="Duplicate workflow"
        onClick={() => {
          view.setGraph(current => ({ ...current, workflowId: undefined, name: view.identity?.name ?? current.name }));
          view.setRun(null);
          view.setStates({});
          view.setSelection([]);
        }}
      >
        <Copy size={14} />
      </Button>
      {view.projectMenu}
      <span className="canvas-spacer" />
      <ViewToggle iso={view.iso} onChange={view.setIso} />
      {run && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open run chat"
          title="Open run chat"
          onClick={() => view.onOpenChat(run.rootThreadId)}
        >
          <ExternalLink size={14} />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={view.motherOpen}
        onClick={() => view.setSelection([MOTHER])}
        title="The run's settings: the brief every agent gets, her model, how many agents"
      >
        <i className="canvas-kind" data-kind="mother" />
        Mother agent
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Auto-arrange"
        aria-pressed={view.autoLayout}
        onClick={view.toggleAuto}
        title={
          view.autoLayout
            ? "Auto-arrange is on: the board keeps run-order columns (Kahn's waves) after every change. Click to place agents freely."
            : "Auto-arrange is off. Click to arrange by run order and keep it so."
        }
      >
        <ListOrdered size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Side panel"
        aria-pressed={view.panelOpen}
        title={
          view.panelOpen
            ? "Hide the side panel: the board takes the whole width"
            : "Show the side panel: patterns and the selected agent"
        }
        onClick={() => view.showPanel(!view.panelOpen)}
      >
        <AgentsIcon size={16} />
      </Button>
      {!view.recordedRun && (
        <div className="canvas-run-control">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void view.start()}
            aria-describedby={
              !view.ready
                ? view.offlineReasonId
                : view.notice || view.starting || (run && !over(run))
                  ? view.runReasonId
                  : undefined
            }
            disabled={!view.ready || view.starting || Boolean(view.planning || (run && !over(run)))}
          >
            <Play size={14} />
            {view.starting ? "Starting…" : "Run graph"}
          </Button>
          {onSchedule && (
            <Button
              variant="ghost"
              size="sm"
              title={
                view.requestText.trim() ? "Run this workflow on a schedule" : "Write what the workflow should do first"
              }
              disabled={!view.requestText.trim()}
              onClick={() =>
                onSchedule({
                  id: view.graph.workflowId || view.graph.name || "workflow",
                  name: view.identity?.name || view.graph.name || "Workflow",
                  request: view.requestText.trim(),
                  ...(view.cwd ? { cwd: view.cwd } : {}),
                  board: view.graph,
                })
              }
            >
              <CalendarClock size={14} />
              Schedule
            </Button>
          )}
          {!view.notice && (view.starting || (run && !over(run))) && (
            <span id={view.runReasonId} className="sr-only" role="status">
              {view.starting
                ? "Starting the team. Wait for the run to start."
                : "Wait for this run to finish before starting another."}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
