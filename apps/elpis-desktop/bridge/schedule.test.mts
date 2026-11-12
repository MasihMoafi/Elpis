// Automations: when a rule runs next, and that a due task sends its prompt where it says, once per due time.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeRule, legacyRule, nextRun, parseRule } from "./schedule-rules.mts";
import { createSchedule } from "./schedule.mts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
/** A rule in UTC from its start and RRULE body, as the form writes it. */
const rule = (start: string, body: string, zone = "UTC") => `DTSTART;TZID=${zone}:${start}\nRRULE:${body}`;
const runs = (text: string, from: number, count: number) => {
  const found = [];
  for (let t: number | null = from; found.length < count;) {
    t = nextRun(text, t!);
    if (t === null) break;
    found.push(new Date(t).toISOString().slice(0, 16));
  }
  return found;
};

test("each preset finds its next time, strictly after the given moment", () => {
  const wed = at(2026, 11, 4, 10); // a Wednesday, 10:00 UTC
  assert.equal(nextRun(rule("20261101T090000", "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0"), wed), at(2026, 11, 5, 9));
  assert.equal(
    nextRun(rule("20261101T100000", "FREQ=DAILY"), wed),
    at(2026, 11, 5, 10),
    'the same minute is not "after"',
  );
  assert.equal(
    nextRun(rule("20261101T090000", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), at(2026, 11, 6, 12)),
    at(2026, 11, 9, 9),
    "Friday noon -> Monday",
  );
  assert.equal(
    nextRun(rule("20261101T083000", "FREQ=WEEKLY;BYDAY=SU,TU"), wed),
    at(2026, 11, 8, 8, 30),
    "Sunday comes before next Tuesday",
  );
  assert.deepEqual(
    runs(rule("20260131T090000", "FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1"), at(2026, 2, 1), 2),
    ["2026-02-28T09:00", "2026-03-31T09:00"],
    "a short month runs on its last day",
  );
  assert.equal(nextRun(rule("20261104T110000", "FREQ=DAILY;COUNT=1"), wed), at(2026, 11, 4, 11));
  assert.equal(
    nextRun(rule("20261104T090000", "FREQ=DAILY;COUNT=1"), wed),
    null,
    "a past one-time rule has no next run",
  );
  assert.equal(
    nextRun(rule("20261104T100000", "FREQ=MINUTELY;INTERVAL=90"), wed + 100 * 60_000),
    wed + 180 * 60_000,
    "every 90 minutes from its start",
  );
  assert.equal(
    describeRule(rule("20261101T090000", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Asia/Tehran")),
    "Every weekday at 09:00 (Asia/Tehran)",
  );
});

test("a zone keeps its local clock across daylight saving: a skipped time is skipped, a repeated one runs once", () => {
  assert.equal(
    nextRun(rule("20261106T090000", "FREQ=DAILY", "Asia/Tehran"), at(2026, 11, 6, 4)),
    at(2026, 11, 6, 5, 30),
    "09:00 in Tehran is 05:30 UTC",
  );
  // Berlin: 28 Mar 2027 has no 02:30; 25 Oct 2026 has two.
  assert.deepEqual(runs(rule("20270320T023000", "FREQ=DAILY", "Europe/Berlin"), at(2027, 3, 26), 3), [
    "2027-03-26T01:30",
    "2027-03-27T01:30",
    "2027-03-29T00:30",
  ]);
  assert.deepEqual(runs(rule("20261020T023000", "FREQ=DAILY", "Europe/Berlin"), at(2026, 10, 24), 3), [
    "2026-10-24T00:30",
    "2026-10-25T00:30",
    "2026-10-26T01:30",
  ]);
});

test("rules that cannot run are refused with what is wrong", () => {
  for (const [text, message] of [
    ["FREQ=DAILY", /DTSTART line/],
    [rule("20261101T090000", "FREQ=SECONDLY"), /FREQ/],
    [rule("20261101T090000", "FREQ=DAILY;INTERVAL=0"), /INTERVAL/],
    [rule("20261101T090000", "FREQ=DAILY", "Mars/Olympus"), /time zone/],
    [{ kind: "daily" }, /when the automation runs/],
  ] as [unknown, RegExp][])
    assert.throws(() => parseRule(text), message);
  assert.equal(
    legacyRule({ kind: "weekdays", time: "09:30" }, at(2026, 11, 4), "UTC"),
    rule("20261104T093000", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
    "a rule saved before 6 Nov is read as RRULE",
  );
});

/** `models`: the current model list, per connection ("" is the engine's own list); `providers`: the subscriptions. */
function harness(
  start: number,
  { models = {}, providers = {} }: { models?: Record<string, string[]>; providers?: object } = {},
) {
  let clock = start,
    pending: { fn: () => void; due: number } | null = null;
  const sent: { id: string; text: string; automatic: boolean }[] = [],
    sends: Record<string, unknown>[] = [],
    made: { id: string; cwd?: string; name: string; automatic: boolean; model?: string; provider?: string }[] = [];
  const client = {
    async createThread(body: { cwd?: string; name: string; automatic: boolean }) {
      const id = `chat-${made.length + 1}`;
      made.push({ id, ...body });
      return { thread: { id } };
    },
    async send(id: string, body: { text: string; automatic: boolean }) {
      sent.push({ id, text: body.text, automatic: body.automatic });
      sends.push({ id, ...body });
    },
    async models(options: { provider?: string } = {}) {
      const listed = models[options.provider ?? ""];
      if (!listed) throw new Error("This connection needs a saved API address before Elpis can list its models.");
      return { data: listed.map(model => ({ model })) };
    },
    async providers() {
      return providers;
    },
  };
  const timers = {
    set(fn: () => void, ms: number) {
      pending = { fn, due: clock + ms };
      return pending;
    },
    clear(handle: object) {
      if (pending === handle) pending = null;
    },
  };
  return {
    client,
    timers,
    sent,
    sends,
    made,
    now: () => clock,
    /** Moves the clock and fires the timer if it came due; waits for the run to finish. */
    async advance(to: number) {
      clock = to;
      const due = pending;
      if (due && due.due <= clock) {
        pending = null;
        due.fn();
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}

test("a due task sends its prompt into one kept chat, and a missed stretch is one run", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const task = await schedule.create({
    title: "Morning check",
    prompt: "Check the build",
    rule: rule("20261101T090000", "FREQ=DAILY"),
    target: "reuse",
  });
  assert.equal(task.nextRunAt, at(2026, 11, 4, 9));
  await h.advance(at(2026, 11, 4, 8, 59));
  assert.equal(h.sent.length, 0, "nothing before its time");
  await h.advance(at(2026, 11, 4, 9, 0));
  assert.deepEqual(h.sent, [{ id: "chat-1", text: "Check the build", automatic: true }]);
  // Three days pass with the computer asleep: one run, then the next is tomorrow.
  await h.advance(at(2026, 11, 7, 12, 0));
  assert.deepEqual(
    h.sent.map(item => item.id),
    ["chat-1", "chat-1"],
    "the same chat, and one run for the missed days",
  );
  assert.equal(h.made.length, 1);
  const [saved] = await schedule.list();
  assert.equal(saved!.nextRunAt, at(2026, 11, 8, 9));
  assert.equal(saved!.runs.length, 2);
  await schedule.close();
  // Kept across restarts.
  const again = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  assert.equal((await again.list())[0]!.threadId, "chat-1");
  await again.close();
});

test("a new chat every run, a one-time task ends, and a paused task does not run", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const once = await schedule.create({
    title: "Report",
    prompt: "Write the report",
    cwd: "/tmp",
    rule: rule("20261104T083000", "FREQ=DAILY;COUNT=1"),
    target: "new",
  });
  const paused = await schedule.create({
    title: "Quiet",
    prompt: "Never",
    rule: rule("20261104T080000", "FREQ=MINUTELY;INTERVAL=10"),
  });
  await schedule.update(paused.id, { status: "paused" });
  await h.advance(at(2026, 11, 4, 8, 45));
  assert.deepEqual(
    h.sent.map(item => item.text),
    ["Write the report"],
    "the paused task sent nothing",
  );
  assert.equal(h.made[0]!.cwd, "/tmp");
  assert.equal(h.made[0]!.name, "Report");
  assert.equal((await schedule.list()).find(task => task.id === once.id)!.status, "ended");
  // Run now sends once and keeps the schedule.
  await schedule.runNow(once.id);
  assert.equal(h.made.length, 2, "a new chat again");
  await assert.rejects(
    schedule.create({ title: "Late", prompt: "x", rule: rule("20261104T080000", "FREQ=DAILY;COUNT=1") }),
    /already passed/,
  );
  await schedule.close();
});

// 12 Nov, Masih, setting his daily automations: "whichever but mostly codex models and never anthropic's", and Codex Sol
// for two of them. A task with a model starts its chat on it and never on the app's default of the day.
test("a task with a model starts its chat on that model and effort; a kept chat keeps its own model", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const h = harness(at(2026, 11, 4, 8, 0), { models: { openai: ["gpt-6.1-sol", "gpt-6-luna"] } });
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const sol = { model: "gpt-6.1-sol", provider: "openai", effort: "high" };
  const fresh = await schedule.create({ title: "Jobs", prompt: "Find jobs", rule: rule("20261101T090000", "FREQ=DAILY"), target: "new", ...sol });
  assert.deepEqual([fresh.model, fresh.provider, fresh.effort], ["gpt-6.1-sol", "openai", "high"], "the task keeps its model");
  await schedule.runNow(fresh.id);
  assert.equal(h.made[0]!.model, "gpt-6.1-sol");
  assert.equal(h.made[0]!.provider, "openai");
  assert.equal(h.sends[0]!.effort, "high", "the first message carries the effort");

  const kept = await schedule.create({ title: "Outreach", prompt: "Write to one lab", rule: rule("20261101T090000", "FREQ=DAILY"), target: "reuse", ...sol });
  await schedule.runNow(kept.id);
  await schedule.runNow(kept.id);
  assert.equal(h.made.length, 2, "one chat for the kept task");
  assert.equal(h.made[1]!.model, "gpt-6.1-sol", "its first run starts the chat on the model");
  assert.equal(h.sends[2]!.effort, undefined, "a later run leaves the chat's model and effort alone");
  assert.equal(h.sends[2]!.model, undefined);

  // An agent's "remind me here": the chat already exists, so the run sends into it as it is.
  const here = await schedule.create({
    title: "Here",
    prompt: "Check in",
    rule: rule("20261101T090000", "FREQ=DAILY"),
    threadId: "00000000-0000-4000-8000-0000000000aa",
    ...sol,
  });
  await schedule.runNow(here.id);
  assert.equal(h.made.length, 2, "no new chat");
  assert.deepEqual([h.sends[3]!.model, h.sends[3]!.effort], [undefined, undefined]);

  // Clearing the model returns the task to the app's default.
  const cleared = await schedule.update(fresh.id, { model: null });
  assert.deepEqual([cleared.model, cleared.provider, cleared.effort], [null, null, null]);
  await schedule.close();
});

test("a task whose model cannot run records a failed run that names it, and starts no chat", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const usage = [{ primary: { usedPercent: 100, resetsAt: null }, secondary: null, credits: null }];
  const h = harness(at(2026, 11, 4, 8, 0), {
    models: { "": ["claude/opus"], openai: ["gpt-6.1-sol"] },
    providers: { claude: { state: "connected", usage } },
  });
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const daily = rule("20261101T090000", "FREQ=DAILY");
  // Listed when he chose it, gone from the list by the time it runs.
  const gone = await schedule.create({ title: "Jobs", prompt: "Find jobs", rule: daily, target: "new", model: "gpt-6.1-sol", provider: "openai" });
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/gpt-6\.1-sol/g, "gpt-5-retired"));
  const reread = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const failed = await reread.runNow(gone.id);
  assert.equal(
    failed.runs[0]!.error,
    "gpt-5-retired on ChatGPT did not run because it is not in the current model list; choose another model for this automation.",
  );
  assert.equal(failed.runs[0]!.threadId, null);
  // A subscription whose plan limit is reached: the line item 63 uses, not a run on another model.
  const opus = await reread.create({ title: "Review", prompt: "Review", rule: daily, target: "new", model: "claude/opus" });
  const stopped = await reread.runNow(opus.id);
  assert.equal(
    stopped.runs[0]!.error,
    "claude/opus on Claude did not run because the Claude usage limit is reached; wait for the reset, or choose another model for this automation.",
  );
  assert.equal(h.made.length, 0, "no chat was started on any model");
  assert.equal(h.sent.length, 0);
  // An agent's typo is refused when the task is made, with the reason.
  await assert.rejects(
    reread.create({ title: "x", prompt: "x", rule: daily, model: "codex-sol", provider: "openai" }),
    /codex-sol on ChatGPT .* not in the current model list/,
  );
  await assert.rejects(reread.create({ title: "x", prompt: "x", rule: daily, effort: "high" }), /Choose a model/);
  await schedule.close();
  await reread.close();
});

