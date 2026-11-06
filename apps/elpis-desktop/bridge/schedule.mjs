// Automations: prompts Elpis sends on a schedule (7 Nov, Masih: "a schedule tab ... mimic deepseek's", its "Automation
// tasks"). Each task says what to send, when (bridge/schedule-rules.mjs), and where: one chat it keeps using, or a new chat
// every run. The timer lives in this process, so tasks run while Elpis runs (open or in the tray); runs missed while it was
// closed become one run at the next start, as in DeepSeek Harness. Kept in <ELPIS_HOME>/automations/tasks.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, projectFolder, text, threadId as chatId } from './validate.mjs';
import { describeRule, nextRun, parseRule } from './schedule-rules.mjs';

const TARGETS = ['reuse', 'new'], RUN_LIMIT = 50, LONGEST_WAIT = 2 ** 31 - 1;

/** The task as the page and agents see it. */
const shown = task => ({ ...task, description: describeRule(task.rule) });

/** @param {{ client: { createThread: Function, send: Function }, file: string, now?: () => number, timers?: { set: Function, clear: Function } }} options */
export function createSchedule({ client, file, now = Date.now, timers = { set: setTimeout, clear: clearTimeout } }) {
  let tasks = /** @type {any[]} */ ([]), timer, closed = false, writing = Promise.resolve();
  const running = new Map(); // task id -> its run in flight
  const loaded = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      tasks = Array.isArray(saved?.tasks) ? saved.tasks : [];
    } catch (error) { if (error.code !== 'ENOENT') throw new BridgeError(`Automations could not be read from ${file}: ${error.message}`, 500); }
    arm();
  })();
  const save = () => (writing = writing.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, tasks }, null, 2));
    await fs.rename(temporary, file);
  }));
  const find = id => { const task = tasks.find(item => item.id === id); if (!task) throw new BridgeError('That automation no longer exists', 404); return task; };

  /** One timer for the earliest active task; a task already due runs now. */
  function arm() {
    if (timer) timers.clear(timer);
    timer = undefined;
    if (closed) return;
    const due = tasks.filter(task => task.status === 'active' && task.nextRunAt != null && !running.has(task.id));
    if (!due.length) return;
    const wait = Math.max(0, Math.min(...due.map(task => task.nextRunAt)) - now());
    timer = timers.set(tick, Math.min(wait, LONGEST_WAIT));
    timer?.unref?.();
  }
  function tick() {
    timer = undefined;
    for (const task of tasks) if (task.status === 'active' && task.nextRunAt != null && task.nextRunAt <= now() && !running.has(task.id)) void run(task, task.nextRunAt);
    arm();
  }

  /** Sends the task's prompt; records the run, and its error if it failed. Runs that came due meanwhile are one run. */
  function run(task, scheduledFor) {
    const work = (async () => {
      const record = { at: now(), scheduledFor, threadId: null, error: null };
      try {
        let threadId = task.target === 'reuse' ? task.threadId : null;
        if (!threadId) {
          const made = await client.createThread({ ...(task.cwd ? { cwd: task.cwd } : {}), name: task.title, automatic: true });
          threadId = made?.thread?.id;
          if (typeof threadId !== 'string') throw new Error('Elpis did not start a chat for it');
          if (task.target === 'reuse') task.threadId = threadId;
        }
        record.threadId = threadId;
        await client.send(threadId, { text: task.prompt, automatic: true });
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        // The kept chat was deleted: the next run starts a new one.
        if (task.target === 'reuse' && /not found|no longer exists|unknown thread/i.test(record.error)) task.threadId = null;
      }
      task.runs = [record, ...(task.runs ?? [])].slice(0, RUN_LIMIT);
      task.lastRunAt = record.at;
      if (scheduledFor != null) {
        task.nextRunAt = nextRun(task.rule, Math.max(now(), scheduledFor), task.anchor);
        if (task.nextRunAt == null) task.status = 'ended';
      }
      task.updatedAt = now();
      await save();
      return shown(task);
    })().finally(() => { running.delete(task.id); arm(); });
    running.set(task.id, work);
    return work;
  }

  function fields(input, partial) {
    object(input, partial ? ['title', 'prompt', 'cwd', 'rule', 'target', 'status'] : ['title', 'prompt', 'cwd', 'rule', 'target', 'status', 'threadId']);
    const value = {};
    if (!partial || input.title !== undefined) value.title = text(input.title, 'name', 120).trim();
    if (!partial || input.prompt !== undefined) value.prompt = text(input.prompt, 'instruction', 32000);
    if (input.cwd !== undefined) value.cwd = projectFolder(input.cwd || null) ?? null;
    if (!partial || input.rule !== undefined) value.rule = parseRule(input.rule);
    if (!partial || input.target !== undefined) {
      const target = input.target ?? 'reuse';
      if (!TARGETS.includes(target)) throw new BridgeError('Run in must be "reuse" (one chat) or "new" (a new chat each run)');
      value.target = target;
    }
    // Create only: the chat to keep using from the first run (an agent's "remind me here").
    if (input.threadId !== undefined) { value.threadId = chatId(input.threadId); value.target = 'reuse'; }
    if (input.status !== undefined) {
      if (!['active', 'paused'].includes(input.status)) throw new BridgeError('Status must be active or paused');
      value.status = input.status;
    }
    return value;
  }

  return {
    async list() { await loaded; return [...tasks].sort((a, b) => b.createdAt - a.createdAt).map(shown); },
    async create(input) {
      await loaded;
      const value = fields(input, false), at = now();
      const task = { id: randomUUID(), cwd: null, status: 'active', threadId: null, runs: [], lastRunAt: null, createdAt: at, updatedAt: at, anchor: at, ...value };
      task.nextRunAt = task.status === 'active' ? nextRun(task.rule, at, at) : null;
      if (task.nextRunAt == null && task.status === 'active') throw new BridgeError('That time has already passed');
      tasks.push(task); await save(); arm();
      return shown(task);
    },
    async update(id, input) {
      await loaded;
      const task = find(id), value = fields(input, true);
      if (value.target && value.target !== task.target) task.threadId = null;
      Object.assign(task, value, { updatedAt: now() });
      // A new rule or a resume counts from now; an ended task given a new rule runs again.
      if (value.rule || value.status === 'active') task.anchor = now();
      if (value.rule && task.status === 'ended') task.status = 'active';
      task.nextRunAt = task.status === 'active' ? nextRun(task.rule, now(), task.anchor) : null;
      if (task.status === 'active' && task.nextRunAt == null) task.status = 'ended';
      await save(); arm();
      return shown(task);
    },
    async remove(id) { await loaded; find(id); tasks = tasks.filter(task => task.id !== id); await save(); arm(); return { deleted: id }; },
    /** Run now: once, outside the schedule; the next scheduled run stays. */
    async runNow(id) {
      await loaded;
      const task = find(id);
      if (running.has(id)) throw new BridgeError('This automation is running now', 409);
      return run(task, null);
    },
    busy: () => running.size > 0,
    async close() { closed = true; if (timer) timers.clear(timer); await Promise.allSettled(running.values()); await writing; },
  };
}
