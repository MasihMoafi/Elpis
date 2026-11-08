import type { CanvasController } from "./use-canvas-controller";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuRow } from "@/components/ui/menu-row";
import { PATTERNS } from "@/lib/canvas";
import { over } from "./run-state";
import { CanvasToolbar } from "./canvas-toolbar";

/** The run log, round limit and the pattern, find and run-target pickers floating over the board. */
export function CanvasOverlays({ view }: { view: CanvasController }) {
  const { patternCommand, found, findIndex, runTargets, start } = view;
  return (
    <>
      {view.run &&
        (view.recordedRun ? (
          <details className="canvas-log-panel" aria-label={over(view.run) ? "Previous attempt" : "Run record"}>
            <DisclosureSummary>
              {over(view.run) ? "Previous attempt" : "Run record"} · {view.run.status} ·{" "}
              {view.savedRecord?.tasks?.filter(task => ["succeeded", "completed"].includes(task.status ?? "")).length ??
                0}
              /{view.savedRecord?.tasks?.length ?? 0} tasks complete
            </DisclosureSummary>
            {view.telemetry}
            {view.historicalNotice && <p className="text-destructive">{view.notice}</p>}
            {view.capturedLog}
          </details>
        ) : (
          <section className="canvas-log-panel" aria-label="Run capture">
            <p className="hud-menu-title">Run log · {view.log.length} events</p>
            {view.capturedLog}
          </section>
        ))}
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <CanvasToolbar addAgent={view.addAgent} addNote={view.addNote} openAdder={view.openAdder} tidy={view.tidy} />
      {view.graph.template === "recursive" && (
        <label className="canvas-round-limit">
          Round limit{" "}
          <Input
            className="w-20"
            type="number"
            aria-label="Round limit"
            min={1}
            max={100}
            value={view.graph.roundLimit ?? ""}
            onChange={event =>
              view.setGraph(current => ({
                ...current,
                roundLimit: event.target.value ? Number(event.target.value) : undefined,
              }))
            }
          />
        </label>
      )}
      {patternCommand !== null && (
        <form
          className="canvas-pattern-command hud-menu"
          aria-label="Workflow command"
          onSubmit={event => {
            event.preventDefault();
            view.patternNumber(patternCommand);
          }}
        >
          <span className="text-xs">{PATTERNS.map((name, index) => `${index + 1} ${name}`).join(" · ")}</span>
          <Input
            aria-label="Workflow pattern"
            autoFocus
            inputMode="numeric"
            value={patternCommand}
            placeholder="Pattern number · Esc cancels"
            onChange={event => {
              view.setPatternCommand(event.target.value);
              if (/^\d$/.test(event.target.value)) view.patternNumber(event.target.value);
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                view.setPatternCommand(null);
                view.board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
              }
            }}
          />
        </form>
      )}
      {view.finding !== null && (
        <div
          className="quick-add hud-menu canvas-search"
          role="dialog"
          aria-label="Find on board"
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.stopPropagation();
              view.setFinding(null);
              view.focusBoard();
            } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              view.setFindIndex(
                index =>
                  (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, found.length)) %
                  Math.max(1, found.length),
              );
            } else if (event.key === "Enter" && found[findIndex]) {
              event.preventDefault();
              view.findAgent(found[findIndex].id);
            }
          }}
        >
          <p className="hud-menu-title">
            Find agents <kbd>Ctrl+F</kbd>
          </p>
          <Input
            autoFocus
            aria-label="Find agents"
            value={view.finding}
            onChange={event => {
              view.setFinding(event.target.value);
              view.setFindIndex(0);
            }}
          />
          <div className="quick-add-list" role="listbox" aria-label="Matching agents">
            {found.map((node, index) => (
              <MenuRow
                role="option"
                aria-selected={index === findIndex}
                key={node.id}
                onClick={() => view.findAgent(node.id)}
              >
                {node.data.title}
                {node.data.muted ? " · muted" : ""}
              </MenuRow>
            ))}
          </div>
          {!found.length && <p className="quick-add-note">No matching agents.</p>}
        </div>
      )}
      {runTargets && (
        <div
          className="quick-add hud-menu canvas-search"
          role="dialog"
          aria-label="Run selected"
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.stopPropagation();
              view.setRunTargets(null);
              view.focusBoard();
            }
          }}
        >
          <p className="hud-menu-title">
            Run selected <kbd>Ctrl+Shift+Enter</kbd>
          </p>
          <p className="quick-add-note">Selected targets and their required ancestors, each with its check:</p>
          <ul className="quick-add-list">
            {view.scope.map(node => (
              <li key={node.id}>
                {node.type === "agent" ? node.data.title : ""} ·{" "}
                {runTargets.includes(node.id) ? "target" : "required ancestor"}
              </li>
            ))}
          </ul>
          <Button
            autoFocus
            size="sm"
            aria-describedby={!view.ready ? view.offlineReasonId : undefined}
            disabled={!view.ready}
            onClick={() => {
              const targets = runTargets;
              view.setRunTargets(null);
              view.focusBoard();
              void start(targets);
            }}
          >
            Run selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              view.setRunTargets(null);
              view.focusBoard();
            }}
          >
            Cancel <kbd>Esc</kbd>
          </Button>
        </div>
      )}
    </>
  );
}
