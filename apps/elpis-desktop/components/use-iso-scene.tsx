"use client";

import { CHECK_LABEL as CHECK, STATUS_LABEL as STATUS, checkOf } from "@/lib/canvas";
import { ISO_STEP, project, type Box, type IsoPlace, type Point } from "@/lib/iso";
import type { IsoBoardState } from "./use-iso-board-state";
import { bounds, INSET, shapeOf, height, LABEL, textWidth, meet } from "./agents-iso-shared";

export function useIsoScene(previous: IsoBoardState) {
  const {
    places,
    screen,
    hot,
    selected,
    size,
    renaming,
    titleOf,
    family,
    workflowIdentity,
    subject,
    byId,
    nodes,
    modelLabel,
    agents,
    parentLine,
    states,
    statusOf,
  } = previous;
  // The ground: a plate under the graph with a grid offset from the agents, so each stands in a cell.
  const us = places.map(place => place.ground.u),
    vs = places.map(place => place.ground.v);
  const u0 = Math.min(0, ...us) - ISO_STEP.column * 0.75,
    u1 = Math.max(0, ...us) + ISO_STEP.column * 0.75,
    v0 = Math.min(0, ...vs) - ISO_STEP.row * 0.75,
    v1 = Math.max(0, ...vs) + ISO_STEP.row * 0.75;
  const grid: [Point, Point][] = [];
  for (let u = u0 + ISO_STEP.column / 4; u < u1; u += ISO_STEP.column / 2) grid.push([project(u, v0), project(u, v1)]);
  for (let v = v0 + ISO_STEP.row / 4; v < v1; v += ISO_STEP.row / 2) grid.push([project(u0, v), project(u1, v)]);
  // Nearer pedestals are drawn over farther ones.
  const painted = [...places].sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
  // Each title stands upright above its pedestal. Where the graph is dense, a title that would cover another title or
  // another agent's block shows only its wave badge, until it is pointed at, focused or selected, or zoomed into room;
  // the Mother's and those always show in full.
  const anchor = (place: IsoPlace) => {
    const shape = shapeOf(place);
    return screen({ x: place.at.x, y: place.at.y - shape.core / 2 - height(shape) });
  };
  // Labels must clear the whole pedestal, including its ground plate and check ring.
  const block = (place: IsoPlace): Box => {
    const box = bounds([place]),
      top = screen({ x: box.left, y: box.top }),
      bottom = screen({ x: box.right, y: box.bottom });
    return { left: top.x, top: top.y, right: bottom.x, bottom: bottom.y };
  };
  const kept = (place: IsoPlace) => place.kind !== "agent" || place.id === hot || selected.includes(place.id);
  const full = new Set<string>(),
    taken: Box[] = [],
    labelPositions = new Map<string, Point>();
  const labelBox = (at: Point, width: number, labelHeight = LABEL.height): Box => ({
    left: at.x - width / 2,
    top: at.y - labelHeight,
    right: at.x + width / 2,
    bottom: at.y,
  });
  const labelAt = (place: IsoPlace, width: number, labelHeight = LABEL.height) => {
    const at = anchor(place);
    return {
      x: Math.max(width / 2 + 6, Math.min((size?.width ?? Infinity) - width / 2 - 6, at.x)),
      y: Math.max(labelHeight + 6, Math.min((size?.height ?? Infinity) - INSET.bottom, at.y - LABEL.gap)),
    };
  };
  for (const place of [...places].sort((a, b) => Number(kept(b)) - Number(kept(a)))) {
    // A pillar adds 5px of left padding; the workflow mark also occupies 9px + 6px margins + the 6px gap.
    const width =
      renaming === place.id
        ? LABEL.max
        : Math.min(
            LABEL.max,
            textWidth(titleOf(place.id), family) +
              LABEL.chrome +
              (place.kind === "agent" ? LABEL.badge : 5 + (place.kind === "mother" && workflowIdentity ? 21 : 0)),
          );
    const labelHeight = renaming === place.id ? 36 : LABEL.height;
    let at = labelAt(place, width, labelHeight),
      box = labelBox(at, width, labelHeight);
    if (
      place.id === hot ||
      (selected.length === 1 && selected.includes(place.id)) ||
      (!taken.some(other => meet(other, box)) && !places.some(other => other !== place && meet(block(other), box)))
    )
      full.add(place.id);
    else if (place.kind === "agent") {
      at = labelAt(place, LABEL.badge, labelHeight);
      box = labelBox(at, LABEL.badge, labelHeight);
    } else full.add(place.id);
    const usedWidth = full.has(place.id) ? width : LABEL.badge;
    // A dense graph keeps wave badges; if even those meet, move a label to the nearest free row.
    const original = at;
    const collides = () => taken.some(other => meet(other, box)) || places.some(other => meet(block(other), box));
    for (let step = 0; collides() && step < 60; step++) {
      const offset = (Math.floor(step / 2) + 1) * (labelHeight + 4) * (step % 2 ? 1 : -1);
      const y = original.y + offset;
      if (y < labelHeight + 6 || y > (size?.height ?? Infinity) - INSET.bottom) continue;
      at = { ...original, y };
      box = labelBox(at, usedWidth, labelHeight);
    }
    // A short board may have no free row above this pedestal. Use the nearest free slot to either side instead of
    // leaving a badge on its own block, where it would intercept the block's mouse and keyboard interactions.
    if (collides() && size) {
      const xs = [original.x],
        ys = [original.y];
      for (let x = usedWidth / 2 + 6; x <= size.width - usedWidth / 2 - 6; x += usedWidth + 8) xs.push(x);
      for (let y = labelHeight + 6; y <= size.height - INSET.bottom; y += labelHeight + 4) ys.push(y);
      const slots = ys
        .flatMap(y => xs.map(x => ({ x, y })))
        .sort(
          (a, b) => Math.hypot(a.x - original.x, a.y - original.y) - Math.hypot(b.x - original.x, b.y - original.y),
        );
      const free = slots.find(slot => {
        const box = labelBox(slot, usedWidth, labelHeight);
        return !taken.some(other => meet(other, box)) && !places.some(other => meet(block(other), box));
      });
      if (free) {
        at = free;
        box = labelBox(at, usedWidth, labelHeight);
      }
    }
    taken.push(box);
    labelPositions.set(place.id, at);
  }
  const subjectPlace = subject ? byId.get(subject) : undefined;
  const subjectNode = subjectPlace ? nodes.get(subjectPlace.id) : undefined;
  const subjectModel =
    subjectNode?.type === "agent"
      ? `${modelLabel(subjectNode.data)}${subjectNode.data.effort ? ` · ${subjectNode.data.effort} thinking` : ""}`
      : null;
  const overview = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  const subjectLine = !subjectPlace
    ? ""
    : subjectPlace.kind !== "agent"
      ? parentLine(subjectPlace.id).join(" · ")
      : states[subjectPlace.id]?.status === "running" && states[subjectPlace.id]?.activity
        ? `Now: ${states[subjectPlace.id]?.activity}`
        : `${STATUS[statusOf(subjectPlace.id)]} · ${CHECK[statusOf(checkOf(subjectPlace.id))]}`;
  return {
    ...previous,
    u0,
    u1,
    v0,
    v1,
    grid,
    painted,
    full,
    taken,
    labelPositions,
    labelBox,
    subjectPlace,
    subjectModel,
    overview,
    subjectLine,
  };
}

export type IsoScene = ReturnType<typeof useIsoScene>;
