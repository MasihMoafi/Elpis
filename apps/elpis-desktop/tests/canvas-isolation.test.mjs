// Worktree isolation on the agents canvas (lib/canvas-isolation.ts): when a run asks for it, and how the engine's merge
// conflicts are read. The conflict texts below are the engine's own (codex-rs core/src/tools/handlers/work_graph_worktrees.rs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStops, runPayload, stopText } from '../lib/canvas-isolation.ts';

const task = (id, kind, extra = {}) => ({ id, kind, title: id, instruction: id, dependsOn: [], writeScopes: [], acceptanceCriteria: [], ...extra });
const two = [task('a', 'implement'), task('a-check', 'verify'), task('b', 'implement'), task('b-check', 'verify')];
const one = [task('a', 'implement'), task('a-check', 'verify')];
const KEPT = 'Kept for inspection: /p/demo-elpis/g1/a (branch elpis/g1/a), /p/demo-elpis/g1/b (branch elpis/g1/b).';

test('a run carries isolation "worktree" only in a git repository and with more than one writing agent', () => {
  assert.deepEqual(runPayload('root', 'Team', two, 3, true), { rootThreadId: 'root', name: 'Team', tasks: two, maxConcurrency: 3, isolation: 'worktree' });
  // Not a repository (or not known to be one): the engine would refuse the run, so isolation is left out.
  assert.deepEqual(runPayload('root', 'Team', two, 3, false), { rootThreadId: 'root', name: 'Team', tasks: two, maxConcurrency: 3 });
  // One writer has no one to clash with; the checks are not writers.
  assert.equal('isolation' in runPayload('root', 'Team', one, 3, true), false);
});

test('a clash at the end of the run names the agent whose result clashed, the branch and the files', () => {
  const error = `Not merged: elpis/g1/b clashes with main in src/app.ts, README.md; main is untouched. ${KEPT}`;
  const [stop, ...rest] = mergeStops({ id: 'g1', error, tasks: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(rest, []);
  assert.deepEqual(stop, { kind: 'clash', agent: 'b', files: ['src/app.ts', 'README.md'], into: 'main', kept: KEPT });
  assert.equal(stopText(stop, 'Part 2'), `Merge stopped: “Part 2” clashes with main in src/app.ts, README.md. main is untouched. ${KEPT}`);
});

test('a clash between the work an agent builds on stops that agent, with the clashing files', () => {
  const reason = 'task `c` builds on elpis/g1/a and elpis/g1/b, whose results clash in: src/shared.ts, src/util.ts; the conflicted worktree is kept at /p/demo-elpis/g1/c (branch elpis/g1/c)';
  const error = `one or more work graph tasks failed or were blocked. Not built: ${reason}. Kept worktrees with work: /p/demo-elpis/g1/a (branch elpis/g1/a).`;
  const stops = mergeStops({ id: 'g1', error, tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c', failureReason: reason }, { id: 'c-check', failureReason: 'blocked by c' }] });
  assert.deepEqual(stops, [{ kind: 'clash', agent: 'c', files: ['src/shared.ts', 'src/util.ts'], into: null, kept: 'Kept worktrees with work: /p/demo-elpis/g1/a (branch elpis/g1/a).' }]);
  assert.equal(stopText(stops[0], 'Join'), 'Merge stopped: the work “Join” builds on clashes in src/shared.ts, src/util.ts. Your branch is untouched. Kept worktrees with work: /p/demo-elpis/g1/a (branch elpis/g1/a).');
});

test('uncommitted changes in the project that the merge would change stop it too, naming no agent', () => {
  const error = `Not merged: /p/demo has uncommitted changes in files the merge would change: src/app.ts; nothing was merged. ${KEPT}`;
  const stops = mergeStops({ id: 'g1', error, tasks: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(stops, [{ kind: 'blocked', agent: null, files: ['src/app.ts'], into: null, kept: KEPT }]);
  assert.equal(stopText(stops[0], ''), `Merge stopped: your project has uncommitted changes in src/app.ts, which the merge would change. Nothing was merged. ${KEPT}`);
});

test('a long list of files is shortened in the sentence, and a graph without a merge stop reads as none', () => {
  const files = Array.from({ length: 12 }, (_, index) => `f${index}.ts`);
  const [stop] = mergeStops({ id: 'g1', error: `Not merged: elpis/g1/a clashes with main in ${files.join(', ')}; main is untouched.`, tasks: [] });
  assert.deepEqual([stop.files.length, stop.kept], [12, null]);
  assert.match(stopText(stop, 'A'), /in f0\.ts, f1\.ts, f2\.ts, f3\.ts, f4\.ts, f5\.ts, f6\.ts, f7\.ts and 4 more\. main is untouched\.$/);
  for (const graph of [{ id: 'g1', tasks: [] }, { id: 'g1', error: null, tasks: [{ id: 'a', failureReason: null }] }, { id: 'g1', error: 'one or more work graph tasks failed or were blocked. No worktree was created.', tasks: [{ id: 'a', failureReason: 'the model stopped' }] }]) assert.deepEqual(mergeStops(graph), []);
});
