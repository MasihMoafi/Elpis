import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { DesktopClient } from './client.mts';
import { SpawnLinks } from './spawn-links.mts';

const MAKER = '00000000-0000-0000-0000-0000000000a1';
const CHILD = '00000000-0000-0000-0000-0000000000a2';
const OTHER = '00000000-0000-0000-0000-0000000000a3';
type Chat = { id: string; name: string; source: string; status: { type: string }; cwd: string; archived?: boolean; threadSource?: string | null; createdAt?: number; path?: string; model?: string; parentThreadId?: string };
const chat = (id: string, name: string): Chat => ({ id, name, source: 'vscode', status: { type: 'idle' }, cwd: '/tmp/spawn-links' });
const created = (id: string, over: object = {}) => ({ type: 'mcpToolCall', server: 'codex_tui', tool: 'create_thread', status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ threadId: id }) }] }, ...over });

/** An engine that lists three chats and knows no parent for any of them, as for chats made by create_thread.
 * `engineParents` gives chats a parent the engine lists (as for `elpis exec` agents) but does not archive with it. */
function fixture(t: TestContext, home = path.join(os.tmpdir(), `spawn-links-${randomUUID()}`), engineParents: Record<string, string> = {}) {
  const threads = new Map([[MAKER, chat(MAKER, 'Orchestrator')], [CHILD, chat(CHILD, 'Worker')], [OTHER, chat(OTHER, 'Unrelated')]]);
  const socket = Object.assign(new EventEmitter(), { sent: [] as Record<string, unknown>[], close: () => {}, send: (_raw: string) => {} });
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined) return;
    const { threadId, ancestorThreadId, archived } = request.params ?? {};
    const listed = [...threads.values()].filter(thread => !!thread.archived === !!archived && (!ancestorThreadId || engineParents[thread.id] === ancestorThreadId));
    const result = request.method === 'thread/list' ? { data: listed.map(thread => ({ ...thread, ...(engineParents[thread.id] ? { parentThreadId: engineParents[thread.id] } : {}) })), nextCursor: null }
      : request.method === 'thread/read' ? { thread: structuredClone(threads.get(threadId)) }
      : request.method === 'thread/archive' ? (threads.get(threadId)!.archived = true, {})
      : request.method === 'thread/unarchive' ? (delete threads.get(threadId)!.archived, { thread: structuredClone(threads.get(threadId)) }) : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const open = () => new DesktopClient(socket, { appHome: home, archiveDirectory: path.join(home, 'archives'), rewindHome: path.join(home, 'rewind'), spawnLinksFile: path.join(home, 'spawn-links.json'),
    githubConnector: { instructions: async () => null }, workflowOptions: { stateDir: path.join(home, 'workflows') } });
  const client = open(); t.after(() => client.close());
  const finish = (item: unknown, threadId = MAKER) => { socket.emit('message', JSON.stringify({ method: 'item/completed', params: { threadId, turnId: 't1', item } })); return new Promise(resolve => setTimeout(resolve, 20)); };
  return { client, open, socket, threads, finish, home };
}
const parentOf = async (client: DesktopClient, id: string) => (await client.listThreads()).data.find(thread => thread.id === id)!.parentThreadId;

