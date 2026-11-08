import test from "node:test";
import assert from "node:assert/strict";
import { BridgeError } from "./client.mts";
import { planCanvas } from "./canvas-plan.mts";
import { THREAD, FOLDERS, PLAN, BODY, fakeClient, plan, refused, mutate, engine, session } from "./canvas-plan.fixtures.mts";

test("refuses a request it cannot plan from before starting anything", async () => {
  const cases: [unknown, RegExp][] = [
    [{ ...BODY, goal: "" }, /goal/i],
    [{ ...BODY, goal: 5 }, /goal/i],
    [{ ...BODY, goal: "x".repeat(8001) }, /goal/i],
    [{ ...BODY, maxAgents: 0 }, /maxAgents/],
    [{ ...BODY, maxAgents: 2.5 }, /maxAgents/],
    [{ ...BODY, maxAgents: "4" }, /maxAgents/],
    [{ ...BODY, maxAgents: 129 }, /maxAgents/],
    [{ goal: "x" }, /maxAgents/],
    [{ ...BODY, cwd: "relative/dir" }, /absolute/i],
    [{ ...BODY, cwd: 5 }, /working directory/i],
    [{ ...BODY, folders: "api" }, /folders/i],
    [{ ...BODY, folders: [5] }, /folder/i],
    [{ ...BODY, folders: ["/etc"] }, /relative/i],
    [{ ...BODY, folders: ["a/../../b"] }, /relative/i],
    [{ ...BODY, folders: ["a\\b"] }, /relative/i],
    [{ ...BODY, agents: "none" }, /agents/i],
    [{ ...BODY, agents: [{ key: "a" }] }, /agents/i],
    [
      { ...BODY, agents: [{ key: "a", title: "t", prompt: "p", folders: "x", doneWhen: [], waitsFor: [] }] },
      /folders/i,
    ],
    [
      { ...BODY, agents: [{ key: "a", title: "t", prompt: "p", folders: [], doneWhen: "x", waitsFor: [] }] },
      /doneWhen/i,
    ],
    [
      { ...BODY, agents: [{ key: "a", title: "t", prompt: "p", folders: [], doneWhen: [], waitsFor: [], role: "x" }] },
      /Unsupported request fields/,
    ],
    [
      {
        ...BODY,
        agents: [
          { key: "a", title: "t", prompt: "p", folders: [], doneWhen: [], waitsFor: [] },
          { key: "a", title: "t", prompt: "p", folders: [], doneWhen: [], waitsFor: [] },
        ],
      },
      /same key/i,
    ],
    [{ ...BODY, extra: true }, /Unsupported request fields/],
    [null, /Unsupported request fields/],
  ];
  for (const [body, pattern] of cases) {
    const client = fakeClient();
    await refused(planCanvas(client, body), 400, pattern);
    assert.equal(client.sent.length, 0, `nothing started for ${JSON.stringify(body)?.slice(0, 80)}`);
  }
});

test("a client that lists folders but no agents and no cwd still plans", async () => {
  const { client, result } = await plan({}, {}, { goal: "Build a small notes app", folders: FOLDERS, maxAgents: 3 });
  assert.deepEqual(result, PLAN);
  assert.equal("cwd" in client.sent.find(row => row.method === "thread/start")!.params, false);
});

test("sideRpc starts only ephemeral conversations and keeps them out of the app's events", async t => {
  const { client, socket, events, side, notify } = engine();
  t.after(() => client.close());
  await client.sideRpc("thread/start", { cwd: "/work" });
  assert.equal(socket.sent.at(-1)!.params.ephemeral, true, "always ephemeral");
  notify("thread/started", { thread: { id: THREAD } });
  notify("thread/status/changed", { threadId: THREAD, status: { type: "active" } });
  notify("turn/completed", { threadId: THREAD, turn: { id: "t1", status: "completed" } });
  assert.deepEqual(
    side.map(row => row.method),
    ["thread/started", "thread/status/changed", "turn/completed"],
  );
  assert.deepEqual(
    events.filter(row => row.type === "message"),
    [],
    "the app is told nothing",
  );
  const other = "00000000-0000-0000-0000-0000000000b2";
  notify("thread/started", { thread: { id: other } });
  assert.equal(
    events.filter(row => row.type === "message" && row.data.method === "thread/started").length,
    1,
    "other chats are still announced",
  );
  assert.equal(side.length, 3);
});

test("sideRpc allows only the planner's requests, and only on its own conversations", async t => {
  const { client, socket } = engine();
  t.after(() => client.close());
  await assert.rejects(client.sideRpc("thread/list", {}), BridgeError);
  await assert.rejects(
    client.sideRpc("turn/start", { threadId: THREAD, input: [] }),
    BridgeError,
    "a conversation it did not start",
  );
  await client.sideRpc("thread/start", {});
  await client.sideRpc("turn/start", { threadId: THREAD, input: [] });
  await client.sideRpc("turn/interrupt", { threadId: THREAD, turnId: "t1" });
  await client.sideRpc("thread/unsubscribe", { threadId: THREAD });
  assert.deepEqual(
    socket.sent.filter(row => row.method !== "initialize").map(row => row.method),
    ["thread/start", "turn/start", "turn/interrupt", "thread/unsubscribe"],
  );
  await assert.rejects(
    client.sideRpc("thread/delete", { threadId: "00000000-0000-0000-0000-0000000000b3" }),
    BridgeError,
  );
});

test("a closed side conversation is forgotten", async t => {
  const { client, side, events, notify } = engine();
  t.after(() => client.close());
  await client.sideRpc("thread/start", {});
  notify("thread/closed", { threadId: THREAD });
  assert.deepEqual(
    side.map(row => row.method),
    ["thread/closed"],
  );
  notify("thread/status/changed", { threadId: THREAD, status: { type: "idle" } });
  assert.equal(side.length, 1);
  assert.equal(events.filter(row => row.type === "message").length, 1, "later news about it is the app's again");
});

test("POST /api/canvas/plan needs the session, answers the plan, and explains a refusal", async t => {
  const client = fakeClient();
  const { cookie, post, origin } = await session(t, client);
  assert.equal((await post(BODY)).status, 401);
  assert.equal(client.sent.length, 0);
  const ok = await post(BODY, { Cookie: cookie });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), PLAN);
  const bad = await post({ ...BODY, maxAgents: 0 }, { Cookie: cookie });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /maxAgents/);
  const sizes = fakeClient({
    answer: mutate(plan => {
      plan.agents[0]!.folders = ["secrets"];
    }),
  });
  const second = await session(t, sizes);
  const refusedPlan = await second.post(BODY, { Cookie: second.cookie });
  assert.equal(refusedPlan.status, 502);
  assert.match((await refusedPlan.json()).error, /not in the project's folder list/);
  const get = await fetch(`${origin}/api/canvas/plan`, { headers: { Cookie: cookie } });
  assert.notEqual(get.status, 200);
});

test("a stopped design ends without trying the fallback model", async () => {
  const stop = new AbortController();
  stop.abort();
  let calls = 0;
  const client = {
    settings: async () => {
      calls++;
      return { main: { model: "m" } };
    },
    sideRpc: async () => {
      calls++;
      return {};
    },
    on() {},
    off() {},
  };
  await assert.rejects(planCanvas(client as never, BODY, { signal: stop.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});
