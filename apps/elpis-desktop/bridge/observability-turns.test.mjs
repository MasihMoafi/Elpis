import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';
const ROOT = '01a14400-0000-7000-8000-000000000001', CHILD = '01a14400-0000-7000-8000-000000000002';
const turn = i => ({ id: `t${i}`, status: 'completed', items: [] });
function engine(reply) {
  const socket = new EventEmitter(), calls = []; socket.close = () => {};
  socket.send = raw => { const request = JSON.parse(raw); calls.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...reply(request) }))); };
  return { client: new DesktopClient(socket), calls };
}
test('client uses read-only active listing and native full turn pages, without resuming agents', async () => {
  const { client, calls } = engine(request => ({ result: { data: request.method === 'thread/list' ? [{ id: ROOT }, { id: CHILD, parentThreadId: ROOT, source: { subAgent: { other: 'guardian' } } }] : [turn(0)], nextCursor: null } }));
  try {
    const listed = await client.observabilityChats({ limit: 100 }); assert.equal(listed.data.length, 2, "review agents remain observable"); await client.observabilityTurns(ROOT, { limit: 20 });
    assert.deepEqual(calls.map(row => row.method), ['thread/list', 'thread/turns/list']);
    assert.equal(calls[0].params.archived, false); assert.equal(calls[0].params.useStateDbOnly, true);
    assert.equal(calls[1].params.sortDirection, 'asc'); assert.equal(calls[1].params.itemsView, 'full');
  } finally { client.close(); }
});
test('legacy turn history is paginated too', async () => {
  const { client } = engine(request => request.method === 'thread/turns/list' ? { error: { code: -32601, message: 'Legacy history' } } : { result: { thread: { id: ROOT, turns: [turn(0), turn(1), turn(2)] } } });
  try {
    const first = await client.observabilityTurns(ROOT, { limit: 2 }); assert.equal(first.data.length, 2);
    const next = await client.observabilityTurns(ROOT, { limit: 2, cursor: first.nextCursor }); assert.deepEqual(next.data.map(row => row.id), ['t2']); assert.equal(next.nextCursor, null);
  } finally { client.close(); }
});
test('Canvas lineage is recovered for an agent whose list row omits its parent', async () => {
  const graphId = '01a14400-0000-7000-8000-000000000099';
  const worker = { id: CHILD, parentThreadId: null, source: { subAgent: { other: `work_graph:${graphId}:verify` } } };
  const { client } = engine(request => ({ result: request.method === 'thread/list' ? { data: [worker], nextCursor: null }
    : request.method === 'thread/read' ? { thread: { ...worker, parentThreadId: ROOT } }
    : { data: [{ id: graphId, tasks: [{ id: 'verify', title: 'Verify parser', assignedThreadId: CHILD }] }] } }));
  try { const page = await client.observabilityChats(); assert.equal(page.data[0].parentThreadId, ROOT); assert.equal(page.data[0].workflowTaskTitle, 'Verify parser'); }
  finally { client.close(); }
});