test('a chat made by create_thread shows under the chat that made it, and stays there after a restart', async t => {
  const f = fixture(t), events: { data?: { method?: string; params: { thread: { id: string; parentThreadId: string } } } }[] = [];
  await f.client.listThreads();
  f.client.on('event', event => events.push(event as typeof events[number]));
  await f.finish({ ...created(CHILD), status: 'failed' });
  await f.finish({ ...created(CHILD), tool: 'read_thread' });
  assert.equal(await parentOf(f.client, CHILD), undefined, 'a failed or different call links nothing');
  await f.finish(created(CHILD));
  assert.equal(await parentOf(f.client, CHILD), MAKER);
  assert.equal(await parentOf(f.client, OTHER), undefined);
  const started = events.find(event => event.data?.method === 'thread/started');
  assert.ok(started?.data);
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

test('the agent chats the engine lists under a chat are archived with it, so deleting the chat leaves none behind', async t => {
  // An agent the engine lists under the chat but leaves out of its own archive must not stay behind in the sidebar.
  const f = fixture(t, undefined, { [CHILD]: MAKER });
  assert.deepEqual((await f.client.listThreads({ ancestorThreadId: MAKER })).data.map(thread => thread.id), [CHILD]);
  await f.client.archiveThread(MAKER, {});
  assert.deepEqual([...f.threads.values()].filter(thread => thread.archived).map(thread => thread.id), [MAKER, CHILD]);
  assert.deepEqual((await f.client.listThreads()).data.map(thread => thread.id), [OTHER], 'no agent of the deleted chat is left in the list');
});

test('unarchiving a chat brings back the agents archived with it, and not one archived on its own before', async t => {
  // Archived chats › Unarchive gave Masih's chat back without its agents (24 Oct): they stayed archived, and the archive
  // lists no agents, so nothing could bring them back.
  const f = fixture(t, undefined, { [CHILD]: MAKER, [OTHER]: MAKER });
  await f.client.archiveThread(OTHER, {});
  await f.client.archiveThread(MAKER, {});
  assert.deepEqual([...f.threads.values()].filter(thread => thread.archived).map(thread => thread.id), [MAKER, CHILD, OTHER]);
  const back = await f.client.unarchiveThread(MAKER, {});
  assert.deepEqual(back.restored, [CHILD], 'the window is told which agents came back');
  assert.deepEqual((await f.client.listThreads({ ancestorThreadId: MAKER })).data.map(thread => thread.id), [CHILD]);
  assert.equal(f.threads.get(OTHER)!.archived, true, 'an agent archived before its chat stays archived');
});

function rowFor<T extends { id: string }>(rows: T[], id: string) { const row = rows.find(value => value.id === id); assert.ok(row); return row; }

test('saved provider delegations recover without a creation-time transcript mention, including after restart', async t => {
  const f = fixture(t), at = 1792827361;
  Object.assign(f.threads.get(MAKER)!, { threadSource: 'user', createdAt: at - 100 });
  for (const id of [CHILD, OTHER]) Object.assign(f.threads.get(id)!, { threadSource: null, createdAt: at });
  const directory = path.join(f.home, 'elpis-claude');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'sessions.json'), JSON.stringify({
    [CHILD]: { model: 'agy/gemini', turns: [] },
    _delegations: { [CHILD]: { parentThreadId: MAKER, model: 'agy/gemini' } },
  }));
  assert.equal(await parentOf(f.client, CHILD), MAKER, 'the bridge registry is explicit creation evidence');
  assert.equal(await parentOf(f.client, OTHER), undefined, 'folder and timestamps never imply membership');
  const restarted = f.open(); t.after(() => restarted.close());
  assert.equal(await parentOf(restarted, CHILD), MAKER);
  assert.deepEqual((await restarted.listThreads({ ancestorThreadId: MAKER })).data.map(thread => thread.id), [CHILD]);
});

test('saved delegations retain nested families and include a parent on an older history page', async t => {
  const f = fixture(t), at = 1792827361;
  Object.assign(f.threads.get(MAKER)!, { threadSource: 'user', createdAt: at - 100 });
  for (const id of [CHILD, OTHER]) Object.assign(f.threads.get(id)!, { threadSource: null, createdAt: at });
  const directory = path.join(f.home, 'elpis-claude');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'sessions.json'), JSON.stringify({
    _delegations: { [CHILD]: { parentThreadId: MAKER }, [OTHER]: { parentThreadId: CHILD } },
  }));
  const send = f.socket.send;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/list' || request.params.ancestorThreadId) return send(raw);
    const data = request.params.cursor ? [f.threads.get(MAKER)] : [f.threads.get(CHILD), f.threads.get(OTHER)];
    queueMicrotask(() => f.socket.emit('message', JSON.stringify({ id: request.id, result: { data: structuredClone(data), nextCursor: request.params.cursor ? null : 'older' } })));
  };
  const page = await f.client.listThreads();
  assert.equal(rowFor(page.data, CHILD).parentThreadId, MAKER);
  assert.equal(rowFor(page.data, OTHER).parentThreadId, CHILD);
  assert.equal(page.data.filter(row => row.id === MAKER).length, 1, 'the project parent is present once');
});

