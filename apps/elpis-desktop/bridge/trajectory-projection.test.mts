import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from './trajectory-projection.mts';

const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
const usage = (input: number, cached: number, output: number) => ({ usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output } });
const t = (time: string, type: string, payload: unknown) => line(`2026-11-05T${time}Z`, type, payload);
const rollout = () => [
  t('10:00:00.000', 'session_meta', { id: 'thread-1', cwd: '/w', model_provider: 'openai', base_instructions: { text: 'You are Elpis.' } }),
  t('10:00:00.000', 'turn_context', { model: 'gpt-6.1-terra' }),
  t('10:00:00.000', 'world_state', { full: true, state: { agents_md: {} } }),
  t('10:00:00.000', 'event_msg', { type: 'task_started', started_at: 1793872800, model_context_window: 400000 }),
  t('10:00:00.100', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w\n\nrules' }] }),
  t('10:00:00.200', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] }),
  t('10:00:01.000', 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'call-1' }),
  t('10:00:02.000', 'token_usage_record', usage(10000, 0, 50)),
  t('10:00:02.500', 'response_item', { type: 'function_call_output', call_id: 'call-1', output: 'Exit code: 2\nls: no such file' }),
  t('10:00:04.000', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The folder is empty.' }] }),
  t('10:00:04.000', 'token_usage_record', usage(10200, 9000, 20)),
  t('10:00:05.000', 'event_msg', { type: 'task_complete', time_to_first_token_ms: 700 }),
  t('10:01:00.000', 'world_state', { full: false, state: { agents_md: {} } }),
  t('10:01:00.000', 'event_msg', { type: 'task_started', started_at: 1793872860 }),
  t('10:01:00.100', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] }),
  t('10:01:02.000', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
  t('10:01:02.000', 'token_usage_record', usage(10400, 1000, 10)),
  t('10:01:03.000', 'compacted', { message: 'Summary of the chat' }),
].join('\n');

test('turns, steps and records follow the rollout', () => {
  const doc = project(rollout());
  assert.equal(doc.threadId, 'thread-1'); assert.equal(doc.model, 'gpt-6.1-terra'); assert.equal(doc.contextWindow, 400000);
  assert.deepEqual(doc.turns.map(x => [x.turn, x.groups.map(g => g.title)]), [[1, ['Message', 'Step 1', 'Step 2']], [2, ['Message', 'Step 1']], [null, ['Compaction 17']]]);
  assert.deepEqual(doc.turns[0]!.groups[0]!.cells.map(c => c.kind), ['system', 'context', 'user']);
  assert.equal(doc.turns[0]!.groups[0]!.cells[2]!.opensTurn, true);
  const indexes = doc.turns.flatMap(x => x.groups.flatMap(g => g.cells.map(c => c.index)));
  assert.deepEqual(indexes, indexes.map((_, i) => i + 1));
});
test('a tool call carries its result, timing and failure', () => {
  const [message, tool] = project(rollout()).turns[0]!.groups[1]!.cells;
  assert.ok(message && tool);
  assert.equal(message.kind, 'message'); assert.equal(message.text, '1 tool call');
  assert.equal(tool.kind, 'tool'); assert.equal(tool.toolName, 'exec_command'); assert.equal(tool.result, 'Exit code: 2'); assert.equal(tool.isError, true); assert.equal(tool.timeSeconds, 1.5);
});
test('usage is disjoint and the first request gets the recorded TTFT', () => {
  const doc = project(rollout()); const second = doc.requestNumbers[1]!;
  assert.deepEqual(second.usage, { input: 1200, cacheRead: 9000, cacheWrite: 0, output: 20, reasoning: 5 });
  assert.deepEqual(second.cache, { hitPercent: 88 });
  const metrics = doc.turns[0]!.groups[1]!.cells[0]!.assistantMetrics; assert.ok(metrics);
  assert.equal(metrics.firstTokenTime! - metrics.stepStartTime!, 700);
  assert.equal(doc.turns[0]!.groups[2]!.cells[0]!.assistantMetrics!.firstTokenTime, null);
});
test('a cache break names the recorded change', () => {
  const doc = project(rollout()); assert.deepEqual(doc.requestNumbers[2]!.cache, { hitPercent: 10, cause: 'AGENTS.md changed' });
  assert.deepEqual(doc.requestNumbers.map(r => r.number), [1, 2, 3]);
});
test('a partial last line keeps earlier turns and marks the document truncated', () => {
  const doc = project(`${rollout()}\n{"timestamp":`); assert.equal(doc.truncated, true); assert.equal(doc.requestNumbers.length, 3);
});
test('RFC3339 timestamps are read as UTC milliseconds', () => {
  const documentAt = (timestamp: string) => project(line(timestamp, 'response_item', { type: 'message', role: 'user', content: [] })).turns[0]!.groups[0]!.cells[0]!;
  assert.equal(documentAt('1970-01-01T00:00:01.500Z').startedAt, 1500);
  assert.equal(documentAt('2026-11-05T10:00:00.000Z').startedAt, 1793872800000);
  assert.equal(documentAt('not a time').startedAt, undefined);
});
test('a Smart Prune checkpoint is not a compaction', () => {
  const doc = project([t('10:00:00.000', 'event_msg', { type: 'task_started' }), t('10:00:01.000', 'compacted', { message: 'elpis.context-prune.v1: {"kept":3}' })].join('\n'));
  const group = doc.turns.at(-1)!.groups[0]!; assert.equal(group.title, 'Smart Prune 1'); assert.equal(group.cells[0]!.text, 'Smart Prune checkpoint');
});
test('empty and malformed lines', () => {
  assert.deepEqual(project(''), { version: 1, threadId: '', turns: [], requestNumbers: [] });
  const doc = project(`broken\n${t('10:00:00.000', 'session_meta', { id: 'after' })}`);
  assert.equal(doc.truncated, true); assert.equal(doc.threadId, '', 'as in Rust, nothing after a broken line is read');
});

