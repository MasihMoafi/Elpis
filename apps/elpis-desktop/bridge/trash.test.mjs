// Chats deleted from the sidebar: archived at once, brought back by Ctrl+Z (newest first), deleted for good when the
// app quits or, after a crash, when it next starts. A fake client stands in for the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrash } from './trash.mjs';
import { startDesktopServer } from './server.mjs';

/** The engine as the bridge sees it: chats with parents, archived flags, and every call it was asked to make. */
function fakeClient() {
  const threads = new Map([['root', {}], ['agent', { parentThreadId: 'root' }], ['old-agent', { parentThreadId: 'root', archived: true }], ['other', {}]].map(([id, extra]) => [id, { id, name: id, status: { type: 'idle' }, archived: false, ...extra }]));
  const calls = [];
  const descends = (id, from) => { for (let at = threads.get(id); at?.parentThreadId; at = threads.get(at.parentThreadId)) if (at.parentThreadId === from) return true; return false; };
  return { threads, calls, connected: true, pendingApprovals: [], on() {}, off() {}, close() {},
    async listThreads({ ancestorThreadId, archived = false } = {}) {
      calls.push(['list', ancestorThreadId ?? null, archived]);
      return { data: [...threads.values()].filter(thread => thread.archived === archived && (!ancestorThreadId || descends(thread.id, ancestorThreadId))), nextCursor: null };
    },
    async archiveThread(id) { calls.push(['archive', id]); for (const thread of threads.values()) if (thread.id === id || descends(thread.id, id)) thread.archived = true; return { archived: true }; },
    async unarchiveThread(id) { calls.push(['unarchive', id]); threads.get(id).archived = false; return { thread: threads.get(id) }; },
    async deleteThread(id) { calls.push(['delete', id]); if (!threads.has(id)) throw Error('thread not found'); for (const thread of [...threads.values()]) if (thread.id === id || descends(thread.id, id)) threads.delete(thread.id); return { deleted: true, alsoDeleted: [] }; },
  };
}
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'elpis-trash-test-')).then(dir => path.join(dir, 'deleted-chats.json'));

test('a deleted chat is archived with its agents, hidden from the archive, and Ctrl+Z restores exactly what it archived, newest first', async () => {
  const client = fakeClient(), trash = await createTrash({ client, file: await temp() });
  await trash.trash(['other']); await trash.trash(['root']);
  assert.deepEqual(client.calls.filter(call => call[0] === 'archive'), [['archive', 'other'], ['archive', 'root']]);
  assert.ok(['root', 'agent', 'other'].every(id => trash.has(id)), 'the archived list must not show a chat waiting to be deleted');
  assert.equal(trash.has('old-agent'), false, 'an agent archived before stays an ordinary archived chat');
  assert.equal(client.calls.some(call => call[0] === 'delete'), false, 'nothing is deleted before the app quits');
  const back = await trash.undo();
  assert.deepEqual([back.threads.map(thread => thread.id), back.restored], [['root'], ['root', 'agent']]);
  assert.deepEqual(client.calls.filter(call => call[0] === 'unarchive'), [['unarchive', 'root'], ['unarchive', 'agent']]);
  assert.equal(client.threads.get('old-agent').archived, true);
  assert.deepEqual((await trash.undo()).threads.map(thread => thread.id), ['other']);
  assert.deepEqual(await trash.undo(), { threads: [], restored: [] });
});

test('quitting deletes the waiting chats for good; a crash leaves them on disk for the next start, which deletes them and cannot undo them', async () => {
  const file = await temp(), client = fakeClient();
  const first = await createTrash({ client, file });
  await first.trash(['root', 'other']);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).entries.map(entry => entry.ids), [['root', 'other']]);
  // The app crashed here: no purge. The next start reads the file.
  const next = await createTrash({ client, file });
  assert.ok(next.has('root') && next.has('agent'));
  assert.deepEqual(await next.undo(), { threads: [], restored: [] }, 'Ctrl+Z belongs to this session: an earlier session’s deletion is not brought back');
  await next.purge();
  assert.deepEqual(client.calls.filter(call => call[0] === 'delete'), [['delete', 'root'], ['delete', 'other']]);
  assert.equal(client.threads.has('agent'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).entries, []);
  assert.equal(next.has('root'), false);
});