test('malformed delegation records never invent a parent or take over a user-created chat', async t => {
  for (const helpers of [null, [], 'unreadable', { [CHILD]: null }, { [CHILD]: { parentThreadId: 42 } }, { [CHILD]: { parentThreadId: CHILD } }]) {
    const f = fixture(t), directory = path.join(f.home, 'elpis-claude');
    Object.assign(f.threads.get(CHILD)!, { threadSource: null, createdAt: 1792827361 });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'sessions.json'), JSON.stringify({ _delegations: helpers }));
    assert.equal(await parentOf(f.client, CHILD), undefined);
  }
  const f = fixture(t), directory = path.join(f.home, 'elpis-claude');
  Object.assign(f.threads.get(CHILD)!, { threadSource: 'user', createdAt: 1792827361 });
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'sessions.json'), JSON.stringify({ _delegations: { [CHILD]: { parentThreadId: MAKER } } }));
  assert.equal(await parentOf(f.client, CHILD), undefined);
});

test('cold history recovers only creation-time references, keeps explicit and user parents, and caches unchanged bytes', async t => {
  const f = fixture(t), at = 1792827361, second = '00000000-0000-0000-0000-0000000000a4';
  const wrongTime = '00000000-0000-0000-0000-0000000000a5';
  await fs.mkdir(f.home, { recursive: true });
  const transcript = path.join(f.home, 'parent.jsonl');
  const line = (timestamp: number, ids: string[]) => JSON.stringify({ timestamp: new Date(timestamp * 1000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call_output', output: JSON.stringify(ids) } }) + '\n';
  const contents = line(at + 18, [CHILD, second, OTHER]) + line(at + 3600, [wrongTime]);
  await fs.writeFile(transcript, contents);
  Object.assign(f.threads.get(MAKER)!, { threadSource: 'user', createdAt: at - 100, path: transcript });
  for (const id of [CHILD, second, wrongTime]) f.threads.set(id, { ...chat(id, id), threadSource: null, createdAt: at });
  Object.assign(f.threads.get(OTHER)!, { threadSource: 'user', createdAt: at });
  const before = await fs.stat(transcript);
  const page = await f.client.listThreads();
  for (const id of [CHILD, second]) assert.equal(rowFor(page.data, id).parentThreadId, MAKER);
  assert.equal(rowFor(page.data, OTHER).parentThreadId, undefined, 'a user-created chat is never inferred as a child');
  assert.equal(rowFor(page.data, wrongTime).parentThreadId, undefined, 'a later mention is not creation evidence');
  assert.equal(await fs.readFile(transcript, 'utf8'), contents);
  assert.equal((await fs.stat(transcript)).mtimeMs, before.mtimeMs, 'transcripts remain read-only');
  // A cached result survives restart without opening its transcript again.
  await fs.chmod(transcript, 0);
  t.after(() => fs.chmod(transcript, 0o600));
  const restarted = f.open(); t.after(() => restarted.close());
  assert.equal(await parentOf(restarted, CHILD), MAKER);
  Object.assign(f.threads.get(CHILD)!, { parentThreadId: OTHER });
  assert.equal(await parentOf(restarted, CHILD), OTHER, 'engine lineage takes precedence over inference');
});

test('creator links reject self-parenting, indirect cycles and cycles loaded from disk', async t => {
  const f = fixture(t);
  const links = new SpawnLinks(path.join(f.home, 'cycles.json'));
  assert.equal(await links.record(CHILD, MAKER), true);
  assert.equal(await links.record(OTHER, CHILD), true);
  assert.equal(await links.record(MAKER, OTHER), false);
  assert.equal(await links.record(MAKER, MAKER), false);
  await fs.writeFile(path.join(f.home, 'corrupt.json'), JSON.stringify({ [CHILD]: MAKER, [MAKER]: CHILD }));
  const cold = new SpawnLinks(path.join(f.home, 'corrupt.json'));
  assert.equal(cold.makerOf(MAKER), null);
  assert.equal(cold.makerOf(CHILD), MAKER);
  await f.finish(created(CHILD));
  f.threads.get(MAKER)!.parentThreadId = CHILD;
  assert.equal(await parentOf(f.client, CHILD), undefined, 'new recorded lineage cannot turn a saved creator link into a cycle');
});

test('a creator on an older history page is included beside its recovered children', async t => {
  const f = fixture(t), at = 1792827361;
  await fs.mkdir(f.home, { recursive: true });
  const transcript = path.join(f.home, 'older-parent.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ timestamp: new Date(at * 1000).toISOString(), type: 'response_item', payload: { output: CHILD } }) + '\n');
  Object.assign(f.threads.get(MAKER)!, { threadSource: 'user', createdAt: at - 100, path: transcript });
  Object.assign(f.threads.get(CHILD)!, { threadSource: null, createdAt: at });
  const send = f.socket.send;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/list') return send(raw);
    const data = request.params.cursor ? [f.threads.get(MAKER)] : [f.threads.get(CHILD), f.threads.get(OTHER)];
    queueMicrotask(() => f.socket.emit('message', JSON.stringify({ id: request.id, result: { data: structuredClone(data), nextCursor: request.params.cursor ? null : 'older' } })));
  };
  const page = await f.client.listThreads();
  assert.equal(rowFor(page.data, CHILD).parentThreadId, MAKER);
  assert.equal(page.data.filter(row => row.id === MAKER).length, 1, 'an unloaded parent never leaves its child loose');
  assert.equal(rowFor(page.data, OTHER).parentThreadId, undefined);
});

test('new references scan only appended bytes and unchanged negative lookups survive restart', async t => {
  const f = fixture(t), at = 1792827361;
  await fs.mkdir(f.home, { recursive: true });
  const transcript = path.join(f.home, 'incremental.jsonl');
  const line = (id: string) => JSON.stringify({ timestamp: new Date((at + 10) * 1000).toISOString(), type: 'response_item', payload: { output: id, text: 'مدرک'.repeat(20000) } }) + '\n';
  const first = line(CHILD), next = line(OTHER);
  await fs.writeFile(transcript, first);
  Object.assign(f.threads.get(MAKER)!, { threadSource: 'user', createdAt: at - 100, path: transcript });
  for (const id of [CHILD, OTHER]) Object.assign(f.threads.get(id)!, { createdAt: at, threadSource: null });
  const starts: (number | undefined)[] = [], stream = fsSync.createReadStream;
  t.mock.method(fsSync, 'createReadStream', (file: fsSync.PathLike, options: { start?: number } | undefined) => { if (file === transcript) starts.push(typeof options === 'object' && options ? options.start : undefined); return stream(file, options); });
  assert.equal(await parentOf(f.client, CHILD), MAKER);
  assert.equal(await parentOf(f.client, OTHER), undefined);
  const cold = f.open(); t.after(() => cold.close());
  assert.equal(await parentOf(cold, OTHER), undefined);
  assert.deepEqual(starts, [0], 'unchanged negative lookup does not open the transcript, even after restart');
  await fs.appendFile(transcript, next.slice(0, 40));
  assert.equal(await parentOf(cold, OTHER), undefined, 'an unfinished JSON record proves nothing');
  await parentOf(cold, OTHER);
  assert.deepEqual(starts, [0, Buffer.byteLength(first)], 'an unchanged partial record is not reread');
  await fs.appendFile(transcript, next.slice(40));
  assert.equal(await parentOf(cold, OTHER), MAKER, 'the next completed creation output repairs a previously unknown parent');
  assert.deepEqual(starts, [0, Buffer.byteLength(first), Buffer.byteLength(first)]);
});

test('a Claude creator is recovered from its Claude transcript when its native rollout has no reference', async t => {
  const f = fixture(t), at = 1792827361;
  // The bridge reads CLAUDE_CONFIG_DIR before the app home; this case must not depend on the runner's own.
  const config = process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (config !== undefined) process.env.CLAUDE_CONFIG_DIR = config; });
  Object.assign(f.threads.get(MAKER)!, { model: 'claude/opus', threadSource: 'user', createdAt: at - 100 });
  Object.assign(f.threads.get(CHILD)!, { threadSource: null, createdAt: at });
  const directory = path.join(f.home, '.claude/projects/-tmp-spawn-links');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(f.home, 'elpis-claude'));
  await fs.writeFile(path.join(f.home, 'elpis-claude/sessions.json'), JSON.stringify({ [MAKER]: { model: 'claude/opus', session: MAKER } }));
  await fs.writeFile(path.join(directory, `${MAKER}.jsonl`), JSON.stringify({ timestamp: new Date(at * 1000).toISOString(), type: 'user', message: { content: [{ type: 'tool_result', content: CHILD }] } }) + '\n');
  assert.equal(await parentOf(f.client, CHILD), MAKER);
  assert.equal(await parentOf(f.client, OTHER), undefined);
});

