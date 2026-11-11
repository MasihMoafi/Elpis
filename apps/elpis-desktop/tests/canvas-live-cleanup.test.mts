import test from 'node:test';
import assert from 'node:assert/strict';
import { runChats, withoutRunTrust } from './canvas-live-cleanup.mts';

const project = '/tmp/cl-AbC123/project';

test('the live run archives every chat in its project or worktrees, and no other chat', () => {
  // 11 Nov: the agents were archived, but the Mother's and the checks' chats were left in his sidebar.
  const threads = [
    { id: 'mother', cwd: project },
    { id: 'agent', cwd: `${project}-elpis/workflows/407a/agent-1q-r1` },
    { id: 'check', cwd: `${project}-elpis/workflows/407a/agent-1q-check-r1` },
    { id: 'nested', cwd: `${project}/tally` },
    { id: 'his', cwd: '/home/masih/Desktop/p/Elpis' },
    { id: 'sibling', cwd: `${project}2` },
    { id: 'other-run', cwd: '/tmp/cl-ZZZ999/project' },
    { id: 'no-folder' },
  ];
  assert.deepEqual(runChats(threads, project), ['mother', 'agent', 'check', 'nested']);
});

test("the run's trusted-project entry is removed by its exact key and every other line stays", () => {
  const before = [
    'model = "gpt-6-luna"',
    '',
    '[projects."/home/masih/Desktop/p"]',
    'trust_level = "trusted"',
    '',
    `[projects.${JSON.stringify(project)}]`,
    'trust_level = "trusted"',
    '',
    `[projects.${JSON.stringify(`${project}-elpis/workflows/407a/agent-1q-r1`)}]`,
    'trust_level = "trusted"',
    '',
    `[projects.${JSON.stringify(`${project}2`)}]`,
    'trust_level = "trusted"',
    '',
    '[tui]',
    'theme = "dark"',
    '',
  ].join('\n');
  const { text, removed } = withoutRunTrust(before, project);
  assert.deepEqual(removed, [project, `${project}-elpis/workflows/407a/agent-1q-r1`]);
  assert.equal(
    text,
    [
      'model = "gpt-6-luna"',
      '',
      '[projects."/home/masih/Desktop/p"]',
      'trust_level = "trusted"',
      '',
      `[projects.${JSON.stringify(`${project}2`)}]`,
      'trust_level = "trusted"',
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n'),
  );
  // Nothing of the run's: the file is returned unchanged.
  const untouched = before.replace(/cl-AbC123/g, 'cl-Other1');
  assert.deepEqual(withoutRunTrust(untouched, project), { text: untouched, removed: [] });
});
