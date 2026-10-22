import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';

const MAKER = '00000000-0000-0000-0000-0000000000a1';
const CHILD = '00000000-0000-0000-0000-0000000000a2';
const OTHER = '00000000-0000-0000-0000-0000000000a3';
const chat = (id, name) => ({ id, name, source: 'vscode', status: { type: 'idle' }, cwd: '/tmp/spawn-links' });
const created = (id, over = {}) => ({ type: 'mcpToolCall', server: 'codex_tui', tool: 'create_thread', status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ threadId: id }) }] }, ...over });

/** An engine that lists three chats and knows no parent for any of them, as for chats made by create_thread. */
function fixture(t, home = path.join(os.tmpdir(), `spawn-links-${randomUUID()}`)) {
  const threads = new Map([[MAKER, chat(MAKER, 'Orchestrator')], [CHILD, chat(CHILD, 'Worker')], [OTHER, chat(OTHER, 'Unrelated')]]);
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => {};
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined) return;
    const { threadId, ancestorThreadId } = request.params ?? {};
    const result = request.method === 'thread/list' ? { data: ancestorThreadId ? [] : [...threads.values()].filter(thread => !thread.archived), nextCursor: null }
      : request.method === 'thread/read' ? { thread: structuredClone(threads.get(threadId)) }
      : request.method === 'thread/archive' ? (threads.get(threadId).archived = true, {}) : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const open = () => new DesktopClient(socket, { archiveDirectory: path.join(home, 'archives'), rewindHome: path.join(home, 'rewind'), spawnLinksFile: path.join(home, 'spawn-links.json'),
    githubConnector: { instructions: async () => null }, workflowOptions: { stateDir: path.join(home, 'workflows') } });
  const client = open(); t.after(() => client.close());
  const finish = (item, threadId = MAKER) => { socket.emit('message', JSON.stringify({ method: 'item/completed', params: { threadId, turnId: 't1', item } })); return new Promise(resolve => setTimeout(resolve, 20)); };
  return { client, open, socket, threads, finish };
}
const parentOf = async (client, id) => (await client.listThreads()).data.find(thread => thread.id === id).parentThreadId;

test('a chat made by create_thread shows under the chat that made it, and stays there after a restart', async t => {
  const f = fixture(t), events = [];
  await f.client.listThreads();
  f.client.on('event', event => events.push(event));
  await f.finish({ ...created(CHILD), status: 'failed' });
  await f.finish({ ...created(CHILD), tool: 'read_thread' });
  assert.equal(await parentOf(f.client, CHILD), undefined, 'a failed or different call links nothing');
  await f.finish(created(CHILD));
  assert.equal(await parentOf(f.client, CHILD), MAKER);
  assert.equal(await parentOf(f.client, OTHER), undefined);
  const started = events.find(event => event.data?.method === 'thread/started');
  assert.equal(started.data.params.thread.id, CHILD);
  assert.equal(started.data.params.thread.parentThreadId, MAKER, 'the open window is told, so the chat moves under its maker at once');
  const restarted = f.open(); t.after(() => restarted.close());
  assert.equal(await parentOf(restarted, CHILD), MAKER);
});

test('the chats a chat made are listed as its agents and archived with it', async t => {
  const f = fixture(t);
  await f.finish(created(CHILD));
  assert.deepEqual((await f.client.listThreads({ ancestorThreadId: MAKER })).data.map(thread => thread.id), [CHILD], 'the engine lists none; the desktop adds what it remembers');
  assert.deepEqual((await f.client.listThreads({ ancestorThreadId: OTHER })).data, []);
  await f.client.archiveThread(MAKER, {});
  assert.deepEqual([...f.threads.values()].filter(thread => thread.archived).map(thread => thread.id), [MAKER, CHILD]);
});
