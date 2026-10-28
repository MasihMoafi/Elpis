'use strict';
// How an agent paints on the Love Spot board: a fenced ```excalidraw block in its reply holds a JSON list of simple shapes. The bridge
// takes the block out of the note, checks every shape and draws them beside the note, as ordinary Excalidraw elements Masih can move,
// recolour and delete. Nothing in the block can reach the file system or the model: it is data, bounded and validated here.
const FENCE = /```excalidraw[^\n]*\n([\s\S]*?)```/g;
const OPEN_FENCE = /```excalidraw[\s\S]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'text']);
const MAX_SHAPES = 60, MAX_POINTS = 50;
// Styles she may choose; anything else falls back to the board's hand-drawn default. Fonts: 5 hand-drawn, 6 normal, 7 bold display, 8 code.
const STROKES = new Set(['solid', 'dashed', 'dotted']), FILLS = new Set(['solid', 'hachure', 'cross-hatch']), ALIGNS = new Set(['left', 'center', 'right']);
const FONTS = new Map([[5, 0.62], [6, 0.56], [7, 0.56], [8, 0.62]]); // average glyph width per font size, to size text boxes

const number = (value, low, high, fallback) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

function shapeFrom(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) return null;
  const shape = {
    type: raw.type,
    strokeColor: COLOR.test(raw.strokeColor) ? raw.strokeColor : '#e03131',
    backgroundColor: COLOR.test(raw.backgroundColor) ? raw.backgroundColor : 'transparent',
    strokeWidth: number(raw.strokeWidth, 1, 6, 2),
    roughness: Math.round(number(raw.roughness, 0, 2, 1)),
    strokeStyle: STROKES.has(raw.strokeStyle) ? raw.strokeStyle : 'solid',
    fillStyle: FILLS.has(raw.fillStyle) ? raw.fillStyle : 'solid',
    opacity: Math.round(number(raw.opacity, 10, 100, 100)),
  };
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
    const text = raw.text.slice(0, 200), fontSize = number(raw.fontSize, 12, 48, 20), lines = text.split('\n');
    const fontFamily = FONTS.has(raw.fontFamily) ? raw.fontFamily : 5, textAlign = ALIGNS.has(raw.textAlign) ? raw.textAlign : 'left';
    return { ...shape, text, fontSize, fontFamily, textAlign, x: number(raw.x, -4000, 4000, 0), y: number(raw.y, -4000, 4000, 0),
      width: Math.ceil(Math.max(...lines.map(line => Array.from(line).length)) * fontSize * FONTS.get(fontFamily)), height: Math.ceil(lines.length * fontSize * 1.4) };
  }
  if (raw.type === 'line' || raw.type === 'arrow') {
    if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > MAX_POINTS) return null;
    const points = raw.points.map(point => Array.isArray(point) && point.length === 2 ? [number(point[0], -4000, 4000, NaN), number(point[1], -4000, 4000, NaN)] : null);
    if (points.some(point => !point || point.some(Number.isNaN))) return null;
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]), x = xs[0], y = ys[0];
    const offsetX = number(raw.x, -4000, 4000, 0), offsetY = number(raw.y, -4000, 4000, 0);
    return { ...shape, x: x + offsetX, y: y + offsetY, offsetX, offsetY, points: points.map(([px, py]) => [px - x, py - y]), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), left: Math.min(...xs) + offsetX, top: Math.min(...ys) + offsetY };
  }
  return { ...shape, x: number(raw.x, -4000, 4000, 0), y: number(raw.y, -4000, 4000, 0), width: number(raw.width, 4, 2000, 60), height: number(raw.height, 4, 2000, 60) };
}

/** Her note as the board shows it: plain text, so Markdown marks (bold, code, headings, bullets) are taken out. */
const plainNote = text => text.split('\n').map(line => line
  .replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1• ')
  .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => a ?? b).replace(/`([^`\n]+)`/g, '$1')).join('\n');

