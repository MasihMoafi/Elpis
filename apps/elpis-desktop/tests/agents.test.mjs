import test from 'node:test';
import assert from 'node:assert/strict';
import { agentState, attentionLine, mergeListedThreads, stateLabels } from '../lib/agents.ts';

test('native waiting flags and pending requests take priority over Working', () => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) assert.equal(agentState({ id: 'child', status: { type: 'active', activeFlags: [flag] } }), 'waiting');
  assert.equal(agentState({ id: 'child', status: { type: 'idle' } }, new Set(['child'])), 'waiting');
  assert.equal(agentState({ id: 'other', status: { type: 'active' } }, new Set(['child'])), 'working');
  assert.equal(agentState({ id: 'child', status: { type: 'idle' } }), 'idle');
  assert.equal(agentState({ id: 'child', status: { type: 'systemError' } }), 'error');
  assert.equal(agentState({ id: 'child' }), 'unknown');
});

test('head refresh keeps older loaded conversations and updates existing child status without duplicates', () => {
  const current = [{ id: 'new' }, { id: 'older' }, { id: 'child', parentThreadId: 'new', status: { type: 'active' } }];
  const result = mergeListedThreads(current, [{ id: 'new', name: 'Renamed' }, { id: 'child', parentThreadId: 'new', status: { type: 'idle' } }], new Set(), true);
  assert.deepEqual(result.map(t => t.id), ['new', 'child', 'older']);
  assert.equal(result[1].status.type, 'idle');
});

test('later pages remain through a first-page refresh and deleted rows never reappear', () => {
  let rows = mergeListedThreads([{ id: 'parent' }, { id: 'gpt-a', parentThreadId: 'parent' }], [{ id: 'gpt-a', parentThreadId: 'parent' }, { id: 'agy', parentThreadId: 'parent' }]);
  rows = mergeListedThreads(rows, [{ id: 'gpt-a', parentThreadId: 'parent', model: 'gpt-6-luna' }]);
  assert.deepEqual(rows.map(t => t.id), ['parent', 'gpt-a', 'agy']);
  assert.deepEqual(mergeListedThreads(rows, [{ id: 'agy' }], new Set(['agy'])).map(t => t.id), ['parent', 'gpt-a']);
});

test('an unread reply shows only when nothing more urgent does, as in Claude', () => {
  const unread = new Set(['a']);
  assert.equal(agentState({ id: 'a', status: { type: 'idle' } }, new Set(), unread), 'unread');
  assert.equal(agentState({ id: 'a', status: { type: 'notLoaded' } }, new Set(), unread), 'unread');
  assert.equal(agentState({ id: 'a', status: { type: 'active' } }, new Set(), unread), 'working');
  assert.equal(agentState({ id: 'a', status: { type: 'idle' } }, new Set(['a']), unread), 'waiting');
  assert.equal(agentState({ id: 'a', status: { type: 'systemError' } }, new Set(), unread), 'error');
  assert.equal(stateLabels.unread, 'Unread response');
});

test('the line under a waiting chat says why, in Claude’s words', () => {
  const approval = (method, params = {}) => ({ id: 'x', ownerThreadId: 'a', method, params: { threadId: 'a', ...params } });
  assert.equal(attentionLine(approval('item/commandExecution/requestApproval', { command: 'npm   test' }), false), 'Needs your approval · npm test');
  const long = `rg ${'x'.repeat(80)}`;
  assert.equal(attentionLine(approval('item/commandExecution/requestApproval', { command: long }), false), `Needs your approval · ${long.slice(0, 59)}…`);
  assert.equal(attentionLine(approval('item/fileChange/requestApproval'), false), 'Needs your approval · Edit');
  assert.equal(attentionLine(approval('mcpServer/elicitation/request', { serverName: 'rag', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'search' } }), false), 'Needs your approval · rag: search');
  assert.equal(attentionLine(approval('item/tool/requestUserInput', { questions: [{ id: 'q', header: 'Pick', question: 'Which?' }] }), true), 'Waiting for your answer');
  assert.equal(attentionLine(approval('item/permissions/requestApproval'), false), 'Awaiting input');
  assert.equal(attentionLine(undefined, true), 'Plan ready for review');
  assert.equal(attentionLine(undefined, false), null);
});