test('a chat that is already gone does not keep the deletion list alive; a failed deletion is kept for the next start', async () => {
  const file = await temp(), client = fakeClient(), trash = await createTrash({ client, file });
  await trash.trash(['root']); await trash.trash(['other']);
  client.threads.delete('root'); client.threads.delete('agent');
  const real = client.deleteThread; client.deleteThread = async id => { if (id === 'other') throw Error('Elpis is busy'); return real(id); };
  await trash.purge();
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).entries.map(entry => entry.ids), [['other']]);
});

test('the server deletes the earlier session’s chats before it serves, hides waiting chats from the archived list, and deletes this session’s chats when it closes', async t => {
  const file = await temp(), client = fakeClient();
  await fs.writeFile(file, JSON.stringify({ version: 1, entries: [{ ids: ['other'], archived: ['other'] }] }));
  client.threads.get('other').archived = true;
  const app = await startDesktopServer({ client, trashFile: file }); let closed = false; t.after(() => closed || app.close());
  assert.deepEqual(client.calls.filter(call => call[0] === 'delete'), [['delete', 'other']], 'a crash’s leftovers go at the next start');
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = (pathname, data, cookie) => fetch(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  const cookie = (await post('/api/session', { token })).headers.get('set-cookie').split(';')[0];
  const get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } }).then(response => response.json());
  assert.deepEqual(await (await post('/api/trash', { threadIds: ['root'] }, cookie)).json(), { trashed: ['root'] });
  assert.deepEqual((await get('/api/threads?archived=true')).data.map(thread => thread.id), ['old-agent']);
  assert.equal((await post('/api/trash', { threadIds: [] }, cookie)).status, 400);
  assert.deepEqual((await (await post('/api/trash/undo', {}, cookie)).json()).threads.map(thread => thread.id), ['root']);
  await post('/api/trash', { threadIds: ['root'] }, cookie);
  closed = true; await app.close();
  assert.deepEqual(client.calls.filter(call => call[0] === 'delete').map(call => call[1]), ['other', 'root']);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).entries, []);
});

// Sidebar deletion archives before purging; preserve the same dirty-worktree outcome as direct archive/delete.
test('trash reports kept worktrees per chat and omits clean worktrees', async () => {
  const client = fakeClient(), archive = client.archiveThread;
  const kept = { kept: true, path: '/tmp/repo-elpis/chats/chat-123abc', branch: 'elpis/chat-123abc', changes: 2 };
  client.archiveThread = async id => ({ ...await archive(id), worktree: id === 'root' ? kept : { removed: true, path: '/tmp/clean', branch: 'elpis/chat-456abc' } });
  const trash = await createTrash({ client });
  assert.deepEqual(await trash.trash(['root', 'other']), { trashed: ['root', 'other'], worktrees: [{ threadId: 'root', worktree: kept }] });
  assert.deepEqual((await trash.undo()).threads.map(thread => thread.id), ['root', 'other']);
});

test('Ctrl+Z works when unarchiving a chat brings its agents back with it: each chat is unarchived once', async () => {
  // The real client restores the agents archived with a chat and refuses a chat that is not archived (24 Oct).
  const client = fakeClient();
  client.unarchiveThread = async id => {
    client.calls.push(['unarchive', id]);
    if (!client.threads.get(id).archived) throw Error(`thread ${id} is not archived`);
    client.threads.get(id).archived = false;
    const restored = id === 'root' ? ['agent'] : [];
    for (const agent of restored) client.threads.get(agent).archived = false;
    return { thread: client.threads.get(id), ...(restored.length ? { restored } : {}) };
  };
  const trash = await createTrash({ client, file: await temp() });
  await trash.trash(['root']);
  const back = await trash.undo();
  assert.deepEqual([back.threads.map(thread => thread.id), back.restored], [['root'], ['root', 'agent']]);
  assert.deepEqual(client.calls.filter(call => call[0] === 'unarchive'), [['unarchive', 'root']]);
  assert.equal(client.threads.get('agent').archived, false);
});
