import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RewindHistory } from './rewind-history.mjs';

async function fixture() {
  const home = await fs.mkdir(path.resolve('../../.tmp/rewind'), { recursive: true }).then(() => fs.mkdtemp(path.resolve('../../.tmp/rewind/history-')));
  const chats = new Map([['original', { id: 'original', name: 'Chat', turns: ['one', 'two', 'three'], status: { type: 'idle' } }]]), calls = [];
  const rpc = async (method, body) => {
    calls.push([method, body]); const thread = chats.get(body.threadId);
    if (method === 'thread/turns/list') return { data: thread.turns.slice(-1).map(id => ({ id })), nextCursor: null };
    if (method === 'thread/fork') { const fork = { ...thread, id: 'prefix', turns: thread.turns.slice(0, thread.turns.indexOf(body.beforeTurnId)) }; chats.set(fork.id, fork); return { thread: fork }; }
    if (method === 'thread/name/set') thread.name = body.name;
    if (method === 'thread/archive') thread.archived = true;
    if (method === 'thread/unarchive') thread.archived = false;
    return { thread };
  };
  return { home, chats, calls, rpc, history: new RewindHistory(home, rpc) };
}

test('rewind preserves full native history, Undo and Redo toggle it across bridge restarts without starting turns', async () => {
  const f = await fixture(); const restored = await f.history.restore(f.chats.get('original'), 'two', async () => {});
  assert.equal(restored.thread.id, 'prefix'); assert.deepEqual(f.chats.get('original').turns, ['one', 'two', 'three']); assert.equal(f.chats.get('original').archived, true);
  const restarted = new RewindHistory(f.home, f.rpc); assert.equal((await restarted.status('prefix')).action, 'undo');
  assert.deepEqual(await restarted.currentIds(), ['prefix']);
  const undo = await restarted.toggle('prefix', 'undo'); assert.equal(undo.thread.id, 'original'); assert.equal(undo.undo, 'redo');
  const redo = await restarted.toggle('original', 'redo'); assert.equal(redo.thread.id, 'prefix'); assert.equal(redo.undo, 'undo');
  await restarted.hide('prefix', true); assert.deepEqual(await restarted.currentIds(), []);
  await restarted.hide('prefix', false); assert.deepEqual(await restarted.currentIds(), ['prefix']);
  assert.equal(f.calls.some(([method]) => ['thread/revert', 'turn/start', 'thread/inject_items'].includes(method)), false);
});

test('another message invalidates Undo; wrong action, active threads and missing records fail before mutation', async () => {
  const f = await fixture(); await f.history.restore(f.chats.get('original'), 'two', async () => {});
  await assert.rejects(f.history.toggle('prefix', 'redo'), /available/i);
  f.chats.get('prefix').turns.push('new'); await assert.rejects(f.history.toggle('prefix', 'undo'), /message|changed/i);
  await assert.rejects(f.history.toggle('unknown', 'undo'), /available/i);
});

test('a file restoration failure archives the unused fork and leaves the original history visible', async () => {
  const f = await fixture(); await assert.rejects(f.history.restore(f.chats.get('original'), 'two', async () => { throw Error('Files changed'); }), /Files changed/);
  assert.equal(f.chats.get('original').archived, undefined); assert.equal(f.chats.get('prefix').archived, true); assert.equal(await f.history.status('original'), null);
});
