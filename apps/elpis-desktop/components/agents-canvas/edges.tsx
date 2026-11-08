import { BaseEdge, Position, getBezierPath, type EdgeProps, type Node } from "@xyflow/react";
import { type CanvasEdge } from "@/lib/canvas";

/** The Mother's first segment is shared; one label names what every first-wave agent receives. */
export function MotherEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps) {
  const split = sourceX + 32;
  return (
    <>
      {data?.trunk === true && (
        <g className="canvas-mother-trunk">
          {typeof data.label === "string" && data.label && (
            <path className="canvas-flow-leader" d={`M ${sourceX + 16},${sourceY} L ${sourceX - 95},${sourceY - 60}`} />
          )}
          <BaseEdge
            id={`${id}-trunk`}
            path={`M ${sourceX},${sourceY} H ${split}`}
            label={typeof data.label === "string" ? data.label : undefined}
            labelX={sourceX - 95}
            labelY={sourceY - 60}
          />
        </g>
      )}
      <BaseEdge
        id={id}
        path={`M ${split},${sourceY} V ${targetY} H ${targetX}`}
        {...(markerEnd === undefined ? {} : { markerEnd })}
      />
    </>
  );
}

export function FlowEdge({ id, label, data, markerEnd, ...ends }: EdgeProps) {
  const [path, x, y] = getBezierPath(ends);
  const labelX = typeof data?.labelX === "number" ? data.labelX : x,
    labelY = typeof data?.labelY === "number" ? data.labelY : y;
  return (
    <>
      {label && Math.hypot(labelX - x, labelY - y) > 12 && (
        <path className="canvas-flow-leader" d={`M ${x},${y} L ${labelX},${labelY}`} />
      )}
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        label={label}
        labelX={labelX}
        labelY={labelY}
        labelStyle={{ fontSize: 12 }}
      />
    </>
  );
}

export const EDGE_TYPES = { mother: MotherEdge, default: FlowEdge };

/** Keep flat flow labels off cards and each other, nearest their wire. Positions use graph units, like the edges. */
export function flowLabelPositions(nodes: Node[], edges: CanvasEdge[]) {
  const result = new Map<string, { labelX: number; labelY: number }>();
  if (!nodes.length) return result;
  const boxes = nodes.map(node => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    w: node.measured?.width ?? 195,
    h: node.measured?.height ?? 96,
  }));
  const left = Math.min(...boxes.map(box => box.x)),
    right = Math.max(...boxes.map(box => box.x + box.w));
  const top = Math.min(...boxes.map(box => box.y)) - 32,
    bottom = Math.max(...boxes.map(box => box.y + box.h)) + 32;
  const taken = boxes.map(box => ({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 }));
  for (const edge of edges) {
    const from = boxes.find(box => box.id === edge.source),
      to = boxes.find(box => box.id === edge.target);
    if (!edge.label || !from || !to) continue;
    const [, x, y] = getBezierPath({
      sourceX: from.x + from.w,
      sourceY: from.y + from.h / 2,
      targetX: to.x,
      targetY: to.y + to.h / 2,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
    const w = edge.label.length * 7 + 16,
      h = 24,
      slots = [{ x, y }];
    for (let sy = top + h / 2; sy <= bottom - h / 2; sy += 24)
      for (let sx = left + w / 2; sx <= right - w / 2; sx += 24) slots.push({ x: sx, y: sy });
    slots.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    const at = slots.find(
      slot =>
        slot.x - w / 2 >= left &&
        slot.x + w / 2 <= right &&
        !taken.some(
          box =>
            slot.x - w / 2 < box.x + box.w &&
            box.x < slot.x + w / 2 &&
            slot.y - h / 2 < box.y + box.h &&
            box.y < slot.y + h / 2,
        ),
    ) ?? { x, y };
    taken.push({ x: at.x - w / 2, y: at.y - h / 2, w, h });
    result.set(edge.id, { labelX: at.x, labelY: at.y });
  }
  return result;
}
