// Automations: when a rule runs next, and that a due task sends its prompt where it says, once per due time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nextRun, parseRule } from './schedule-rules.mjs';
import { createSchedule } from './schedule.mjs';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('each rule kind finds its next local time, strictly after the given moment', () => {
  const wed = at(2026, 11, 4, 10, 0); // a Wednesday, 10:00
  assert.equal(nextRun(parseRule({ kind: 'daily', time: '09:00' }), wed), at(2026, 11, 5, 9));
  assert.equal(nextRun(parseRule({ kind: 'daily', time: '10:00' }), wed), at(2026, 11, 5, 10), 'the same minute is not "after"');
  assert.equal(nextRun(parseRule({ kind: 'weekdays', time: '09:00' }), at(2026, 11, 6, 12)), at(2026, 11, 9, 9), 'Friday noon -> Monday');
  assert.equal(nextRun(parseRule({ kind: 'weekly', days: [7, 2], time: '08:30' }), wed), at(2026, 11, 8, 8, 30), 'Sunday comes before next Tuesday');
  assert.equal(nextRun(parseRule({ kind: 'monthly', day: 31, time: '09:00' }), at(2026, 2, 1)), at(2026, 2, 28, 9), 'a short month runs on its last day');
  assert.equal(nextRun(parseRule({ kind: 'once', at: '2026-11-04T11:00' }), wed), at(2026, 11, 4, 11));
  assert.equal(nextRun(parseRule({ kind: 'once', at: '2026-11-04T09:00' }), wed), null, 'a past one-time rule has no next run');
  assert.equal(nextRun(parseRule({ kind: 'every', minutes: 90 }), wed + 100 * 60_000, wed), wed + 180 * 60_000, 'every: anchor + k × interval');
});

test('rules that cannot run are refused with what is wrong', () => {
  for (const [rule, message] of [[{ kind: 'daily', time: '9:00' }, /HH:MM/], [{ kind: 'weekly', days: [], time: '09:00' }, /weekday/], [{ kind: 'every', minutes: 0 }, /interval/], [{ kind: 'yearly' }, /Repeat/], [{ kind: 'once', at: '2026-13-01T09:00' }, /YYYY/]])
    assert.throws(() => parseRule(rule), message);
});

function harness(start) {
  let clock = start, pending = null;
  const sent = [], made = [];
  const client = {
    async createThread(body) { const id = `chat-${made.length + 1}`; made.push({ id, ...body }); return { thread: { id } }; },
    async send(id, body) { sent.push({ id, text: body.text, automatic: body.automatic }); },
  };
  const timers = { set(fn, ms) { pending = { fn, due: clock + ms }; return pending; }, clear(handle) { if (pending === handle) pending = null; } };
  return { client, timers, sent, made, now: () => clock,
    /** Moves the clock and fires the timer if it came due; waits for the run to finish. */
    async advance(to) { clock = to; const due = pending; if (due && due.due <= clock) { pending = null; due.fn(); } await new Promise(resolve => setTimeout(resolve, 20)); } };
}

test('a due task sends its prompt into one kept chat, and a missed stretch is one run', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-schedule-')), 'tasks.json');
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const task = await schedule.create({ title: 'Morning check', prompt: 'Check the build', rule: { kind: 'daily', time: '09:00' }, target: 'reuse' });
  assert.equal(task.nextRunAt, at(2026, 11, 4, 9));
  await h.advance(at(2026, 11, 4, 8, 59));
  assert.equal(h.sent.length, 0, 'nothing before its time');
  await h.advance(at(2026, 11, 4, 9, 0));
  assert.deepEqual(h.sent, [{ id: 'chat-1', text: 'Check the build', automatic: true }]);
  // Three days pass with the computer asleep: one run, then the next is tomorrow.
  await h.advance(at(2026, 11, 7, 12, 0));
  assert.deepEqual(h.sent.map(item => item.id), ['chat-1', 'chat-1'], 'the same chat, and one run for the missed days');
  assert.equal(h.made.length, 1);
  const [saved] = await schedule.list();
  assert.equal(saved.nextRunAt, at(2026, 11, 8, 9));
  assert.equal(saved.runs.length, 2);
  await schedule.close();
  // Kept across restarts.
  const again = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  assert.equal((await again.list())[0].threadId, 'chat-1');
  await again.close();
});