test('complete document matches the Rust rollout contract', () => {
  const start = 1793872800000;
  const u1 = { input: 10000, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 5 };
  const u2 = { input: 1200, cacheRead: 9000, cacheWrite: 0, output: 20, reasoning: 5 };
  const u3 = { input: 9400, cacheRead: 1000, cacheWrite: 0, output: 10, reasoning: 5 };
  assert.deepEqual(project(rollout()), {
    version: 1, threadId: 'thread-1', cwd: '/w', provider: 'openai', model: 'gpt-6.1-terra', contextWindow: 400000,
    turns: [
      { turn: 1, groups: [
        { title: 'Message', cells: [
          { index: 1, kind: 'system', text: 'You are Elpis.', timeSeconds: null, sourceSeq: 0, systemPromptDetail: 'You are Elpis.' },
          { index: 2, kind: 'context', text: '# AGENTS.md instructions for /w', timeSeconds: null, sourceSeq: 4, inputDetail: '# AGENTS.md instructions for /w\n\nrules', startedAt: start + 100 },
          { index: 3, kind: 'user', text: 'List the files', timeSeconds: null, opensTurn: true, sourceSeq: 5, inputDetail: 'List the files', startedAt: start + 200 },
        ] },
        { title: 'Step 1', description: '2,500 ms', cells: [
          { index: 4, kind: 'message', text: '1 tool call', timeSeconds: 2, sourceSeq: 6, assistantMetrics: { timingRecorded: true, stepStartTime: start, firstTokenTime: start + 700, completedTime: start + 2000, usageProvided: true, outputTokens: 50 }, startedAt: start, input: 10000, cacheRead: 0, cacheWrite: 0, output: 50, think: 5 },
          { index: 5, kind: 'tool', text: 'exec_command {"cmd":"ls"}', timeSeconds: 1.5, sourceSeq: 6, inputDetail: '{"cmd":"ls"}', callId: 'call-1', toolName: 'exec_command', startedAt: start + 1000, result: 'Exit code: 2', outputDetail: 'Exit code: 2\nls: no such file', isError: true },
        ] },
        { title: 'Step 2', description: '1,500 ms', cells: [
          { index: 6, kind: 'message', text: 'The folder is empty.', timeSeconds: 1.5, sourceSeq: 9, outputDetail: 'The folder is empty.', assistantMetrics: { timingRecorded: true, stepStartTime: start + 2500, firstTokenTime: null, completedTime: start + 4000, usageProvided: true, outputTokens: 20 }, startedAt: start + 2500, input: 1200, cacheRead: 9000, cacheWrite: 0, output: 20, think: 5 },
        ] },
      ] },
      { turn: 2, groups: [
        { title: 'Message', cells: [{ index: 7, kind: 'user', text: 'Again', timeSeconds: null, opensTurn: true, sourceSeq: 14, inputDetail: 'Again', startedAt: start + 60100 }] },
        { title: 'Step 1', description: '2,000 ms', cells: [{ index: 8, kind: 'message', text: 'Done.', timeSeconds: 2, sourceSeq: 15, outputDetail: 'Done.', assistantMetrics: { timingRecorded: true, stepStartTime: start + 60000, firstTokenTime: null, completedTime: start + 62000, usageProvided: true, outputTokens: 10 }, startedAt: start + 60000, input: 9400, cacheRead: 1000, cacheWrite: 0, output: 10, think: 5 }] },
      ] },
      { turn: null, groups: [{ title: 'Compaction 17', description: '0 ms', cells: [{ index: 9, kind: 'compacted', text: 'Summary of the chat', timeSeconds: null, sourceSeq: 17, outputDetail: 'Summary of the chat', startedAt: start + 63000 }] }] },
    ],
    requestNumbers: [
      { group: 'Step 1', number: 1, purpose: 'assistant', seq: 7, turn: 1, step: 1, status: 'complete', startedAt: start, completedAt: start + 2000, provider: 'openai', model: 'gpt-6.1-terra', usage: u1, cumulativeUsage: u1, cache: { hitPercent: 0 } },
      { group: 'Step 2', number: 2, purpose: 'assistant', seq: 10, turn: 1, step: 2, status: 'complete', startedAt: start + 2500, completedAt: start + 4000, provider: 'openai', model: 'gpt-6.1-terra', usage: u2, cumulativeUsage: { input: 11200, cacheRead: 9000, cacheWrite: 0, output: 70, reasoning: 10 }, cache: { hitPercent: 88 } },
      { group: 'Step 1', number: 3, purpose: 'assistant', seq: 16, turn: 2, step: 1, status: 'complete', startedAt: start + 60000, completedAt: start + 62000, provider: 'openai', model: 'gpt-6.1-terra', usage: u3, cumulativeUsage: { input: 20600, cacheRead: 10000, cacheWrite: 0, output: 80, reasoning: 15 }, cache: { hitPercent: 10, cause: 'AGENTS.md changed' } },
    ],
  });
});