test("a task saved before automations had a model still runs on the app's default", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const old = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Morning check",
    prompt: "Check the build",
    cwd: null,
    rule: { kind: "daily", time: "09:00" },
    target: "new",
    status: "active",
    threadId: null,
    runs: [],
    lastRunAt: null,
    nextRunAt: at(2026, 11, 4, 9),
    createdAt: at(2026, 11, 1),
    updatedAt: at(2026, 11, 1),
  };
  await fs.writeFile(file, JSON.stringify({ version: 1, tasks: [old] }));
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const ran = await schedule.runNow(old.id);
  assert.equal(ran.runs[0]!.error, null);
  assert.equal(ran.model ?? null, null);
  assert.equal("model" in h.made[0]!, false, "the chat starts on the app's default");
  assert.equal("effort" in h.sends[0]!, false);
  await schedule.close();
});

test("the agents' tools take a model, its provider and effort, and the list shows them", async () => {
  const { callTool, tools } = await import("./schedule-mcp.mts");
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const h = harness(at(2026, 11, 4, 8, 0), { models: { openai: ["gpt-6.1-sol", "gpt-6-luna"] } });
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  const request = (async (route: string, body?: Record<string, unknown>) => {
    if (route === "/api/automations") return body ? schedule.create(body) : { data: await schedule.list() };
    const { action: _action, ...fields } = body!;
    return schedule.update(route.split("/").pop()!, fields);
  }) as unknown as Parameters<typeof callTool>[3];
  for (const name of ["automation_create", "automation_update"]) {
    const properties = tools.find(tool => tool.name === name)!.inputSchema.properties as Record<string, unknown>;
    assert.ok(properties.model && properties.provider && properties.effort, `${name} takes model, provider and effort`);
  }
  const { created } = await callTool(
    "automation_create",
    {
      title: "Jobs",
      prompt: "Find jobs",
      rule: rule("20261101T090000", "FREQ=DAILY"),
      target: "new_chat",
      model: "gpt-6.1-sol",
      provider: "openai",
      effort: "high",
    },
    undefined,
    request,
  );
  assert.deepEqual([created!.model, created!.provider, created!.effort], ["gpt-6.1-sol", "openai", "high"]);
  await callTool("automation_update", { id: created!.id, action: "update", model: "gpt-6-luna", provider: "openai", effort: "medium" }, undefined, request);
  const { automations } = await callTool("automation_list", {}, undefined, request);
  assert.deepEqual([automations![0]!.model, automations![0]!.provider, automations![0]!.effort], ["gpt-6-luna", "openai", "medium"]);
  await schedule.close();
});