/** A reply split into the note to write and the shapes to draw; a block that is not valid JSON draws nothing and is still taken out. */
function parsePainting(body) {
  const shapes = [];
  if (typeof body !== 'string' || body.length > 256 * 1024) return shapes;
  try {
    const list = JSON.parse(body);
    if (Array.isArray(list)) for (const raw of list) { const shape = shapeFrom(raw); if (shape) shapes.push(shape); if (shapes.length === MAX_SHAPES) break; }
  } catch { /* Incomplete or invalid data never becomes executable markup. */ }
  return shapes;
}
function splitPainting(reply) {
  const shapes = [];
  const note = String(reply ?? '').replace(FENCE, (_, body) => {
    shapes.push(...parsePainting(body).slice(0, MAX_SHAPES - shapes.length));
    return '';
  }).replace(OPEN_FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { note: plainNote(note), shapes };
}

/** What the person reads while a reply streams: the note without the block, finished or not. */
const withoutPainting = reply => plainNote(String(reply ?? '').replace(FENCE, '').replace(OPEN_FENCE, '').replace(/\n{3,}/g, '\n\n').trim());

const left = shape => shape.left ?? shape.x, top = shape => shape.top ?? shape.y;
/** The size of the painting the shapes make together. */
function paintingSize(shapes) {
  if (!shapes.length) return { width: 0, height: 0 };
  const minX = Math.min(...shapes.map(left)), minY = Math.min(...shapes.map(top));
  return { width: Math.ceil(Math.max(...shapes.map(shape => left(shape) + shape.width)) - minX), height: Math.ceil(Math.max(...shapes.map(shape => top(shape) + shape.height)) - minY) };
}

/** Excalidraw elements for the shapes, with the painting's top left corner at `origin`, grouped so it moves as one (and inside `outer`, if given). */
function paintElements(shapes, origin, turnId, outer, now = Date.now()) {
  if (!shapes.length) return [];
  const minX = Math.min(...shapes.map(left)), minY = Math.min(...shapes.map(top)), group = `love-paint-${turnId}`;
  return shapes.map((shape, index) => {
    const base = { id: `love-paint-${turnId}-${index}`, type: shape.type, x: origin.x + shape.x - minX, y: origin.y + shape.y - minY, width: shape.width, height: shape.height, angle: 0,
      strokeColor: shape.strokeColor, backgroundColor: shape.backgroundColor, fillStyle: shape.fillStyle, strokeWidth: shape.strokeWidth, strokeStyle: shape.strokeStyle, roughness: shape.roughness, opacity: shape.opacity,
      groupIds: outer ? [group, outer] : [group], frameId: null, roundness: shape.type === 'rectangle' || shape.type === 'diamond' ? { type: 3 } : null, seed: 1 + index, version: 1, versionNonce: index,
      isDeleted: false, boundElements: null, updated: now, link: null, locked: false };
    if (shape.type === 'text') return { ...base, fontSize: shape.fontSize, fontFamily: shape.fontFamily, text: shape.text, originalText: shape.text, textAlign: shape.textAlign, verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 };
    if (shape.type === 'line' || shape.type === 'arrow') return { ...base, points: shape.points, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: shape.type === 'arrow' ? 'arrow' : null };
    return base;
  });
}

/** An inert image for chat, from exactly the same validated geometry as the board. */
function diagramSvg(source) {
  const shapes = parsePainting(source);
  if (!shapes.length) return null;
  const size = paintingSize(shapes), padding = 16;
  const elements = paintElements(shapes, { x: padding, y: padding }, 'inline', undefined, 0);
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const markers = [...new Set(shapes.filter(shape => shape.type === 'arrow').map(shape => shape.strokeColor))].map(color => `<marker id="arrow-${color.slice(1)}" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="${color}" stroke-width="1.5"/></marker>`).join('');
  const content = elements.map(e => {
    const style = `fill="${e.backgroundColor}" stroke="${e.strokeColor}" stroke-width="${e.strokeWidth}"`;
    if (e.type === 'rectangle') return `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="6" ${style}/>`;
    if (e.type === 'ellipse') return `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" rx="${e.width / 2}" ry="${e.height / 2}" ${style}/>`;
    if (e.type === 'diamond') return `<polygon points="${e.x + e.width / 2},${e.y} ${e.x + e.width},${e.y + e.height / 2} ${e.x + e.width / 2},${e.y + e.height} ${e.x},${e.y + e.height / 2}" ${style}/>`;
    if (e.type === 'text') return `<text fill="${e.strokeColor}" font-family="Arial, sans-serif" font-size="${e.fontSize}" dominant-baseline="hanging">${e.text.split('\n').map((line, i) => `<tspan x="${e.x}" y="${e.y + i * e.fontSize * 1.25}">${escape(line)}</tspan>`).join('')}</text>`;
    return `<polyline points="${e.points.map(([x, y]) => `${e.x + x},${e.y + y}`).join(' ')}" fill="none" stroke="${e.strokeColor}" stroke-width="${e.strokeWidth}" stroke-linejoin="round"${e.type === 'arrow' ? ` marker-end="url(#arrow-${e.strokeColor.slice(1)})"` : ''}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width + padding * 2}" height="${size.height + padding * 2}" viewBox="0 0 ${size.width + padding * 2} ${size.height + padding * 2}"><rect width="100%" height="100%" fill="#ffffff"/><defs>${markers}</defs>${content}</svg>`;
}

module.exports = { splitPainting, withoutPainting, paintingSize, paintElements, diagramSvg, MAX_SHAPES };