test('cache breaks report model, patch, compaction, prune and idle changes', () => {
  const rows = [
    t('10:00:00.000', 'turn_context', { model: 'old' }),
    t('10:00:00.000', 'world_state', { full: true, state: {} }),
    t('10:00:00.000', 'event_msg', { type: 'task_started' }),
    t('10:00:01.000', 'token_usage_record', usage(100, 90, 1)),
    t('10:00:02.000', 'turn_context', { model: 'new' }),
    t('10:00:02.000', 'world_state', { full: false, state: { elpis_continuity: {}, collaboration_mode: {} } }),
    t('10:00:02.000', 'compacted', { message: 'summary' }),
    t('10:00:02.000', 'compacted', { message: 'elpis.context-prune.v1: checkpoint' }),
    t('10:06:01.000', 'event_msg', { type: 'task_started' }),
    t('10:06:02.000', 'token_usage_record', { usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 20, output_tokens: 2 } }),
  ];
  const second = project(rows.join('\n')).requestNumbers[1]!;
  assert.deepEqual(second.usage, { input: 70, cacheRead: 10, cacheWrite: 20, output: 2, reasoning: 0 });
  assert.deepEqual(second.cache, { hitPercent: 10, cause: 'model change: old → new; collaboration mode changed; admitted context changed; compaction; Smart Prune; idle 6 min since the previous request' });
});

test('legacy usage, cache-drop threshold, and interrupted output', () => {
  const rows = [
    t('10:00:00.000', 'event_msg', { type: 'task_started' }),
    t('10:00:01.000', 'event_msg', { type: 'token_count', info: { last_token_usage: usage(100, 80, 1).usage } }),
    t('10:00:02.000', 'event_msg', { type: 'token_count', info: { last_token_usage: usage(100, 60, 1).usage } }),
    t('10:00:03.000', 'event_msg', { type: 'token_count', info: { last_token_usage: usage(100, 39, 1).usage } }),
    t('10:00:04.000', 'response_item', { type: 'message', role: 'assistant', content: [{ text: 'unfinished' }] }),
    t('10:00:05.000', 'event_msg', { type: 'turn_aborted' }),
  ];
  const doc = project(rows.join('\n'));
  assert.deepEqual(doc.requestNumbers.map(r => r.cache), [{ hitPercent: 80 }, { hitPercent: 60 }, { hitPercent: 39, cause: 'cause not recorded' }, undefined]);
  assert.equal(doc.requestNumbers[3]!.status, 'error');
  assert.equal(doc.turns[0]!.groups[3]!.cells[0]!.text, 'unfinished');
  assert.equal(doc.turns[0]!.groups[3]!.cells[0]!.isError, true);
});