test('a rewritten rollout retains its creator through the engine UUIDv7 creation time', async t => {
  const f = fixture(t), at = 1792834643.444;
  const child = '01a16d45-a5f4-7b12-8d3d-cb21af1e7d76';
  const transcript = path.join(f.home, 'original-creation.jsonl');
  await fs.mkdir(f.home, { recursive: true });
  await fs.writeFile(transcript, JSON.stringify({ timestamp: new Date((at + 8) * 1000).toISOString(), type: 'event_msg', payload: { output: child } }) + '\n');
  Object.assign(f.threads.get(MAKER)!, { threadSource: 'user', createdAt: at - 100, path: transcript });
  f.threads.set(child, { ...chat(child, 'Rewritten review'), createdAt: at + 267, threadSource: null });
  Object.assign(f.threads.get(OTHER)!, { createdAt: at, threadSource: null });
  assert.equal(await parentOf(f.client, child), MAKER, 'the original creation is before the rewritten metadata timestamp');
  assert.equal(await parentOf(f.client, OTHER), undefined);
});

test('the engine lists every chat without its source; a chat the person started is known by its rollout header', async t => {
  // thread/list leaves threadSource out of every listed chat (codex-rs app-server thread_summary.rs), so on a real engine
  // no listed chat was a possible creator and nothing was recovered.
  const f = fixture(t), at = 1792827361, iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  await fs.mkdir(f.home, { recursive: true });
  const header = (id: string, at: number, source?: string) => JSON.stringify({ timestamp: iso(at), type: 'session_meta', payload: { id, ...(source ? { thread_source: source } : {}), base_instructions: { text: 'x'.repeat(100000) } } }) + '\n';
  const made = JSON.stringify({ timestamp: iso(at + 3), type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify([CHILD, OTHER]) } }) + '\n';
  const file = (name: string) => path.join(f.home, `${name}.jsonl`);
  await fs.writeFile(file('maker'), header(MAKER, at - 100, 'user') + made);
  await fs.writeFile(file('child'), header(CHILD, at));
  await fs.writeFile(file('other'), header(OTHER, at, 'user'));
  Object.assign(f.threads.get(MAKER)!, { threadSource: null, createdAt: at - 100, path: file('maker') });
  Object.assign(f.threads.get(CHILD)!, { threadSource: null, createdAt: at, path: file('child') });
  Object.assign(f.threads.get(OTHER)!, { threadSource: null, createdAt: at, path: file('other') });
  assert.equal(await parentOf(f.client, CHILD), MAKER, 'the chat made by the person-started chat sits under it');
  assert.equal(await parentOf(f.client, OTHER), undefined, 'a chat the person started is never put under another');
});
