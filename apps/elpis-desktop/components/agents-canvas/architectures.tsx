import type { CanvasController } from "./use-canvas-controller";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Button, buttonVariants } from "@/components/ui/button";
import { WORKFLOWS, TEMPLATES } from "@/lib/canvas";
import { Shape } from "./fields";

export function Architectures({
  morePatterns,
  setMorePatterns,
  graph,
  ready,
  planning,
  starting,
  setGraph,
  pickReadyMade,
  shapes,
  loadTemplate,
  setSelection,
  setSourceId,
}: Pick<
  CanvasController,
  | "morePatterns"
  | "setMorePatterns"
  | "graph"
  | "ready"
  | "planning"
  | "starting"
  | "setGraph"
  | "pickReadyMade"
  | "shapes"
  | "loadTemplate"
  | "setSelection"
  | "setSourceId"
>) {
  return (
    <aside className="canvas-side" aria-label="Architectures">
      <details
        open={morePatterns}
        onToggle={event => {
          if (event.target === event.currentTarget) setMorePatterns(event.currentTarget.open);
        }}
      >
        <DisclosureSummary>More patterns</DisclosureSummary>
        <section className="canvas-templates" aria-label="Ready-made workflows">
          <p className="hud-menu-title">Ready-made workflows</p>
          {WORKFLOWS.map(workflow => (
            <div key={workflow.id}>
              <Button
                variant="ghost"
                size="content"
                className="canvas-template w-full"
                aria-current={(graph.result && graph.planningPattern === workflow.id) || undefined}
                disabled={!ready || Boolean(planning || starting)}
                onClick={() => {
                  setGraph(current => ({ ...current, planningPattern: workflow.id }));
                  void pickReadyMade(workflow);
                }}
              >
                <strong>
                  {workflow.name}
                  {graph.result && graph.planningPattern === workflow.id && (
                    <span className="canvas-template-loaded">On the board</span>
                  )}
                </strong>
                <Shape shape={shapes.get(workflow.id) ?? []} />
                <small>{workflow.description}</small>
              </Button>
            </div>
          ))}
        </section>
        {(["Patterns", "Research", "Start"] as const).map(group => (
          <section key={group} className="canvas-templates" aria-label={group}>
            <p className="hud-menu-title">{group === "Start" ? "Start fresh" : group}</p>
            {TEMPLATES.filter(template => template.group === group).map(template => (
              <div key={template.id}>
                <Button
                  variant="ghost"
                  size="content"
                  className="canvas-template w-full"
                  aria-current={graph.template === template.id || undefined}
                  onClick={() => loadTemplate(template)}
                >
                  <strong>
                    {template.name}
                    {graph.template === template.id && <span className="canvas-template-loaded">On the board</span>}
                  </strong>
                  <Shape shape={shapes.get(template.id) ?? []} />
                  <small>{template.description}</small>
                  {template.caution && <small className="canvas-template-caution">{template.caution}</small>}
                  {template.source && <small className="canvas-template-source">{template.source}</small>}
                </Button>
                <a
                  className={buttonVariants({ variant: "link", size: "xs" })}
                  href={`#workflow-sources-${template.id}`}
                  aria-label={`Sources for ${template.name}`}
                  onClick={event => {
                    event.preventDefault();
                    setSelection([]);
                    setSourceId(template.id);
                  }}
                >
                  Sources
                </a>
              </div>
            ))}
          </section>
        ))}
      </details>
    </aside>
  );
}
