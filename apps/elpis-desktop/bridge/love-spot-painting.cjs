'use strict';
// How an agent paints on the Love Spot board: a fenced ```excalidraw block in its reply holds a JSON list of simple shapes. The bridge
// takes the block out of the note, checks every shape and draws them beside the note, as ordinary Excalidraw elements Masih can move,
// recolour and delete. Nothing in the block can reach the file system or the model: it is data, bounded and validated here.
const FENCE = /```excalidraw[^\n]*\n([\s\S]*?)```/g;
const OPEN_FENCE = /```excalidraw[\s\S]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'text']);
const MAX_SHAPES = 60, MAX_POINTS = 50;

const number = (value, low, high, fallback) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

function shapeFrom(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) return null;
  const shape = {
    type: raw.type,
    strokeColor: COLOR.test(raw.strokeColor) ? raw.strokeColor : '#e03131',
    backgroundColor: COLOR.test(raw.backgroundColor) ? raw.backgroundColor : 'transparent',
    strokeWidth: number(raw.strokeWidth, 1, 6, 2),
  };
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
    const text = raw.text.slice(0, 200), fontSize = number(raw.fontSize, 12, 48, 20), lines = text.split('\n');
    return { ...shape, text, fontSize, x: number(raw.x, -4000, 4000, 0), y: number(raw.y, -4000, 4000, 0),
      width: Math.ceil(Math.max(...lines.map(line => Array.from(line).length)) * fontSize * 0.62), height: Math.ceil(lines.length * fontSize * 1.4) };
  }
  if (raw.type === 'line' || raw.type === 'arrow') {
    if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > MAX_POINTS) return null;
    const points = raw.points.map(point => Array.isArray(point) && point.length === 2 ? [number(point[0], -4000, 4000, NaN), number(point[1], -4000, 4000, NaN)] : null);
    if (points.some(point => !point || point.some(Number.isNaN))) return null;
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]), x = xs[0], y = ys[0];
    return { ...shape, x, y, points: points.map(([px, py]) => [px - x, py - y]), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), left: Math.min(...xs), top: Math.min(...ys) };
  }
  return { ...shape, x: number(raw.x, -4000, 4000, 0), y: number(raw.y, -4000, 4000, 0), width: number(raw.width, 4, 2000, 60), height: number(raw.height, 4, 2000, 60) };
}

/** A reply split into the note to write and the shapes to draw; a block that is not valid JSON draws nothing and is still taken out. */
function splitPainting(reply) {
  const shapes = [];
  const note = String(reply ?? '').replace(FENCE, (_, body) => {
    try {
      const list = JSON.parse(body);
      if (Array.isArray(list)) for (const raw of list) { const shape = shapeFrom(raw); if (shape && shapes.length < MAX_SHAPES) shapes.push(shape); }
    } catch { /* A broken block draws nothing. */ }
    return '';
  }).replace(OPEN_FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { note, shapes };
}

/** What the person reads while a reply streams: the note without the block, finished or not. */
const withoutPainting = reply => String(reply ?? '').replace(FENCE, '').replace(OPEN_FENCE, '').replace(/\n{3,}/g, '\n\n').trim();

const left = shape => shape.left ?? shape.x, top = shape => shape.top ?? shape.y;
/** The size of the painting the shapes make together. */
function paintingSize(shapes) {
  if (!shapes.length) return { width: 0, height: 0 };
  const minX = Math.min(...shapes.map(left)), minY = Math.min(...shapes.map(top));
  return { width: Math.ceil(Math.max(...shapes.map(shape => left(shape) + shape.width)) - minX), height: Math.ceil(Math.max(...shapes.map(shape => top(shape) + shape.height)) - minY) };
}

/** Excalidraw elements for the shapes, with the painting's top left corner at `origin`, grouped so it moves as one. */
function paintElements(shapes, origin, turnId, now = Date.now()) {
  if (!shapes.length) return [];
  const minX = Math.min(...shapes.map(left)), minY = Math.min(...shapes.map(top)), group = `love-paint-${turnId}`;
  return shapes.map((shape, index) => {
    const base = { id: `love-paint-${turnId}-${index}`, type: shape.type, x: origin.x + shape.x - minX, y: origin.y + shape.y - minY, width: shape.width, height: shape.height, angle: 0,
      strokeColor: shape.strokeColor, backgroundColor: shape.backgroundColor, fillStyle: 'solid', strokeWidth: shape.strokeWidth, strokeStyle: 'solid', roughness: 1, opacity: 100,
      groupIds: [group], frameId: null, roundness: shape.type === 'rectangle' || shape.type === 'diamond' ? { type: 3 } : null, seed: 1 + index, version: 1, versionNonce: index,
      isDeleted: false, boundElements: null, updated: now, link: null, locked: false };
    if (shape.type === 'text') return { ...base, fontSize: shape.fontSize, fontFamily: 5, text: shape.text, originalText: shape.text, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 };
    if (shape.type === 'line' || shape.type === 'arrow') return { ...base, points: shape.points, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: shape.type === 'arrow' ? 'arrow' : null };
    return base;
  });
}

module.exports = { splitPainting, withoutPainting, paintingSize, paintElements, MAX_SHAPES };
