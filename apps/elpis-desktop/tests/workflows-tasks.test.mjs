import test from 'node:test';
import assert from 'node:assert/strict';
import { graphToTasks } from '../lib/workflows.ts';

const pet = (id, editsFiles = false) => ({ id, type: 'pet', position: { x: 0, y: 0 }, data: { character: 'builder', title: id, instruction: `Role ${id}`, model: 'luna', provider: 'openai', editsFiles } });
const wire = (source, target) => ({ id: `${source}-${target}`, source, target });

test('text pets receive the exact task and incoming results; writers have isolated folders and direct checks', () => {
  const tasks = graphToTasks({ nodes: [pet('research'), pet('build', true), pet('review')], edges: [wire('research', 'build'), wire('build', 'review')] }, 'Make a plan');
  assert.deepEqual(tasks.map(t => [t.id, t.kind, t.dependsOn]), [
    ['research', 'explore', []], ['build', 'implement', ['research']], ['build-check', 'verify', ['build']], ['review', 'explore', ['build', 'build-check']],
  ]);
  // The first pet is told it goes first; a later one is told whose results it receives (23 Oct: a first pet once waited for input).
  assert.equal(tasks[0].instruction, "You are research, one agent of a team.\n\nRole research\n\nThe team's task: Make a plan\n\nYou go first: nobody hands you anything. Do only your own part of the task now.\n\nReply with your result.");
  assert.match(tasks[3].instruction, /You receive the results of build; they are given to you with this task\./);
  assert.deepEqual(tasks[0].writeScopes, []);
  assert.deepEqual(tasks[0].acceptanceCriteria, []);
  assert.deepEqual(tasks[1].writeScopes, ['team/build']);
  assert.deepEqual(tasks[2].writeScopes, ['team/build/check']);
  assert.ok(tasks[1].acceptanceCriteria.length && tasks[2].acceptanceCriteria.length);
  assert.equal(tasks[1].model, 'luna');
  assert.equal(tasks[1].provider, 'openai');
  const duplicate = graphToTasks({ nodes: [pet('one', true), { ...pet('two', true), data: { ...pet('two', true).data, title: 'one' } }], edges: [] }, 'Build');
  assert.deepEqual(duplicate.filter(t => t.kind === 'implement').map(t => t.writeScopes), [['team/one'], ['team/one-2']]);
});

test('invalid teams cannot reach the engine: empty task/team, loop, dangling edge, missing role and colliding check id', () => {
  for (const [graph, task, reason] of [
    [{ nodes: [], edges: [] }, 'Task', /Add a pet/],
    [{ nodes: [pet('a')], edges: [] }, ' ', /Give the team/],
    [{ nodes: [pet('a'), pet('b')], edges: [wire('a', 'b'), wire('b', 'a')] }, 'Task', /loop/i],
    [{ nodes: [pet('a')], edges: [wire('gone', 'a')] }, 'Task', /missing/i],
    [{ nodes: [{ ...pet('a'), data: { ...pet('a').data, instruction: '' } }], edges: [] }, 'Task', /role prompt/i],
    [{ nodes: [{ ...pet('a'), data: { ...pet('a').data, model: null } }], edges: [] }, 'Task', /model/i],
    [{ nodes: [pet('a', true), pet('a-check')], edges: [] }, 'Task', /id/i],
  ]) assert.throws(() => graphToTasks(graph, task), reason);
});