test("a chat's one sentence becomes a task: the tools create into this chat, list, pause and delete", async () => {
  const { callTool } = await import("./schedule-mcp.mts");
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const h = harness(at(2026, 11, 4, 8, 0));
  const schedule = createSchedule({ client: h.client, file, now: h.now, timers: h.timers });
  // The app's routes, as bridge/server.mts maps them.
  const request = (async (route: string, body?: Record<string, unknown>) => {
    if (route === "/api/automations") return body ? schedule.create(body) : { data: await schedule.list() };
    const id = route.split("/").pop()!,
      { action, ...fields } = body!;
    return action === "delete" ? schedule.remove(id) : schedule.update(id, fields);
  }) as unknown as Parameters<typeof callTool>[3];
  const here = "00000000-0000-4000-8000-0000000000aa";
  const { created } = await callTool(
    "automation_create",
    {
      title: "Stand-up",
      prompt: "What changed since yesterday?",
      rule: rule("20261101T093000", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
      target: "this_chat",
    },
    here,
    request,
  );
  assert.ok(created);
  assert.equal(created.when, "Every weekday at 09:30 (UTC)");
  await h.advance(at(2026, 11, 4, 9, 30));
  assert.deepEqual(
    h.sent,
    [{ id: here, text: "What changed since yesterday?", automatic: true }],
    "sent into the chat that asked, without a new one",
  );
  assert.equal(h.made.length, 0);
  const listed = await callTool("automation_list", {}, here, request);
  assert.ok(listed.automations);
  assert.equal(listed.automations.length, 1);
  assert.equal(
    (await callTool("automation_update", { id: created.id, action: "pause" }, here, request)).updated!.status,
    "paused",
  );
  await callTool("automation_update", { id: created.id, action: "delete" }, here, request);
  assert.equal((await schedule.list()).length, 0);
  await assert.rejects(
    callTool(
      "automation_create",
      { title: "x", prompt: "x", rule: rule("20261101T090000", "FREQ=DAILY"), target: "this_chat" },
      undefined,
      request,
    ),
    /one_chat/,
  );
  await schedule.close();
});

test("the Automations key opens /api/automations and no other route", async t => {
  const { startDesktopServer } = await import("./server.mts");
  const { EventEmitter } = await import("node:events");
  const bus = new EventEmitter();
  const client = {
    connected: true,
    pendingApprovals: [],
    close() {},
    on: (n: string, l: (...args: unknown[]) => void) => bus.on(n, l),
    off: (n: string, l: (...args: unknown[]) => void) => bus.off(n, l),
    ragEnvironment: async () => ({}),
    async listThreads() {
      return { data: [], nextCursor: null };
    },
  };
  const automationsFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const app = await startDesktopServer({ client, staticDir: "/tmp", automationsFile });
  t.after(() => app.close());
  const { url, key } = app.automationAccess!;
  const headers = { "x-elpis-automations": key, "content-type": "application/json" };
  const made = await fetch(`${url}/api/automations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "T", prompt: "P", rule: rule("20261101T090000", "FREQ=DAILY") }),
  });
  assert.equal(made.status, 201);
  assert.equal((await (await fetch(`${url}/api/automations`, { headers })).json()).data.length, 1);
  assert.equal((await fetch(`${url}/api/threads`, { headers })).status, 401, "the key is not a session");
  assert.equal((await fetch(`${url}/api/automations`, { headers: { "x-elpis-automations": "wrong" } })).status, 401);
  const off = await startDesktopServer({ client, staticDir: "/tmp" });
  t.after(() => off.close());
  assert.equal(off.automationAccess, null, "without a file, a test or window has no automations");
});

test("a scheduled workflow is offered to the open windows: one claims it and reports its chat; unclaimed, it is missed", async t => {
  const { startDesktopServer } = await import("./server.mts");
  const { EventEmitter } = await import("node:events");
  const bus = new EventEmitter();
  const client = {
    connected: true,
    pendingApprovals: [],
    close() {},
    on: (n: string, l: (...args: unknown[]) => void) => bus.on(n, l),
    off: (n: string, l: (...args: unknown[]) => void) => bus.off(n, l),
    ragEnvironment: async () => ({}),
    async listThreads() {
      return { data: [], nextCursor: null };
    },
  };
  const automationsFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-schedule-")), "tasks.json");
  const app = await startDesktopServer({ client, staticDir: "/tmp", automationsFile, workflowClaimWait: 300 });
  t.after(() => app.close());
  const { url, key } = app.automationAccess!;
  const post = (route: string, body: unknown) =>
    fetch(`${url}${route}`, {
      method: "POST",
      headers: { "x-elpis-automations": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(response => response.json());
  // A window's event stream, as the page opens it.
  const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get("token");
  const session = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ token }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const stream = await fetch(`${url}/api/events`, { headers: { Cookie: cookie } });
  const reader = stream.body!.getReader(),
    decoder = new TextDecoder();
  let buffered = "";
  const nextOffer = async () => {
    for (;;) {
      const match = /event: automationWorkflow\ndata: (.*)\n\n/.exec(buffered);
      if (match) {
        buffered = buffered.slice(match.index + match[0].length);
        return JSON.parse(match[1]!);
      }
      const { value } = await reader.read();
      buffered += decoder.decode(value);
    }
  };
  t.after(() => reader.cancel());
  const board = { name: "Review", nodes: [{ id: "m", type: "mother" }], edges: [] };
  const task = await post("/api/automations", {
    title: "Review",
    prompt: "Review the PRs",
    rule: rule("20261101T090000", "FREQ=DAILY"),
    workflow: { id: "wf-1", name: "Review", board },
  });
  assert.deepEqual(task.workflow, { id: "wf-1", name: "Review" }, "the list never carries the board");

  // Claimed by one window, which reports the run's chat; a second claim is refused.
  const ran = post(`/api/automations/${task.id}`, { action: "run" });
  const offer = await nextOffer();
  assert.deepEqual(offer.board, board, "the window receives the saved board");
  assert.equal(offer.request, "Review the PRs");
  assert.deepEqual(await post(`/api/automations/${task.id}`, { action: "claim", token: offer.token }), {
    granted: true,
  });
  assert.deepEqual(
    await post(`/api/automations/${task.id}`, { action: "claim", token: offer.token }),
    { granted: false },
    "one window runs it",
  );
  await post(`/api/automations/${task.id}`, { action: "result", token: offer.token, threadId: "root-chat-1" });
  assert.equal((await ran).runs[0].threadId, "root-chat-1");

  // Nobody claims it: the run is recorded as missed.
  const missed = post(`/api/automations/${task.id}`, { action: "run" });
  await nextOffer();
  assert.match((await missed).runs[0].error, /No Elpis window was open/);
});
