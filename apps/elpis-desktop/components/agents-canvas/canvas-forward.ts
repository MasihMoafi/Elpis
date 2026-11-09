import type { canvasNavigation } from "./canvas-navigation";

/** What the board model's closures call but the interaction layer creates. Filled in during each render. */
export type CanvasForward = {
  focusBoard: ReturnType<typeof canvasNavigation>["focusBoard"];
  fitAll: () => void;
};
