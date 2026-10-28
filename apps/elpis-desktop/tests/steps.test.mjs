// How the chat words agent work, copied from Claude's desktop app (its ion-dist source): a running step is the
// model's own sentence when the item gives one, the timer reads "39s" / "1m 2s" / "1h 2m 3s", and a finished group
// is "verb + what" phrases in the order the work began ("Edited and read app.ts, used rag, ran 2 commands (1 failed)").
import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsed, stepDuration, stepLabel, summarize, unwrapShell } from '../lib/steps.ts';

const command = (id, extra = {}) => ({ id, type: 'commandExecution', command: `run ${id}`, status: 'completed', exitCode: 0, commandActions: [{ type: 'unknown', command: `run ${id}` }], ...extra });
const read = (id, path) => command(id, { commandActions: [{ type: 'read', command: `sed ${path}`, name: path.split('/').at(-1), path }] });
const search = id => command(id, { commandActions: [{ type: 'search', command: 'rg x', query: 'x', path: null }] });
const list = id => command(id, { commandActions: [{ type: 'listFiles', command: 'ls', path: 'src' }] });
const change = (id, ...changes) => ({ id, type: 'fileChange', status: 'completed', changes: changes.map(([kind, path]) => ({ path, kind: { type: kind }, diff: '' })) });
const failed = item => ({ ...item, status: 'failed', exitCode: 1 });

test('a command with a description reads as that sentence, running or done; without one it keeps its gist', () => {
  const said = command('d', { command: "/bin/bash -lc 'pkill -f dev && git worktree move a b'", description: 'Stopping local site and moving worktree' });
  assert.equal(stepLabel({ ...said, status: 'inProgress' }), 'Stopping local site and moving worktree');
  assert.equal(stepLabel(said), 'Stopping local site and moving worktree', 'the same sentence once it is done');
  assert.equal(stepLabel(command('m', { description: '  First line.\nSecond line.  ' })), 'First line.');
  assert.equal(stepLabel(command('e', { description: '   ', command: 'npm test' }), true), 'Running npm test', 'a blank description is no description');
  assert.equal(stepLabel(command('f', { command: 'npm test' }), false), 'Ran npm test');
});

// 28 Oct: a running step read "Running /usr/bin/python3 -B …/agent-resource-guard/guard.py run --…" instead of its command.
test('a command run through the disk guard reads and shows as the command itself', () => {
  const guard = "/usr/bin/python3 -B /home/user/.local/lib/agent-resource-guard/guard.py run -- ";
  assert.equal(unwrapShell(guard + "'sleep 60'"), 'sleep 60');
  assert.equal(unwrapShell(guard + `'/bin/bash -lc '"'"'cd /tmp && ls'"'"''`), 'cd /tmp && ls', 'a wrapped shell inside the guard unwraps too');
  assert.equal(unwrapShell(guard + 'npm test'), 'npm test');
  assert.equal(unwrapShell('python3 guard.py run -- npm test'), 'python3 guard.py run -- npm test', 'another guard.py is left as written');
  const running = command('g', { command: guard + "'npm test'", commandActions: [{ type: 'unknown', command: 'npm test' }], status: 'inProgress' });
  assert.equal(stepLabel(running), 'Running npm test');
});

test('edits are worded by what they did to which file', () => {
  assert.equal(stepLabel(change('a', ['update', 'src/app.ts']), true), 'Editing app.ts');
  assert.equal(stepLabel(change('a', ['update', 'src/app.ts'])), 'Edited app.ts');
  assert.equal(stepLabel(change('b', ['add', '/tmp/x/new.md']), true), 'Creating new.md');
  assert.equal(stepLabel(change('b', ['add', '/tmp/x/new.md'])), 'Created new.md');
  assert.equal(stepLabel(change('c', ['delete', 'old.txt'])), 'Deleted old.txt');
  assert.equal(stepLabel(change('d', ['update', 'a.ts'], ['update', 'b.ts'], ['update', 'a.ts']), true), 'Editing 2 files');
});

test('the timer reads as Claude does: seconds, then minutes and seconds, then hours', () => {
  assert.deepEqual([0, 999, 1000, 39_400, 59_999, 60_000, 62_000, 3_599_000, 3_723_000].map(elapsed),
    ['0s', '0s', '1s', '39s', '59s', '1m 0s', '1m 2s', '59m 59s', '1h 2m 3s']);
});

