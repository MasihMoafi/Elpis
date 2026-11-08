import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BridgeError, DesktopClient } from "./client.mts";
import { planCanvas, PLAN_SCHEMA } from "./canvas-plan.mts";
import type { TestContext } from "node:test";
import { startDesktopServer } from "./server.mts";

export const THREAD = "00000000-0000-0000-0000-0000000000a1";

export const FOLDERS = ["api", "docs", "web", "web/components"];

export const WHY = "Two independent parts, the API and the screen.";

export const PLAN = {
  name: "Notes app",
  mode: "team",
  why: WHY,
  agents: [
    {
      key: "api",
      title: "Build the notes API",
      prompt: "Add the notes endpoints in api/ with their tests.",
      folders: ["api"],
      doneWhen: ["the API tests pass"],
      waitsFor: [],
    },
    {
      key: "web",
      title: "Build the notes screen",
      prompt: "Add the notes screen in web/ with its tests.",
      folders: ["web"],
      doneWhen: ["the screen lists notes"],
      waitsFor: ["api"],
    },
  ],
};

export const BODY = { goal: "Build a small notes app", cwd: "/work/project", folders: FOLDERS, agents: [], maxAgents: 4 };

export type WireParams = {
  threadId: string;
  input: { type: string; text: string }[];
  outputSchema: typeof PLAN_SCHEMA;
  ephemeral: boolean;
  [key: string]: unknown;
};

export type WireMessage = { method: string; params: WireParams; id?: number };

export type InvalidPlan = {
  name?: unknown;
  mode?: unknown;
  why?: unknown;
  agents: Record<string, unknown>[];
  [key: string]: unknown;
};

export type FakeOptions = {
  background?: { model: string | null; provider: string | null };
  main?: { model: string | null; provider: string | null };
  answer?: unknown;
  status?: string;
  error?: string;
  ephemeral?: boolean;
  silent?: boolean;
  extra?: unknown[];
};

export const clone = <T,>(value: T): T => structuredClone(value);

