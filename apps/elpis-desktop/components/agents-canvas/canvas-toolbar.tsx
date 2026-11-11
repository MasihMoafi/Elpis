import type { CanvasController } from "./use-canvas-controller";
import { Button } from "@/components/ui/button";

/**
 * The bar under the board adds an agent by hand and opens the guide. Notes, the command bar and arranging left it on
 * 11 Nov (Masih: "does anyone ever use such a feature?"); they stay on the board's right-click menu and their keys.
 */
export function CanvasToolbar({ addAgent }: Pick<CanvasController, "addAgent">) {
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
      {/* The guide to managing agents mounts here (components/canvas-guide-help.tsx), always one click away. */}
      <section className="canvas-guide" aria-label="Guide" />
    </div>
  );
}
