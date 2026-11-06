// Automations: prompts Elpis sends on a schedule (6 Nov, Masih: "a schedule tab ... mimic deepseek's", its "Automation
// tasks"). Each task says what to send, when (bridge/schedule-rules.mjs), and where: one chat it keeps using, or a new chat
// every run. The timer lives in this process, so tasks run while Elpis runs (open or in the tray); runs missed while it was
// closed become one run at the next start, as in DeepSeek Harness. Kept in <ELPIS_HOME>/automations/tasks.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, projectFolder, text, threadId as chatId } from './validate.mjs';
import { describeRule, legacyRule, nextRun, parseRule } from './schedule-rules.mjs';

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
      // Rules saved before 6 Nov were local-time objects; they become RFC 5545 text in this computer's zone.
      tasks = (Array.isArray(saved?.tasks) ? saved.tasks : []).map(task => ({ ...task, rule: legacyRule(task.rule, task.anchor ?? task.createdAt) }));
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
        // How a scheduled workflow runs waits for Masih's choice: the window replays the board, or a chat builds its own team.
        if (task.workflow) throw new Error('Scheduled workflows do not run yet: choose how they run first');
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
        task.nextRunAt = nextRun(task.rule, Math.max(now(), scheduledFor));
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
    object(input, partial ? ['title', 'prompt', 'cwd', 'rule', 'target', 'status', 'workflow'] : ['title', 'prompt', 'cwd', 'rule', 'target', 'status', 'threadId', 'workflow']);
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
    // A workflow scheduled from the Workflows board (6 Nov): which one, by its id and name; its request is the prompt.
    if (input.workflow !== undefined) {
      if (input.workflow === null) value.workflow = null;
      else {
        object(input.workflow, ['id', 'name']);
        value.workflow = { id: text(input.workflow.id, 'workflow id', 200), name: text(input.workflow.name, 'workflow name', 120) };
      }
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
      const task = { id: randomUUID(), cwd: null, status: 'active', threadId: null, runs: [], lastRunAt: null, createdAt: at, updatedAt: at, ...value };
      task.nextRunAt = task.status === 'active' ? nextRun(task.rule, at) : null;
      if (task.nextRunAt == null && task.status === 'active') throw new BridgeError('That time has already passed');
      tasks.push(task); await save(); arm();
      return shown(task);
    },
    async update(id, input) {
      await loaded;
      const task = find(id), value = fields(input, true);
      if (value.target && value.target !== task.target) task.threadId = null;
      Object.assign(task, value, { updatedAt: now() });
      // An ended task given a new rule runs again; the next run counts from now.
      if (value.rule && task.status === 'ended') task.status = 'active';
      task.nextRunAt = task.status === 'active' ? nextRun(task.rule, now()) : null;
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