test('a finished group lists what was done in the order it began, with counts', () => {
  assert.equal(summarize([command('1')]), 'Ran a command');
  assert.equal(summarize([command('1'), command('2'), command('3')]), 'Ran 3 commands');
  assert.equal(summarize([command('1'), change('2', ['update', 'a.ts']), command('3'), change('4', ['update', 'b.ts'])]), 'Ran 2 commands, edited 2 files');
  assert.equal(summarize([change('1', ['add', 'a.ts']), change('2', ['update', 'b.ts']), change('3', ['delete', 'c.ts'])]), 'Created a file, edited a file, deleted a file');
  assert.equal(summarize([read('1', '/p/a.ts'), read('2', '/p/b.ts'), read('3', '/p/a.ts')]), 'Read 2 files', 'two files are counted, not named; the same file twice is one');
  assert.equal(summarize([search('1'), search('2'), list('3'), { id: 'w', type: 'webSearch', query: 'q', status: 'completed' }]), 'Searched code, listed files, browsed the web');
  assert.equal(summarize([{ id: 'm', type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed' }, command('1')]), 'Used rag, ran a command');
});

test('one file read and then edited is one phrase that names it', () => {
  assert.equal(summarize([read('1', '/p/src/app.ts')]), 'Read app.ts');
  assert.equal(summarize([change('1', ['update', 'src/app.ts']), command('2'), read('3', '/p/src/app.ts')]), 'Edited and read app.ts, ran a command', 'relative and absolute paths are one file');
  assert.equal(summarize([read('1', '/p/src/app.ts'), change('2', ['update', 'src/app.ts']), change('3', ['delete', 'src/app.ts'])]), 'Read, edited, and deleted app.ts');
  assert.equal(summarize([read('1', '/p/src/app.ts'), change('2', ['update', 'src/other.ts'])]), 'Read a file, edited a file', 'two files: no names');
  assert.equal(summarize([read('1', '/p/src/app.ts'), read('2', '/p/lib/app.ts')]), 'Read 2 files', 'the same name in two folders is two files');
});

test('failures are counted on the phrase they belong to', () => {
  assert.equal(summarize([command('1'), failed(command('2'))]), 'Ran 2 commands (1 failed)');
  assert.equal(summarize([failed(command('1')), change('2', ['update', 'a.ts'])]), 'Ran a command (1 failed), edited a.ts');
  assert.equal(summarize([change('1', ['update', 'a.ts']), command('2'), failed(command('3')), failed(command('4'))]), 'Edited a.ts, ran 3 commands (2 failed)');
  assert.equal(summarize([change('1', ['update', 'a.ts']), failed(search('2'))]), 'Edited a.ts, searched code (1 failed)');
  assert.equal(summarize([change('1', ['update', 'a.ts']), { ...change('2', ['update', 'b.ts']), status: 'failed' }, command('3')]), 'Edited 2 files (1 failed), ran a command');
});

test('a group of one step with a description reads as that sentence', () => {
  assert.equal(summarize([command('1', { description: 'Listed everything created outside the legal folder' })]), 'Listed everything created outside the legal folder');
  assert.equal(summarize([command('1', { description: 'Moving the build aside' }), command('2')]), 'Ran 2 commands', 'two steps are counted');
  assert.equal(summarize([failed(command('1', { description: 'Running the tests' }))]), 'Running the tests (1 failed)');
});

test('a finished step\'s duration is drawn from a tenth of a second: 0.8s, 9.0s, then 12s and 1m 2s; a 30 ms step has none', () => {
  assert.equal(stepDuration(30), '', 'not "0.0s"');
  assert.equal(stepDuration(99), '');
  assert.equal(stepDuration(100), '0.1s');
  assert.equal(stepDuration(800), '0.8s');
  assert.equal(stepDuration(9000), '9.0s');
  assert.equal(stepDuration(12400), '12s');
  assert.equal(stepDuration(62000), '1m 2s');
  assert.equal(stepDuration(undefined), '', 'a step that never reported its time');
  assert.equal(stepDuration(null), '');
});
