import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { CanvasEdge, CanvasGraph, CanvasNode } from '../lib/canvas.ts';

type Agent = Extract<CanvasNode, { type: 'agent' }>;
type TestGraph = Omit<CanvasGraph, 'nodes'> & { nodes: Agent[] };

// Resolve the app's existing extensionless TS imports and @ alias under Node, without a build.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('./') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { executionGraph, linkedIds, runParts, runTasks } = await import('../lib/canvas.ts');
const { extractAgent, insidePolygon, insertAgent, segmentsCross } = await import('../lib/canvas-editing.ts');
const edge = (source: string, target: string, extra: Partial<CanvasEdge> = {}): CanvasEdge => ({ id: `${source}->${target}`, source, target, ...extra });
const board = (): TestGraph => ({ name: 'Editing', nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, type: 'agent', position: { x: i * 260, y: 0 },
  data: { title: id, instruction: `Write ${id}`, model: null, writeScopes: ['src'], acceptanceCriteria: [] } })), edges: [edge('a', 'b'), edge('b', 'c', { label: 'Result' })] });
const tasks = (graph: CanvasGraph) => { const result = runTasks(graph); assert.ok('tasks' in result); return result.tasks; };
const taskError = (graph: CanvasGraph) => { const result = runTasks(graph); assert.ok('error' in result); return result.error; };
const parts = (graph: CanvasGraph) => { const result = runParts(graph); assert.ok('mother' in result); return result; };

test('execution omits muted writers and checks, preserves required dependencies, and never mutates the saved drawing', () => {
  const graph = board(), muted = graph.nodes[1]; assert.ok(muted); muted.data.muted = true;
  const before = structuredClone(graph), built = runTasks(graph);
  assert.ok(!('error' in built)); assert.deepEqual(built.tasks.map(task => task.id), ['a', 'a-check', 'c', 'c-check', 'd', 'd-check']);
  const dependency = built.tasks.find(task => task.id === 'c'); assert.ok(dependency); assert.deepEqual(dependency.dependsOn, ['a', 'a-check']);
  const instruction = built.tasks.find(task => task.id === 'c'); assert.ok(instruction); assert.match(instruction.instruction, /Receives “Result” from a/);
  assert.deepEqual(graph, before);
  graph.nodes.forEach(node => { node.data.muted = true; }); assert.match(taskError(graph), /Add an agent/);
});

test('selection execution includes recursive ancestors only, ignores alongside links and rejects empty or muted targets', () => {
  const graph = board(); graph.edges.push(edge('b', 'd', { kind: 'alongside' }));
  assert.deepEqual(tasks(executionGraph(graph, ['b'])).map(task => task.id), ['a', 'a-check', 'b', 'b-check']);
  assert.deepEqual(tasks(executionGraph(graph, ['c'])).map(task => task.id), ['a', 'a-check', 'b', 'b-check', 'c', 'c-check']);
  assert.match(taskError(executionGraph(graph, [])), /Add an agent/);
  const muted = graph.nodes[1]; assert.ok(muted); muted.data.muted = true; assert.match(taskError(executionGraph(graph, ['b'])), /Add an agent/);
  const many = board(), first = many.nodes[0]; assert.ok(first); many.nodes = Array.from({ length: 12 }, (_, i) => ({ ...first, id: `a${i}`, data: { ...first.data, title: `Agent ${i}`, muted: i < 3 } })); many.edges = []; many.maxAgents = 20;
  assert.equal(parts(many).mother.length, 18); assert.equal(parts(many).father.length, 0, 'parent capacity counts enabled agents');
});

test('linked selection walks branches and feedback cycles once without crossing alongside wires', () => {
  const graph = board(); graph.edges.push(edge('c', 'a', { feedback: true }), edge('b', 'd', { kind: 'alongside' }));
  assert.deepEqual(linkedIds(graph, ['b'], 'upstream').sort(), ['a', 'b', 'c']);
  assert.deepEqual(linkedIds(graph, ['b'], 'downstream').sort(), ['a', 'b', 'c']);
  assert.deepEqual(linkedIds(graph, ['d'], 'upstream'), ['d']);
});

test('insertion replaces one ordinary wire atomically and preserves its receiving label, refusing connected or incompatible agents', () => {
  const graph = board(), original = structuredClone(graph), selected = graph.edges[1]; assert.ok(selected); const result = insertAgent(graph, 'd', selected); assert.ok(result);
  assert.deepEqual(result.edges, [edge('a', 'b'), edge('b', 'd'), edge('d', 'c', { label: 'Result' })]); assert.deepEqual(graph, original);
  for (const id of ['a', 'b', 'c', 'missing']) assert.equal(insertAgent(graph, id, selected), null);
  for (const extra of [{ kind: 'alongside' }, { feedback: true }] as Partial<CanvasEdge>[]) assert.equal(insertAgent(graph, 'd', { ...selected, ...extra }), null);
});

test('extraction heals one ordinary gap, keeps the node and receiving label, refuses branches and feedback', () => {
  const graph = board(), result = extractAgent(graph, 'b'); assert.ok(result);
  assert.deepEqual(result.edges, [edge('a', 'c', { label: 'Result' })]); assert.deepEqual(result.nodes, graph.nodes); assert.equal(graph.edges.length, 2);
  for (const extra of [edge('b', 'd'), edge('d', 'b'), edge('b', 'd', { kind: 'alongside' }), edge('c', 'b', { feedback: true })]) assert.equal(extractAgent({ ...graph, edges: [...graph.edges, extra] }, 'b'), null);
  assert.equal(extractAgent(graph, 'd'), null);
});

test('freehand selection follows a concave polygon rather than its bounding rectangle; cutting detects actual intersections', () => {
  const polygon = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 100 }, { x: 0, y: 100 }];
  assert.equal(insidePolygon({ x: 10, y: 80 }, polygon), true); assert.equal(insidePolygon({ x: 80, y: 80 }, polygon), false);
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }), true);
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }), true);
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }), false);
});
