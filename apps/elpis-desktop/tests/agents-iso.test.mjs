// The isometric view of the agents canvas (components/agents-iso.tsx): its projection, run-order layout, wire routes
// and fit, which are pure (lib/iso.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ISO_STEP, isoFit, isoLayout, isoRoute, project } from '../lib/iso.ts';

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);
const node = (id, type, y = 0) => ({ id, type, position: { x: 0, y }, data: {} });
// Split by parts as the canvas holds it: the Mother, three parts (wave 1, out of order in the list), a join (wave 2)
// and a sticky note.
const graph = { nodes: [node('mother', 'mother'), node('p2', 'agent', 120), node('p1', 'agent', 0), node('p3', 'agent', 240), node('join', 'agent', 60), node('n', 'note')] };
const waves = new Map([['p1', 1], ['p2', 1], ['p3', 1], ['join', 2]]);

test('the projection is isometric: both ground axes run 30° off the horizontal, unshortened, and height lifts straight up', () => {
  assert.deepEqual(project(0, 0), { x: 0, y: 0 });
  const along = project(100, 0), across = project(0, 100);
  assert.ok(along.x > 0 && along.y > 0, 'the waves run right and down');
  assert.ok(across.x < 0 && across.y > 0, 'the rows of a wave run left and down');
  close(along.y / along.x, Math.tan(Math.PI / 6), 'wave axis angle');
  close(across.y / -across.x, Math.tan(Math.PI / 6), 'row axis angle');
  close(Math.hypot(along.x, along.y), 100, 'wave axis length');
  close(Math.hypot(across.x, across.y), 100, 'row axis length');
  const lifted = project(30, 40, 50), ground = project(30, 40);
  close(lifted.x, ground.x, 'height keeps x'); close(lifted.y, ground.y - 50, 'height lifts y');
});

test('the layout: the Mother in column 0, each agent in its wave column, a wave in the flat board\'s top-to-bottom order, centred; notes left out', () => {
  const places = isoLayout(graph, waves);
  assert.deepEqual(places.map(place => [place.id, place.kind, place.column, place.row]), [['mother', 'mother', 0, 0], ['p1', 'agent', 1, -1], ['p2', 'agent', 1, 0], ['p3', 'agent', 1, 1], ['join', 'agent', 2, 0]]);
  for (const place of places) assert.deepEqual(place.at, project(place.column * ISO_STEP.column, place.row * ISO_STEP.row), `${place.id} is its ground point, projected`);
  // Each later wave sits further right and further down; no two agents share a spot.
  const middle = id => places.find(place => place.id === id).at;
  assert.ok(middle('mother').x < middle('p2').x && middle('p2').x < middle('join').x);
  assert.equal(new Set(places.map(place => `${place.at.x},${place.at.y}`)).size, places.length);
});

test('an agent on a loop (no wave) stands in a column after the last wave, never on the Mother', () => {
  const places = isoLayout({ nodes: [...graph.nodes, node('stray', 'agent')] }, waves);
  assert.deepEqual(places.filter(place => place.id === 'stray').map(place => [place.column, place.row]), [[3, 0]]);
  assert.deepEqual(isoLayout({ nodes: [node('mother', 'mother')] }, new Map()).map(place => place.id), ['mother']);
});

test('a wire runs along the ground axes: along the waves, across them halfway to the next column, then on into its agent', () => {
  const from = { u: 0, v: -ISO_STEP.row }, to = { u: 2 * ISO_STEP.column, v: ISO_STEP.row };
  const route = isoRoute(from, to);
  assert.deepEqual(route[0], from); assert.deepEqual(route.at(-1), to);
  for (let index = 1; index < route.length; index++) assert.ok(route[index].u === route[index - 1].u || route[index].v === route[index - 1].v, `segment ${index} runs along one axis`);
  assert.equal(route[1].u, ISO_STEP.column / 2, 'it turns halfway to the next column');
  assert.deepEqual(isoRoute({ u: 0, v: 0 }, { u: ISO_STEP.column, v: 0 }), [{ u: 0, v: 0 }, { u: ISO_STEP.column, v: 0 }], 'a wire along one row is straight');
});

test('fit: the whole layout inside the board\'s insets, centred, filling one side, never past the largest zoom', () => {
  const content = { left: -100, top: -50, right: 500, bottom: 300 }, view = { width: 600, height: 400 }, inset = { left: 60, top: 50, right: 60, bottom: 60 };
  const { zoom, x, y } = isoFit(content, view, inset);
  const left = x + zoom * content.left, right = x + zoom * content.right, top = y + zoom * content.top, bottom = y + zoom * content.bottom;
  assert.ok(left >= inset.left - 1e-9 && right <= view.width - inset.right + 1e-9 && top >= inset.top - 1e-9 && bottom <= view.height - inset.bottom + 1e-9, 'inside the insets');
  close(left - inset.left, view.width - inset.right - right, 'centred across');
  close(top - inset.top, view.height - inset.bottom - bottom, 'centred down');
  assert.ok(Math.abs(right - left - (view.width - inset.left - inset.right)) < 1e-9 || Math.abs(bottom - top - (view.height - inset.top - inset.bottom)) < 1e-9, 'it fills one side');
  assert.equal(isoFit({ left: 0, top: 0, right: 10, bottom: 10 }, view, inset, { min: 0.3, max: 1.2 }).zoom, 1.2, 'a small graph is not blown up past the largest zoom');
  assert.equal(isoFit(content, { width: 100, height: 100 }, inset, { min: 0.3, max: 1.2 }).zoom, 0.3, 'nor shrunk past the smallest');
});
