import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteKeepingFlow } from '../lib/canvas-delete-flow.ts';

const node = id => ({ id, type: 'agent', position: { x: 0, y: 0 }, data: {} });
const edge = (source, target, extra = {}) => ({ id: `${source}->${target}`, source, target, ...extra });
const graph = (edges, names = ['a', 'b', 'c', 'd']) => ({ name: 'Flow', nodes: names.map(node), edges });
const has = (graph, a, b) => graph.edges.find(e => e.source === a && e.target === b);

test('contracts multiple removed wait agents and keeps the downstream label', () => {
  const before = graph([edge('a', 'b', { label: 'Earlier' }), edge('b', 'c'), edge('c', 'd', { label: 'Result' })]);
  const result = deleteKeepingFlow(before, ['b', 'c']);
  assert.deepEqual(result.graph.edges, [edge('a', 'd', { label: 'Result' })]);
  assert.equal(result.keptLinks, 1);
  assert.equal(before.nodes.length, 4);
  assert.equal(before.edges.length, 3, 'Undo retains the untouched previous graph');
});

test('all link kinds carry through a chain, including reversed alongside endpoints', () => {
  const before = graph([edge('b', 'a', { kind: 'alongside' }), edge('b', 'c', { feedback: true }), edge('c', 'd')]);
  const result = deleteKeepingFlow(before, ['b', 'c']);
  assert.equal(has(result.graph, 'a', 'd').kind, 'alongside');
  assert.equal(has(result.graph, 'a', 'd').feedback, true);
  assert.equal(result.graph.edges.length, 1);
});

test('alongside links are undirected and a contracted pair occurs only once', () => {
  const result = deleteKeepingFlow(graph([edge('b', 'a', { kind: 'alongside' }), edge('c', 'b', { kind: 'alongside' })], ['a', 'b', 'c']), ['b']);
  assert.equal(result.graph.edges.length, 1);
  assert.equal(result.graph.edges[0].kind, 'alongside');
});

test('duplicate paths and existing endpoint pairs do not add duplicate links', () => {
  const before = graph([edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'd', { label: 'Keep me' })]);
  const result = deleteKeepingFlow(before, ['b', 'c']);
  assert.deepEqual(result.graph.edges, [edge('a', 'd', { label: 'Keep me' })]);
  assert.equal(result.keptLinks, 0);
});

test('a feedback route to the source never creates a self-link or a new cycle', () => {
  const before = graph([edge('a', 'b'), edge('b', 'a', { feedback: true }), edge('b', 'c'), edge('c', 'a')]);
  const result = deleteKeepingFlow(before, ['b']);
  assert.deepEqual(result.graph.edges, [edge('c', 'a')]);
  assert.ok(!result.graph.edges.some(e => e.source === e.target));
});

test('a cycle wholly among removed agents terminates and reconnects each surviving exit', () => {
  const result = deleteKeepingFlow(graph([edge('a', 'b'), edge('b', 'c'), edge('c', 'b', { feedback: true }), edge('c', 'd')]), ['b', 'c']);
  assert.equal(result.graph.nodes.length, 2);
  assert.equal(result.graph.edges.length, 1);
  assert.ok(has(result.graph, 'a', 'd'));
});

test('Mother remains protected and new dotted links count while existing roots do not', () => {
  const before = graph([edge('a', 'b'), edge('a', 'c')]);
  before.nodes.unshift({ id: '__mother__', type: 'mother', position: { x: 0, y: 0 }, data: {} });
  const result = deleteKeepingFlow(before, ['a', '__mother__']);
  assert.equal(result.keptLinks, 2);
  assert.equal(result.graph.edges.length, 0);
  assert.ok(result.graph.nodes.some(n => n.type === 'mother'));
});

test('deleting a note or no valid node leaves unrelated links intact', () => {
  const before = graph([edge('a', 'b')]);
  before.nodes.push({ id: 'note', type: 'note', position: { x: 0, y: 0 }, data: { text: 'Note' } });
  const result = deleteKeepingFlow(before, ['note']);
  assert.deepEqual(result.graph.edges, before.edges);
  assert.equal(result.keptLinks, 0);
  assert.deepEqual(deleteKeepingFlow(before, ['missing']).graph, before);
});
