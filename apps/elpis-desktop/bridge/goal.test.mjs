import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
import { sessionContextFiles } from './session-context.mjs';

const ID = '00000000-0000-0000-0000-0000000000a1';
const scratch = path.join(os.homedir(), '.cache/elpis-briefs/cc');
function runtime(cwd, writable = true) {
  let goal = null;
  const socket = new EventEmitter(), calls = [];
  socket.close = () => {};
  socket.send = raw => {
    const msg = JSON.parse(raw); if (msg.id === undefined) return;
    calls.push(msg); let result;
    switch (msg.method) {
      case 'initialize': result = {}; break;
      case 'thread/read': result = { thread: { id: ID, cwd, status: { type: 'idle' }, source: 'cli', canAcceptDirectInput: writable } }; break;
      case 'thread/contextFiles/list': result = { files: [] }; break;
      case 'thread/goal/get': result = { goal }; break;
      case 'thread/goal/set': goal = { threadId: ID, objective: msg.params.objective, status: msg.params.status ?? goal?.status ?? 'active' }; result = { goal }; break;
      case 'thread/goal/clear': result = { cleared: Boolean(goal) }; goal = null; break;
      default: throw Error(`Unexpected RPC ${msg.method}`);
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: msg.id, result })));
  };
  return { client: new DesktopClient(socket, { appHome: scratch, spawnLinksFile: path.join(scratch, 'goal-test-links.json') }), calls, complete: () => { goal.status = 'complete'; } };
}
test('authenticated goal routes preserve runtime state and reject invalid writes without dispatch', async t => {
  const { client, calls, complete } = runtime(scratch); await client.initialize();
  const app = await startDesktopServer({ client, elpisHome: path.join(scratch, 'goal-unit-home'), loveSpot: { directory: path.join(scratch, 'goal-drawing') } }); t.after(() => app.close());
  const url = new URL(app.url), endpoint = `${url.origin}/api/threads/${ID}/goal`;
  assert.equal((await fetch(endpoint)).status, 401);
  const login = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }) });
  const headers = { Origin: url.origin, Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const get = () => fetch(endpoint, { headers }).then(r => r.json());
  const post = body => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.deepEqual(await get(), { goal: null });
  const saved = await post({ objective: 'Pass the focused checks.' }); assert.equal(saved.status, 200);
  assert.equal((await get()).goal.objective, 'Pass the focused checks.');
  complete(); await post({ objective: 'Pursue a new condition.' }); assert.equal((await get()).goal.status, 'active');
  const before = calls.length;
  for (const body of [{ objective: ' ' }, { objective: 'x', extra: true }, { clear: 'yes' }, { clear: true, objective: 'x' }]) assert.equal((await post(body)).status, 400);
  assert.equal(calls.length, before);
  assert.deepEqual(await (await post({ clear: true })).json(), { cleared: true }); assert.deepEqual(await get(), { goal: null });
  assert.deepEqual(await (await post({ clear: true })).json(), { cleared: false });
});
test('session context exposes missing project intent and Create cannot overwrite it or accept a path', async t => {
  const cwd = await fs.mkdtemp(path.join(scratch, 'goal-project-'));
  const { client } = runtime(cwd); t.after(() => client.close()); await client.initialize();
  let state = await client.sessionContext(ID), intent = state.files.find(f => f.path === path.join(cwd, 'ES.md'));
  assert.equal(intent.exists, false); assert.equal(intent.included, false);
  await assert.rejects(client.createSessionIntent(ID, { path: '/elsewhere' }), /fields/i);
  await client.createSessionIntent(ID, {});
  state = await client.sessionContext(ID); assert.equal(state.files.find(f => f.path === intent.path).exists, true);
  await fs.writeFile(intent.path, 'User intent must survive.');
  await assert.rejects(client.createSessionIntent(ID, {}), /already exists/i);
  assert.equal(await fs.readFile(intent.path, 'utf8'), 'User intent must survive.');
  const readonly = runtime(cwd, false); t.after(() => readonly.client.close()); await readonly.client.initialize();
  assert.equal((await readonly.client.sessionContext(ID)).writable, false);
  await assert.rejects(readonly.client.setGoal(ID, { objective: 'A child must not change its goal' }), /parent/);
  await assert.rejects(readonly.client.createSessionIntent(ID, {}), /parent/);
  assert.equal(readonly.calls.some(call => call.method === 'thread/goal/set'), false);
});

test('context lists recorded sources and selected skills, never the available catalog or assistant quotations; appended records refresh it', async () => {
  const cwd = await fs.mkdtemp(path.join(scratch, 'goal-sources-')), file = path.join(cwd, 'rollout.jsonl');
  const rules = path.join(cwd, 'CLAUDE.md'), recorded = path.join(cwd, 'CHAIN.md'), skill = path.join(cwd, 'selected/SKILL.md'), unused = path.join(cwd, 'unused/SKILL.md');
  for (const target of [rules, recorded, skill, unused]) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'Context file.'); }
  const item = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } }) + '\n';
  await fs.writeFile(file, item('developer', `### Source: ${rules} (13 characters)\n\nContext file.\n\n### Source: ${recorded} (13 characters)\n\nContext file.`) + item('developer', `Available skills: unused (file: ${unused})`) + item('assistant', `### Source: ${unused}\nQuoted only.`));
  const engine = [{ name: 'CLAUDE.md', path: rules, group: 'instructions', included: false, selectable: true, estimatedTokens: 4, reason: 'Excluded by the user' }];
  const read = () => sessionContextFiles({ cwd, path: file }, engine);
  let result = await read(); assert.equal(result.files.filter(row => row.path === rules).length, 1); assert.equal(result.files.find(row => row.path === rules).included, false);
  assert.equal(result.files.find(row => row.path === recorded)?.included, true);
  assert.equal(result.files.some(row => row.path === unused), false); assert.equal(result.files.some(row => row.path === skill), false);
  const record = item('user', `<skill>\n<name>Selected</name>\n<path>${skill}</path>\nSkill contents\n</skill>`), cut = Math.floor(record.length / 2);
  await fs.appendFile(file, record.slice(0, cut)); assert.equal((await read()).files.some(row => row.path === skill), false);
  await fs.appendFile(file, record.slice(cut)); result = await read();
  assert.equal(result.files.find(row => row.path === skill).group, 'skills'); assert.equal(result.files.some(row => row.path === unused), false);
  const manual = path.join(cwd, 'manual/SKILL.md'); await fs.mkdir(path.dirname(manual)); await fs.writeFile(manual, 'Manually read skill.');
  const readCommand = (target, exit_code) => JSON.stringify({ type: 'event_msg', payload: { type: 'exec_command_end', cwd, exit_code, aggregated_output: 'Skill content', parsed_cmd: [{ type: 'read', path: target }] } }) + '\n';
  await fs.appendFile(file, readCommand(unused, 1) + readCommand('manual/SKILL.md', 0)); result = await read();
  assert.equal(result.files.some(row => row.path === unused), false); assert.equal(result.files.find(row => row.path === manual)?.group, 'skills');
});
