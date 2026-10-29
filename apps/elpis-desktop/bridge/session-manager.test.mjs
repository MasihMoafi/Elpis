import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from './session-manager.mjs';
import { DesktopClient } from './client.mjs';

const NOW = Date.parse('2026-10-29T12:00:00Z'), DAY = 86400000;
const ago = days => (NOW - days * DAY) / 1000;
const finished = (id, text = 'Implemented and verified.') => ({ id, status: 'completed', items: [{ type: 'agentMessage', text }] });
const stopped = id => ({ id, status: 'interrupted', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Fix the parser' }] }] });
// The real chat (29 Oct): unnamed, its first message "h", then the requests that say what it is about.
const H_PROMPTS = ['h', 'why is the speed so low? in love-spot particularly', 'I read the first chapter; can you explain certain parts, including those images?'];
const H_FALLBACK = 'Why is the speed so low? in love-spot particularly';
const H_TITLE = 'Love Spot speed and DDIA chapter 1', PARSER_TITLE = 'Parser fix in the bridge';
const SIDE = '00000000-0000-0000-0000-0000000000a1';

function fixture() {
  const chats = new Map(), calls = [];
  const add = (id, { prompts = ['Fix the parser in the bridge'], turn = finished(`turn-${id}`), ...thread } = {}) => {
    chats.set(id, { thread: { id, name: null, preview: prompts[0] ?? '', updatedAt: ago(10), status: { type: 'idle' }, ...thread }, turn, prompts, archived: null });
    return chats.get(id);
  };
  const current = id => structuredClone({ thread: chats.get(id).thread, turn: chats.get(id).turn });
  // A fake background model: it reads the prompt and titles the chat, or fails while `model.down` is set.
  const bus = new EventEmitter(), model = { prompts: [], starts: [], down: false };
  const side = (method, params) => bus.emit('side', { method, params });
  const client = {
    pendingApprovals: [],
    on: (name, listener) => bus.on(name, listener), off: (name, listener) => bus.off(name, listener),
    settings: async () => ({ main: { model: 'big-model', provider: 'openai' }, background: { model: 'fast-model', provider: 'local' } }),
    async sideRpc(method, params) {
      if (method === 'thread/start') { model.starts.push(params); return { thread: { id: SIDE, ephemeral: true } }; }
      if (method === 'turn/start') {
        const prompt = params.input[0].text; model.prompts.push(prompt);
        const title = /love-spot/.test(prompt) ? H_TITLE : PARSER_TITLE;
        queueMicrotask(() => {
          if (!model.down) side('item/completed', { threadId: SIDE, item: { type: 'agentMessage', text: JSON.stringify({ title }), phase: 'final_answer' } });
          side('turn/completed', { threadId: SIDE, turn: model.down ? { id: 'm', status: 'failed', error: { message: 'The model is not available' }, items: [] } : { id: 'm', status: 'completed', items: [] } });
        });
        return { turn: { id: 'm', status: 'inProgress', items: [] } };
      }
      return {};
    },
    async listThreads({ cursor } = {}) {
      const rows = [...chats.values()].filter(row => !row.archived).map(row => structuredClone(row.thread)), at = Number(cursor ?? 0);
      return { data: rows.slice(at, at + 2), nextCursor: at + 2 < rows.length ? String(at + 2) : null };
    },
    async readSessionTurn(id) { calls.push(['read', id]); return current(id); },
    async readPrompts(id) { calls.push(['prompts', id]); return { data: chats.get(id).prompts.map((text, index) => ({ turnId: `t${index}`, text, reply: '' })) }; },
    async renameThread(id, { name }) { calls.push(['rename', id]); chats.get(id).thread.name = name; return { thread: chats.get(id).thread }; },
    async archiveThread(id, _body, guard) { const reason = await guard(current(id)); calls.push(['archive', id]); chats.get(id).archived = reason; return { archived: true }; },
  };
  return { client, add, chats, calls, model, name: id => chats.get(id).thread.name };
}

test('the chat titled "h" gets the background model\'s title for its content; meaningful titles, running chats and greetings keep theirs', async () => {
  const f = fixture();
  f.add('h-first-message', { prompts: H_PROMPTS });
  f.add('h-named', { name: 'h', prompts: H_PROMPTS });
  f.add('untitled', { name: 'Untitled conversation', prompts: ['## Fix the **parser** in the bridge'] });
  f.add('logo', { name: 'Logo 7' });
  f.add('first-line', { prompts: ['Fix the parser in the bridge'] });
  f.add('working-h', { name: 'h', prompts: H_PROMPTS, status: { type: 'active' }, turn: { id: 'w', status: 'inProgress', items: [] } });
  f.add('greetings', { prompts: ['h', 'hi', 'thanks'] });
  const manager = await createSessionManager({ client: f.client, now: () => NOW });
  // Protection (pinned, open, unread) is about archiving; a pinned "h" still deserves a name.
  const result = await manager.run({ protectedIds: [...f.chats.keys()] });
  assert.equal(f.name('h-first-message'), H_TITLE, 'the model titles the chat from what it is about');
  assert.equal(f.name('h-named'), H_TITLE);
  assert.equal(f.name('untitled'), PARSER_TITLE);
  assert.equal(f.name('logo'), 'Logo 7', 'a meaningful name stays');
  assert.equal(f.name('first-line'), null, 'a chat already shown by a meaningful first line is not renamed');
  assert.equal(f.name('working-h'), 'h', 'a running chat is not touched');
  assert.equal(f.name('greetings'), null, 'no name is invented when no message says anything');
  assert.deepEqual(result.renamed.sort(), ['h-first-message', 'h-named', 'untitled']);
  assert.deepEqual(result.archived, []);
  const [prompt] = f.model.prompts;
  assert.equal(f.model.prompts.length, 3, 'the model is asked only for chats that need a name and have something to name');
  assert.match(prompt, /First request:\nMasih: why is the speed so low/);
  assert.match(prompt, /Latest turns:\nMasih: I read the first chapter/);
  assert.ok(f.model.prompts.every(text => text.length < 5000), 'within the token budget');
  assert.deepEqual(f.model.starts.map(start => [start.model, start.permissions]), Array(3).fill(['fast-model', ':read-only']), 'background model, read-only');
  const reads = () => f.calls.filter(([call]) => call === 'prompts').map(([, id]) => id).sort();
  assert.deepEqual(reads(), ['greetings', 'h-first-message', 'h-named', 'untitled']);
  await manager.run({ protectedIds: [...f.chats.keys()] });
  assert.deepEqual(reads(), ['greetings', 'h-first-message', 'h-named', 'untitled'], 'an unchanged chat is not read again');
});

test('when the model fails, the first request stands in and the model is asked again on the next run', async () => {
  const f = fixture();
  f.add('h', { prompts: H_PROMPTS });
  const manager = await createSessionManager({ client: f.client, now: () => NOW });
  f.model.down = true;
  assert.deepEqual((await manager.run({ protectedIds: ['h'] })).renamed, ['h']);
  assert.equal(f.name('h'), H_FALLBACK);
  f.model.down = false;
  assert.deepEqual((await manager.run({ protectedIds: ['h'] })).renamed, ['h']);
  assert.equal(f.name('h'), H_TITLE);
  await manager.run({ protectedIds: ['h'] });
  assert.equal(f.model.prompts.length, 2, 'a model title is final');
});

test('archives empty, abandoned and finished chats, and leaves running, waiting, named, protected, recent and family chats alone', async () => {
  const f = fixture();
  f.add('empty', { prompts: [], turn: null, updatedAt: ago(2) });
  f.add('abandoned', { turn: stopped('a'), updatedAt: ago(8) });
  f.add('finished', { updatedAt: ago(4) });
  f.add('empty-new', { prompts: [], turn: null, updatedAt: ago(0.1) });
  f.add('stopped-recently', { turn: stopped('s'), updatedAt: ago(4) });
  f.add('finished-recently', { updatedAt: ago(2) });
  f.add('question', { turn: finished('q', 'Which account should I use?'), updatedAt: ago(30) });
  f.add('failed', { turn: { id: 'f', status: 'failed', error: { message: 'Connection lost' }, items: [] }, updatedAt: ago(30) });
  f.add('approval', { updatedAt: ago(30) });
  f.client.pendingApprovals = [{ params: { threadId: 'approval' } }];
  f.add('running', { status: { type: 'active' }, turn: { id: 'r', status: 'inProgress', items: [] }, updatedAt: ago(30) });
  f.add('named', { name: 'Logo 7', updatedAt: ago(30) });
  f.add('named-h', { name: 'h', updatedAt: ago(30) });
  f.add('pinned', { updatedAt: ago(30) });
  f.add('parent', { updatedAt: ago(30) });
  f.add('child', { parentThreadId: 'parent', updatedAt: ago(30) });
  f.add('agent', { source: { subAgent: 'review' }, updatedAt: ago(30) });
  f.add('unknown-age', { updatedAt: undefined });
  const manager = await createSessionManager({ client: f.client, now: () => NOW });
  const result = await manager.run({ protectedIds: ['pinned'] });
  assert.deepEqual(result.archived.sort(), ['abandoned', 'empty', 'finished']);
  assert.match(f.chats.get('empty').archived, /^Archived by the Session Manager: .*empty/i);
  assert.match(f.chats.get('abandoned').archived, /^Archived by the Session Manager: .*stopped/i);
  assert.match(f.chats.get('finished').archived, /^Archived by the Session Manager: .*finished/i);
  assert.equal(f.name('named-h'), PARSER_TITLE, 'his "h" is renamed');
  assert.equal(f.chats.get('named-h').archived, null, 'but a chat he named is never archived');
  for (const id of ['empty-new', 'stopped-recently', 'finished-recently', 'question', 'failed', 'approval', 'running', 'named', 'pinned', 'parent', 'child', 'agent', 'unknown-age'])
    assert.equal(f.chats.get(id).archived, null, `${id} stays`);
  const second = await manager.run({ protectedIds: ['pinned'] });
  assert.deepEqual(second.archived, [], 'nothing else qualifies');
});

test('every archive is reversible: a chat Masih unarchives stays until it has a new turn, across restarts', async () => {
  const f = fixture();
  f.add('finished', { updatedAt: ago(4) });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-session-manager-'));
  const file = path.join(directory, 'state.json');
  const manager = await createSessionManager({ client: f.client, file, now: () => NOW });
  assert.deepEqual((await manager.run({ protectedIds: [] })).archived, ['finished']);
  // Unarchive in Settings > Archived; the bridge passes on the engine's thread/unarchived.
  f.chats.get('finished').archived = null;
  await manager.unarchived('finished');
  const cold = await createSessionManager({ client: f.client, file, now: () => NOW });
  assert.deepEqual((await cold.run({ protectedIds: [] })).archived, [], 'a restored chat is not archived again');
  Object.assign(f.chats.get('finished'), { turn: finished('later', 'Done again.') });
  f.chats.get('finished').thread.updatedAt = ago(3.5);
  assert.deepEqual((await cold.run({ protectedIds: [] })).archived, ['finished'], 'after a new turn the usual rules apply again');
  await fs.rm(directory, { recursive: true });
});

test('the final check under the archive lock keeps a chat that started running or was pinned meanwhile', async () => {
  const f = fixture();
  f.add('race'); f.add('pinned-later'); f.add('control');
  const manager = await createSessionManager({ client: f.client, now: () => NOW });
  const archive = f.client.archiveThread;
  let later;
  f.client.archiveThread = async (id, body, guard) => {
    if (id === 'race') Object.assign(f.chats.get(id), { thread: { ...f.chats.get(id).thread, status: { type: 'active' } }, turn: { id: 'new', status: 'inProgress', items: [] } });
    if (id === 'pinned-later') later = manager.run({ protectedIds: ['pinned-later'] });
    return archive(id, body, guard);
  };
  const result = await manager.run({ protectedIds: [] });
  assert.deepEqual(result.archived, ['control']);
  assert.equal(f.chats.get('race').archived, null);
  assert.equal(f.chats.get('pinned-later').archived, null);
  await later;
});

test('the desktop client reads the newest turn, and archives with the Session Manager reason only when its check passes', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-session-manager-client-'));
  const id = '10000000-0000-4000-8000-000000000001';
  const thread = { id, cwd: home, name: null, preview: 'Fix the parser', status: { type: 'idle' } };
  const turns = [finished('older', 'Which account?'), finished('latest')];
  const sent = [];
  const socket = new EventEmitter(); socket.close = () => {};
  socket.send = raw => {
    const request = JSON.parse(raw);
    sent.push(request.method);
    let result = {};
    if (request.method === 'thread/read') result = { thread };
    if (request.method === 'thread/turns/list') result = { data: (request.params.sortDirection === 'desc' ? [...turns].reverse() : turns).slice(0, request.params.limit) };
    if (request.method === 'thread/list') result = { data: [], nextCursor: null };
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket, { home, appHome: home });
  t.after(async () => { client.close(); await fs.rm(home, { recursive: true }); });
  assert.equal((await client.readSessionTurn(id)).turn.id, 'latest');
  await assert.rejects(client.archiveThread(id, {}, () => { throw Error('Chat changed'); }), /Chat changed/);
  assert.equal(sent.includes('thread/archive'), false, 'a failed check archives nothing');
  await client.archiveThread(id, {}, current => `Archived by the Session Manager: ${current.turn.id}.`);
  assert.equal(sent.includes('thread/archive'), true);
  const record = JSON.parse(await fs.readFile(path.join(home, 'desktop-archives', `${id}.json`), 'utf8'));
  assert.equal(record.archiveReason, 'Archived by the Session Manager: latest.');
});
