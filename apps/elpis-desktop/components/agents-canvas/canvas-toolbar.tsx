import type { CanvasController } from "./use-canvas-controller";
import { ListOrdered, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CanvasToolbar({
  addAgent,
  addNote,
  openAdder,
  tidy,
}: Pick<CanvasController, "addAgent" | "addNote" | "openAdder" | "tidy">) {
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="Add to Workflows">
      <span className="canvas-toolbar-label">Add</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Add agent"
        title="An agent that writes: give it a prompt and the folders it may write; Elpis checks its work after it"
        onClick={() => addAgent()}
      >
        <i className="canvas-kind" data-kind="agent" />
        Agent <kbd aria-hidden="true">A</kbd>
      </Button>
      <Button variant="ghost" size="sm" onClick={() => addNote()}>
        <StickyNote size={14} />
        Note <kbd aria-hidden="true">Shift+S</kbd>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="canvas-toolbar-more"
        onClick={() => openAdder()}
        title="Type a prompt, or how many, the model and thinking, then the prompts; Tab opens it too"
      >
        Command <kbd>Tab</kbd>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Arrange by run order"
        title="Arrange by run order and fit the view"
        onClick={tidy}
      >
        <ListOrdered size={14} />
        Arrange <kbd aria-hidden="true">Shift+Alt+T</kbd>
      </Button>
      {/* The guide to managing agents mounts here (components/canvas-guide-help.tsx), always one click away. */}
      <section className="canvas-guide" aria-label="Guide" />
    </div>
  );
}
