import type { XYPosition } from "@xyflow/react";

/** Finds a free spot for a node, near a point and clear of the boxes already taken. */
export type PlaceNode = (
  near?: XYPosition,
  taken?: { x: number; y: number; w: number; h: number }[],
  size?: { w: number; h: number },
  closest?: boolean,
) => { x: number; y: number };
