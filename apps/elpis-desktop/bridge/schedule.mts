// Automations: prompts Elpis sends on a schedule (6 Nov, Masih: "a schedule tab ... mimic deepseek's", its "Automation
// tasks"). Each task says what to send, when (bridge/schedule-rules.mts), and where: one chat it keeps using, or a new chat
// every run. The timer lives in this process, so tasks run while Elpis runs (open or in the tray); runs missed while it was
// closed become one run at the next start, as in DeepSeek Harness. Kept in <ELPIS_HOME>/automations/tasks.json.
// A task may name its model, provider and effort (E26, 12 Nov, Masih: "whichever but mostly codex models and never
// anthropic's"): its chat starts on that model, and a model that cannot run fails the run with one line, never another model.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, object, projectFolder, text, threadId as chatId } from "./validate.mts";
import { describeRule, legacyRule, nextRun, parseRule } from "./schedule-rules.mts";
import { quotaStopLine, unlistedModelLine, workflowModelRoutes, workflowRoute } from "./workflow-models.mts";

type Board = { nodes: unknown[] };
type Workflow = { id: string; name: string; board?: Board | undefined };
type Run = { at: number; scheduledFor: number | null; threadId: string | null; error: string | null };
type Task = {
  id: string;
  title: string;
  prompt: string;
  cwd: string | null;
  rule: string;
  target: string;
  status: string;
  threadId: string | null;
  runs: Run[];
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  workflow?: Workflow | null;
  /** The chat's model, its connection (none for a subscription route or the engine's own list) and effort; none: the
   * app's default at run time. Tasks saved before 12 Nov have none. */
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
};
type Route = { model: string; provider: string | null; effort: string | null };
type Timers = { set: (fn: () => void, ms: number) => object; clear: (handle: object) => unknown };
type Client = {
  createThread: (body: {
    cwd?: string;
    name: string;
    automatic: boolean;
    model?: string;
    provider?: string;
  }) => Promise<{ thread?: { id?: string } }>;
  send: (id: string, body: { text: string; automatic: boolean; effort?: string }) => Promise<unknown>;
  /** The current model list: the engine's, or one connection's (bridge/client-models.mts). */
  models?: (options?: { provider?: string }) => Promise<{ data?: { model: string }[] }>;
  /** The subscriptions and their usage (bridge/client-settings.mts impl_providers). */
  providers?: () => Promise<Parameters<typeof workflowModelRoutes>[1]>;
};

const TARGETS = ["reuse", "new"],
  RUN_LIMIT = 50,
  LONGEST_WAIT = 2 ** 31 - 1;

const routeOf = (task: Task): Route | null =>
  task.model ? { model: task.model, provider: task.provider ?? null, effort: task.effort ?? null } : null;

/** The task as the page and agents see it. */
const shown = (task: Task) => ({
  ...task,
  ...(task.workflow ? { workflow: { id: task.workflow.id, name: task.workflow.name } } : {}),
  description: describeRule(task.rule),
});
/** A task's saved board, for the window that replays it. */
export const boardOf = (task: Task) => task.workflow?.board ?? null;