test('a new chat every run, a one-time task ends, and a paused task does not run', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-schedule-')), 'tasks.json');
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const once = await schedule.create({ title: 'Report', prompt: 'Write the report', cwd: '/tmp', rule: { kind: 'once', at: '2026-11-04T08:30' }, target: 'new' });
  const paused = await schedule.create({ title: 'Quiet', prompt: 'Never', rule: { kind: 'every', minutes: 10 } });
  await schedule.update(paused.id, { status: 'paused' });
  await h.advance(at(2026, 11, 4, 8, 45));
  assert.deepEqual(h.sent.map(item => item.text), ['Write the report'], 'the paused task sent nothing');
  assert.equal(h.made[0].cwd, '/tmp');
  assert.equal(h.made[0].name, 'Report');
  assert.equal((await schedule.list()).find(task => task.id === once.id).status, 'ended');
  // Run now sends once and keeps the schedule.
  await schedule.runNow(once.id);
  assert.equal(h.made.length, 2, 'a new chat again');
  await assert.rejects(schedule.create({ title: 'Late', prompt: 'x', rule: { kind: 'once', at: '2026-11-04T08:00' } }), /already passed/);
  await schedule.close();
});

test('a chat\'s one sentence becomes a task: the tools create into this chat, list, pause and delete', async () => {
  const { callTool } = await import('./schedule-mcp.mjs');
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-schedule-')), 'tasks.json');
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  // The app's routes, as bridge/server.mjs maps them.
  const request = async (route, body) => {
    if (route === '/api/automations') return body ? schedule.create(body) : { data: await schedule.list() };
    const id = route.split('/').pop(), { action, ...fields } = body;
    return action === 'delete' ? schedule.remove(id) : schedule.update(id, fields);
  };
  const here = '00000000-0000-4000-8000-0000000000aa';
  const { created } = await callTool('automation_create', { title: 'Stand-up', prompt: 'What changed since yesterday?', rule: { kind: 'weekdays', time: '09:30' }, target: 'this_chat' }, here, request);
  assert.equal(created.when, 'Monday to Friday at 09:30');
  await h.advance(at(2026, 11, 4, 9, 30));
  assert.deepEqual(h.sent, [{ id: here, text: 'What changed since yesterday?', automatic: true }], 'sent into the chat that asked, without a new one');
  assert.equal(h.made.length, 0);
  const listed = await callTool('automation_list', {}, here, request);
  assert.equal(listed.automations.length, 1);
  assert.equal((await callTool('automation_update', { id: created.id, action: 'pause' }, here, request)).updated.status, 'paused');
  await callTool('automation_update', { id: created.id, action: 'delete' }, here, request);
  assert.equal((await schedule.list()).length, 0);
  await assert.rejects(callTool('automation_create', { title: 'x', prompt: 'x', rule: { kind: 'daily', time: '09:00' }, target: 'this_chat' }, undefined, request), /one_chat/);
  await schedule.close();
});

test('the Automations key opens /api/automations and no other route', async t => {
  const { startDesktopServer } = await import('./server.mjs');
  const { EventEmitter } = await import('node:events');
  const bus = new EventEmitter();
  const client = { connected: true, pendingApprovals: [], close() {}, on: (n, l) => bus.on(n, l), off: (n, l) => bus.off(n, l), ragEnvironment: async () => ({}), async listThreads() { return { data: [], nextCursor: null }; } };
  const automationsFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-schedule-')), 'tasks.json');
  const app = await startDesktopServer({ client, staticDir: '/tmp', automationsFile }); t.after(() => app.close());
  const { url, key } = app.automationAccess;
  const headers = { 'x-elpis-automations': key, 'content-type': 'application/json' };
  const made = await fetch(`${url}/api/automations`, { method: 'POST', headers, body: JSON.stringify({ title: 'T', prompt: 'P', rule: { kind: 'daily', time: '09:00' } }) });
  assert.equal(made.status, 201);
  assert.equal((await (await fetch(`${url}/api/automations`, { headers })).json()).data.length, 1);
  assert.equal((await fetch(`${url}/api/threads`, { headers })).status, 401, 'the key is not a session');
  assert.equal((await fetch(`${url}/api/automations`, { headers: { 'x-elpis-automations': 'wrong' } })).status, 401);
  const off = await startDesktopServer({ client, staticDir: '/tmp' }); t.after(() => off.close());
  assert.equal(off.automationAccess, null, 'without a file, a test or window has no automations');
});