/** A client with a fake engine: the settings, `sideRpc` and the 'side' notifications the planner uses. */
export function fakeClient({
  background = { model: "fast-model", provider: "local" },
  main = { model: "big-model", provider: "openai" },
  answer = PLAN,
  status = "completed",
  error,
  ephemeral = true,
  silent = false,
  extra = [],
}: FakeOptions = {}) {
  const bus = new EventEmitter(),
    sent: WireMessage[] = [];
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  const side = (method: string, params: unknown) => bus.emit("side", { method, params });
  const fake = {
    sent,
    bus,
    connected: true,
    pendingApprovals: [],
    close() {},
    ragEnvironment: async () => ({}),
    on: (name: string, listener: (...args: unknown[]) => void) => bus.on(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => bus.off(name, listener),
    settings: async () => ({ main, background }),
    async sideRpc(method: string, params: unknown) {
      sent.push({ method, params: params as WireParams });
      if (method === "thread/start") return { thread: { id: THREAD, ephemeral }, model: "m", modelProvider: "p" };
      if (method === "turn/start") {
        // The engine may answer before the turn/start response is read.
        if (!silent)
          queueMicrotask(() => {
            for (const item of extra) side("item/completed", { threadId: THREAD, turnId: "t1", item });
            side("item/completed", {
              threadId: THREAD,
              turnId: "t1",
              item: { type: "agentMessage", id: "final", text, phase: "final_answer" },
            });
            side("turn/completed", {
              threadId: THREAD,
              turn: { id: "t1", status, items: [], ...(error ? { error: { message: error } } : {}) },
            });
          });
        return { turn: { id: "t1", status: "inProgress", items: [] } };
      }
      return {};
    },
    methods: () => sent.map(row => row.method),
  };
  return fake as unknown as typeof fake & Parameters<typeof planCanvas>[0];
}

export const plan = async (overrides: FakeOptions = {}, options = {}, body: unknown = BODY) => {
  const client = fakeClient(overrides);
  return { client, result: await planCanvas(client, body, options) };
};

export const refused = (promise: Promise<unknown>, status: number, pattern: RegExp) =>
  assert.rejects(
    promise,
    error => error instanceof BridgeError && error.status === status && pattern.test(error.message),
    String(pattern),
  );

// 28 Oct: Mother decides first. A simple task she does herself, as the one agent whose prompt is the task; a complex one becomes a team.
export const DIRECT = {
  name: "Hello file",
  mode: "direct",
  why: "One file, one line: no team needed.",
  agents: [
    {
      key: "hello",
      title: "Write hello.txt",
      prompt: "Create hello.txt in the project root.",
      folders: ["."],
      doneWhen: ["hello.txt exists"],
      waitsFor: [],
    },
  ],
};

export const mutate = (change: (plan: InvalidPlan) => void) => {
  const copy = clone(PLAN) as InvalidPlan;
  change(copy);
  return copy;
};

export const REFUSALS: [string, unknown, RegExp][] = [
  ["an answer that is not JSON", "sorry, I cannot", /not valid JSON/],
  ["an answer that is not an object", [PLAN], /not valid JSON|must be an object/],
  [
    "an unknown field on the plan",
    mutate(plan => {
      plan.extra = 1;
    }),
    /unknown field "extra"/,
  ],
  [
    "an unknown field on an agent",
    mutate(plan => {
      plan.agents[0]!.role = "tester";
    }),
    /Agent "api".*unknown field "role"/,
  ],
  [
    "a missing field on an agent",
    mutate(plan => {
      delete plan.agents[1]!.doneWhen;
    }),
    /Agent "web".*doneWhen/,
  ],
  [
    "a missing name",
    mutate(plan => {
      plan.name = " ";
    }),
    /name/,
  ],
  [
    "a missing mode",
    mutate(plan => {
      delete plan.mode;
    }),
    /mode/,
  ],
  [
    "a mode that is neither direct nor team",
    mutate(plan => {
      plan.mode = "solo";
    }),
    /mode/,
  ],
  [
    "a missing why",
    mutate(plan => {
      plan.why = "";
    }),
    /why/,
  ],
  [
    "no agents",
    mutate(plan => {
      plan.agents = [];
    }),
    /no agents/,
  ],
  [
    "more agents than maxAgents",
    {
      name: "Big",
      mode: "team",
      why: WHY,
      agents: ["a", "b", "c", "d"].map(key => ({
        key,
        title: key,
        prompt: "Work.",
        folders: ["api"],
        doneWhen: [],
        waitsFor: [],
      })),
    },
    /4 agents.*limit is 3/,
  ],
  [
    "a folder that is not in the list",
    mutate(plan => {
      plan.agents[0]!.folders = ["api", "secrets"];
    }),
    /"api".*"secrets".*not in the project's folder list/,
  ],
  [
    "an agent without a prompt",
    mutate(plan => {
      plan.agents[0]!.prompt = "";
    }),
    /Agent "api".*prompt/,
  ],
  [
    "an agent without a title",
    mutate(plan => {
      plan.agents[0]!.title = " ";
    }),
    /Agent "api".*title/,
  ],
  [
    "a wrong type",
    mutate(plan => {
      plan.agents[0]!.waitsFor = "web";
    }),
    /Agent "api".*waitsFor/,
  ],
  [
    "two agents with one key",
    mutate(plan => {
      plan.agents[1]!.key = "api";
    }),
    /same key "api"|share the key "api"/,
  ],
  [
    "a wait for a key that is not in the plan",
    mutate(plan => {
      plan.agents[1]!.waitsFor = ["nope"];
    }),
    /"web" waits for "nope"/,
  ],
  [
    "an agent that waits for itself",
    mutate(plan => {
      plan.agents[0]!.waitsFor = ["api"];
    }),
    /loop.*api -> api/,
  ],
  [
    "a loop between two agents",
    mutate(plan => {
      plan.agents[0]!.waitsFor = ["web"];
    }),
    /loop.*(api -> web -> api|web -> api -> web)/,
  ],
  [
    "a loop through three agents",
    {
      name: "Ring",
      mode: "team",
      why: WHY,
      agents: [
        ["a", "c"],
        ["b", "a"],
        ["c", "b"],
      ].map(([key, waits]) => ({
        key,
        title: key,
        prompt: "Work.",
        folders: ["api"],
        doneWhen: [],
        waitsFor: [waits],
      })),
    },
    /loop/,
  ],
];

/** The real client with a fake engine socket: side conversations stay out of the app's events. */
export function engine() {
  const socket = Object.assign(new EventEmitter(), {
    sent: [] as WireMessage[],
    send: (_raw: string) => {},
    close: () => {},
  });
  const reply = (id: unknown, result: unknown) =>
    queueMicrotask(() => socket.emit("message", JSON.stringify({ id, result })));
  socket.send = (raw: string) => {
    const request = JSON.parse(raw);
    socket.sent.push(request);
    if (request.id === undefined) return;
    reply(
      request.id,
      request.method === "thread/start"
        ? { thread: { id: THREAD, ephemeral: request.params.ephemeral === true } }
        : request.method === "turn/start"
          ? { turn: { id: "t1", status: "inProgress", items: [] } }
          : {},
    );
  };
  socket.close = () => socket.emit("close");
  const client = new DesktopClient(socket);
  const events: { type: string; data: { method: string } }[] = [],
    side: { method: string }[] = [];
  client.on("event", value => events.push(value as { type: string; data: { method: string } }));
  client.on("side", value => side.push(value as { method: string }));
  const notify = (method: string, params: unknown) => socket.emit("message", JSON.stringify({ method, params }));
  return { client, socket, events, side, notify };
}

export async function session(t: TestContext, client: ReturnType<typeof fakeClient>) {
  const app = await startDesktopServer({ client, staticDir: "/tmp" });
  t.after(() => app.close());
  const url = new URL(app.url),
    token = new URLSearchParams(url.hash.slice(1)).get("token");
  const auth = await fetch(url.origin + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url.origin },
    body: JSON.stringify({ token }),
  });
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  return {
    origin: url.origin,
    cookie,
    post: (body: unknown, headers = {}) =>
      fetch(`${url.origin}/api/canvas/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: url.origin, ...headers },
        body: JSON.stringify(body),
      }),
  };
}