/** `dispatchWorkflow(job)` runs a scheduled workflow in an open window and resolves to its chat. */
export function createSchedule({
  client,
  file,
  now = Date.now,
  timers = { set: setTimeout, clear: clearTimeout } as Timers,
  dispatchWorkflow,
}: {
  client: Client;
  file: string;
  now?: () => number;
  timers?: Timers;
  dispatchWorkflow?: (job: object) => Promise<{ threadId: string }>;
}) {
  let tasks: Task[] = [],
    timer: object | undefined,
    closed = false,
    writing = Promise.resolve();
  const running = new Map<string, Promise<ReturnType<typeof shown>>>(); // task id -> its run in flight
  const loaded = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(file, "utf8")) as { tasks?: (Task & { anchor?: number })[] };
      // Rules saved before 6 Nov were local-time objects; they become RFC 5545 text in this computer's zone.
      tasks = (Array.isArray(saved?.tasks) ? saved.tasks : []).map(task => ({
        ...task,
        rule: legacyRule(task.rule, task.anchor ?? task.createdAt),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new BridgeError(`Automations could not be read from ${file}: ${(error as Error).message}`, 500);
    }
    arm();
  })();
  const save = () =>
    (writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, tasks }, null, 2));
      await fs.rename(temporary, file);
    }));
  const find = (id: string) => {
    const task = tasks.find(item => item.id === id);
    if (!task) throw new BridgeError("That automation no longer exists", 404);
    return task;
  };

  /** Throws the one line saying why the route cannot run: its model is not in the current list, or its subscription's
   * plan limit is reached. `quota`: also ask the subscriptions (at run time; a task being saved only needs the list). */
  async function checkRoute(route: Route, quota: boolean) {
    const named = { model: route.model, provider: workflowRoute(route.model, route.provider ?? "").provider };
    if (!client.models) return;
    const listed = await client.models(route.provider ? { provider: route.provider } : {}).catch((error: Error) => {
      throw new BridgeError(`${unlistedModelLine(named, "automation")} (${error.message})`);
    });
    if (!(listed?.data ?? []).some(item => item.model === route.model))
      throw new BridgeError(unlistedModelLine(named, "automation"));
    if (!quota || !client.providers) return;
    const providers = await client.providers().catch(() => null);
    const subscription = providers
      ? workflowModelRoutes(listed.data ?? [], providers).find(
          item => item.model === route.model && item.provider === named.provider,
        )
      : undefined;
    if (subscription?.exhausted)
      throw new BridgeError(quotaStopLine(named, false, subscription.resetsAt ?? null, "automation"), 409);
  }

  /** One timer for the earliest active task; a task already due runs now. */
  function arm() {
    if (timer) timers.clear(timer);
    timer = undefined;
    if (closed) return;
    const due = tasks.filter(task => task.status === "active" && task.nextRunAt != null && !running.has(task.id));
    if (!due.length) return;
    const wait = Math.max(0, Math.min(...due.map(task => task.nextRunAt!)) - now());
    timer = timers.set(tick, Math.min(wait, LONGEST_WAIT));
    (timer as { unref?: () => void } | undefined)?.unref?.();
  }
  function tick() {
    timer = undefined;
    for (const task of tasks)
      if (task.status === "active" && task.nextRunAt != null && task.nextRunAt <= now() && !running.has(task.id))
        void run(task, task.nextRunAt);
    arm();
  }

  /** One delivery: a scheduled workflow replays its saved board in an open window (6 Nov, Masih's choice), which
   * starts the run and reports its chat; any other task sends its prompt into its chat. Resolves to the chat's id. */
  async function deliver(task: Task) {
    if (task.workflow) {
      if (!dispatchWorkflow) throw new Error("Workflows run in the Elpis window, and none is connected");
      return (
        await dispatchWorkflow({
          taskId: task.id,
          title: task.title,
          request: task.prompt,
          cwd: task.cwd,
          workflow: task.workflow,
        })
      ).threadId;
    }
    let threadId: string | null | undefined = task.target === "reuse" ? task.threadId : null;
    // A chat that already exists keeps its own model; a new one starts on the task's, or on the app's default.
    const route = threadId ? null : routeOf(task);
    if (!threadId) {
      if (route) await checkRoute(route, true);
      const made = await client.createThread({
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(route ? { model: route.model, ...(route.provider ? { provider: route.provider } : {}) } : {}),
        name: task.title,
        automatic: true,
      });
      threadId = made?.thread?.id;
      if (typeof threadId !== "string") throw new Error("Elpis did not start a chat for it");
      if (task.target === "reuse") task.threadId = threadId;
    }
    await client.send(threadId, { text: task.prompt, automatic: true, ...(route?.effort ? { effort: route.effort } : {}) });
    return threadId;
  }

  /** Runs a task once and records it, with its error if it failed; runs that came due meanwhile are one run. */
  function run(task: Task, scheduledFor: number | null) {
    const work = (async () => {
      const record: Run = { at: now(), scheduledFor, threadId: null, error: null };
      try {
        record.threadId = await deliver(task);
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        // The kept chat was deleted: the next run starts a new one.
        if (task.target === "reuse" && /not found|no longer exists|unknown thread/i.test(record.error))
          task.threadId = null;
      }
      task.runs = [record, ...(task.runs ?? [])].slice(0, RUN_LIMIT);
      task.lastRunAt = record.at;
      if (scheduledFor != null) {
        task.nextRunAt = nextRun(task.rule, Math.max(now(), scheduledFor));
        if (task.nextRunAt == null) task.status = "ended";
      }
      task.updatedAt = now();
      await save();
      return shown(task);
    })().finally(() => {
      running.delete(task.id);
      arm();
    });
    running.set(task.id, work);
    return work;
  }

  function fields(raw: unknown, partial: boolean) {
    const input = object(
      raw,
      partial
        ? ["title", "prompt", "cwd", "rule", "target", "status", "workflow", "model", "provider", "effort"]
        : ["title", "prompt", "cwd", "rule", "target", "status", "threadId", "workflow", "model", "provider", "effort"],
    ) as Record<string, unknown>;
    const value: Partial<Task> = {};
    if (!partial || input.title !== undefined) value.title = text(input.title, "name", 120).trim();
    if (!partial || input.prompt !== undefined) value.prompt = text(input.prompt, "instruction", 32000);
    if (input.cwd !== undefined) value.cwd = (projectFolder(input.cwd || null) ?? null) as string | null;
    if (!partial || input.rule !== undefined) value.rule = parseRule(input.rule);
    if (!partial || input.target !== undefined) {
      const target = input.target ?? "reuse";
      if (!TARGETS.includes(target as string))
        throw new BridgeError('Run in must be "reuse" (one chat) or "new" (a new chat each run)');
      value.target = target as string;
    }
    // A workflow scheduled from the Workflows board (6 Nov): which one, by its id and name; its request is the prompt.
    if (input.workflow !== undefined) {
      if (input.workflow === null) value.workflow = null;
      else {
        const workflow = object(input.workflow, ["id", "name", "board"]) as Record<string, unknown>;
        const board = workflow.board as Board | undefined;
        // The board as it was when he pressed Schedule; the window replays exactly this one. An edit may leave it out.
        if (board === undefined && !partial) throw new BridgeError("A scheduled workflow needs its board");
        if (
          board !== undefined &&
          (!board ||
            typeof board !== "object" ||
            Array.isArray(board) ||
            !Array.isArray(board.nodes) ||
            JSON.stringify(board).length > 2_000_000)
        )
          throw new BridgeError("The workflow board could not be saved with the automation");
        value.workflow = {
          id: text(workflow.id, "workflow id", 200),
          name: text(workflow.name, "workflow name", 120),
          ...(board ? { board } : {}),
        };
      }
    }
    // Create only: the chat to keep using from the first run (an agent's "remind me here").
    if (input.threadId !== undefined) {
      value.threadId = chatId(input.threadId);
      value.target = "reuse";
    }
    if (input.status !== undefined) {
      if (!["active", "paused"].includes(input.status as string))
        throw new BridgeError("Status must be active or paused");
      value.status = input.status as string;
    }
    // A model given replaces the whole route: its provider and effort come with it, or are none. No model: the default.
    if (input.model !== undefined) {
      const model = input.model || null;
      if (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)))
        throw new BridgeError("Give a model ID from the current model list");
      value.model = model as string | null;
      value.provider = model && input.provider ? text(input.provider, "provider", 64) : null;
      if (value.provider && !/^[a-z][a-z0-9_-]*$/.test(value.provider))
        throw new BridgeError("Give a provider ID from Settings > Models & accounts");
      value.effort = null;
    } else if (input.provider !== undefined) throw new BridgeError("Give the model with its provider");
    if (input.effort !== undefined) {
      const effort = input.effort || null;
      if (effort !== null && (typeof effort !== "string" || !/^[a-z]{1,20}$/.test(effort)))
        throw new BridgeError("Give a reasoning effort the model offers, such as low, medium or high");
      value.effort = effort as string | null;
    }
    return value;
  }

  /** A route being saved: an effort needs its model, and a model must be in the current list. */
  async function saveable(task: Partial<Task>, input: Partial<Task>) {
    if (task.effort && !task.model) throw new BridgeError("Choose a model before its reasoning effort");
    const route = routeOf(task as Task);
    if (route && input.model !== undefined) await checkRoute(route, false);
  }

  return {
    async list() {
      await loaded;
      return [...tasks].sort((a, b) => b.createdAt - a.createdAt).map(shown);
    },
    async create(input: unknown) {
      await loaded;
      const value = fields(input, false),
        at = now();
      const task = {
        id: randomUUID(),
        cwd: null,
        status: "active",
        threadId: null,
        runs: [],
        lastRunAt: null,
        createdAt: at,
        updatedAt: at,
        ...value,
      } as Task;
      await saveable(task, value);
      task.nextRunAt = task.status === "active" ? nextRun(task.rule, at) : null;
      if (task.nextRunAt == null && task.status === "active") throw new BridgeError("That time has already passed");
      tasks.push(task);
      await save();
      arm();
      return shown(task);
    },
    async update(id: string, input: unknown) {
      await loaded;
      const task = find(id),
        value = fields(input, true);
      if (value.target && value.target !== task.target) task.threadId = null;
      if (value.workflow && !value.workflow.board) value.workflow.board = task.workflow?.board;
      await saveable({ ...task, ...value }, value);
      Object.assign(task, value, { updatedAt: now() });
      // An ended task given a new rule runs again; the next run counts from now.
      if (value.rule && task.status === "ended") task.status = "active";
      task.nextRunAt = task.status === "active" ? nextRun(task.rule, now()) : null;
      if (task.status === "active" && task.nextRunAt == null) task.status = "ended";
      await save();
      arm();
      return shown(task);
    },
    async remove(id: string) {
      await loaded;
      find(id);
      tasks = tasks.filter(task => task.id !== id);
      await save();
      arm();
      return { deleted: id };
    },
    /** Run now: once, outside the schedule; the next scheduled run stays. */
    async runNow(id: string) {
      await loaded;
      const task = find(id);
      if (running.has(id)) throw new BridgeError("This automation is running now", 409);
      return run(task, null);
    },
    busy: () => running.size > 0,
    async close() {
      closed = true;
      if (timer) timers.clear(timer);
      await Promise.allSettled(running.values());
      await writing;
    },
  };
}
