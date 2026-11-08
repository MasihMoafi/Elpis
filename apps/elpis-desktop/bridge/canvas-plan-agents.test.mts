import test from "node:test";
import assert from "node:assert/strict";
import { BridgeError } from "./client.mts";
import { planCanvas } from "./canvas-plan.mts";
import { THREAD, FOLDERS, WHY, PLAN, BODY, clone, fakeClient, plan, refused, DIRECT, REFUSALS } from "./canvas-plan.fixtures.mts";

test("plans in one ephemeral, read-only, no-approval conversation on the background model, with a schema for the answer", async () => {
  const { client } = await plan();
  const start = client.sent.find(row => row.method === "thread/start")!.params;
  assert.deepEqual(start, {
    ephemeral: true,
    model: "fast-model",
    modelProvider: "local",
    cwd: "/work/project",
    approvalPolicy: "never",
    permissions: ":danger-full-access",
  });
  const turns = client.sent.filter(row => row.method === "turn/start");
  assert.equal(turns.length, 1, "one turn");
  const params = turns[0]!.params;
  assert.deepEqual(Object.keys(params).sort(), ["input", "outputSchema", "threadId"]);
  assert.equal(params.threadId, THREAD);
  assert.equal(params.input.length, 1);
  assert.equal(params.input[0]!.type, "text");
  const { outputSchema } = params;
  assert.equal(outputSchema.type, "object");
  assert.equal(outputSchema.additionalProperties, false);
  assert.deepEqual(outputSchema.required, ["name", "mode", "why", "agents"]);
  assert.deepEqual(outputSchema.properties.mode, { type: "string", enum: ["direct", "team"] });
  const agent = outputSchema.properties.agents.items;
  assert.equal(agent.additionalProperties, false);
  assert.deepEqual([...agent.required].sort(), [
    "doneWhen",
    "effort",
    "folders",
    "key",
    "model",
    "prompt",
    "title",
    "waitsFor",
  ]);
  assert.deepEqual(Object.keys(agent.properties).sort(), [...agent.required].sort());
});

test("uses the main model when no background model is set, and the engine default when neither is", async () => {
  const fallback = await plan({ background: { model: null, provider: null } });
  const start = fallback.client.sent.find(row => row.method === "thread/start")!.params;
  assert.equal(start.model, "big-model");
  assert.equal(start.modelProvider, "openai");
  const none = await plan({ background: { model: null, provider: null }, main: { model: null, provider: null } });
  const bare = none.client.sent.find(row => row.method === "thread/start")!.params;
  assert.equal("model" in bare, false);
  assert.equal("modelProvider" in bare, false);
  const sameProvider = await plan({ background: { model: "fast-model", provider: null } });
  assert.equal(
    "modelProvider" in sameProvider.client.sent.find(row => row.method === "thread/start")!.params,
    false,
    "a background model without a provider runs on the default provider",
  );
});

test("the prompt carries the goal, the folder list, the limit and the planning rules", async () => {
  const { client } = await plan();
  const prompt = client.sent.find(row => row.method === "turn/start")!.params.input[0]!.text;
  assert.match(prompt, /Build a small notes app/);
  for (const folder of FOLDERS) assert.match(prompt, new RegExp(`^- ${folder}$`, "m"));
  assert.match(prompt, /at most 4 agents/i);
  assert.match(prompt, /Every agent writes/);
  assert.match(prompt, /markdown file in its (own )?folder/i);
  assert.match(prompt, /split by independent parts, not by role/i);
  assert.match(prompt, /its tests/i);
  assert.match(prompt, /never the whole project/i);
  assert.match(prompt, /same time[^.]*not share a folder/i);
  assert.match(prompt, /waitsFor/);
  assert.match(prompt, /no loops/i);
  assert.match(prompt, /6 words/);
  assert.match(prompt, /board is empty/i);
  assert.doesNotMatch(prompt, /Keep every existing agent's key/);
});

test("returns the validated plan as { name, mode, why, agents }", async () => {
  const { result } = await plan();
  assert.deepEqual(result, PLAN);
});

// 3 Nov, Masih: each agent's model and level weigh only its job's complexity, cost and his preferences.
test("the planner chooses each agent a listed model and level, from his subscriptions and preferences", async () => {
  const efforts = (levels: string[]) => levels.map(reasoningEffort => ({ reasoningEffort }));
  const catalog = [
    { model: "gpt-6.1-terra", supportedReasoningEfforts: efforts(["high", "xhigh", "max"]) },
    { model: "gpt-6.1-luna", supportedReasoningEfforts: efforts(["low", "max"]) },
  ];
  const answer = {
    ...PLAN,
    agents: [
      { ...PLAN.agents[0]!, model: "gpt-6.1-terra", effort: "max" },
      { ...PLAN.agents[1]!, model: "gpt-6.1-terra", effort: "ultra" },
    ],
  };
  const client = Object.assign(fakeClient({ answer }), {
    models: async () => ({ data: catalog }),
    providers: async () => ({ openai: { auth: { state: "signedIn", method: "ChatGPT" } } }),
  });
  const settings = client.settings;
  Object.assign(client, {
    settings: async () => ({
      ...(await settings()),
      managed: { available: true, modelProvider: null },
      options: { developerInstructions: "Workflow agents: GPT Terra." },
    }),
  });
  const result = await planCanvas(client, BODY);
  const prompt = client.sent.find(row => row.method === "turn/start")!.params.input[0]!.text;
  const started = client.sent.find(row => row.method === "thread/start")!.params;
  const turn = client.sent.find(row => row.method === "turn/start")!.params;
  assert.deepEqual(
    [started.model, started.modelProvider, started.config, turn.outputSchema],
    ["claude/opus", undefined, { model_reasoning_effort: "medium" }, undefined],
    "the Mother designs the team on Opus 5.5 medium, on the Claude subscription",
  );
  assert.match(
    prompt,
    /matching this JSON Schema:\n\{"type":"object"/,
    "the schema is in the prompt, since the Claude bridge takes no schema parameter",
  );
  assert.match(prompt, /Worked examples/);
  assert.match(prompt, /gpt-6\.1-terra: high, xhigh, max/);
  assert.match(prompt, /Workflow agents: GPT Terra\./);
  assert.match(prompt, /how hard its job is, what it costs .* and the user's preferences/);
  assert.deepEqual(
    result.agents.map(agent => [agent.model, agent.provider, agent.effort]),
    [
      ["gpt-6.1-terra", "openai", "max"],
      ["gpt-6.1-terra", "openai", undefined],
    ],
    "a level the model does not list is dropped",
  );
  const unlisted = Object.assign(
    fakeClient({ answer: { ...PLAN, agents: [{ ...PLAN.agents[0]!, model: "gpt-7" }, PLAN.agents[1]!] } }),
    { models: client.models, providers: client.providers, settings: client.settings },
  );
  assert.equal(
    (await planCanvas(unlisted, BODY)).agents[0]!.model,
    undefined,
    "a model outside his subscriptions is dropped",
  );
});

test("the prompt asks the planner to decide, in the same call, between doing it directly and a team, and to say why", async () => {
  const { client } = await plan();
  const prompt = client.sent.find(row => row.method === "turn/start")!.params.input[0]!.text;
  assert.match(prompt, /mode/);
  assert.match(prompt, /"direct"/);
  assert.match(prompt, /"team"/);
  assert.match(prompt, /why/);
  assert.match(prompt, /exactly one agent/i);
  assert.match(prompt, /prompt is the goal/i);
});

test('mode "direct" with one agent comes back as { mode: "direct", agents: [the one] }', async () => {
  const { result } = await plan({ answer: DIRECT }, {}, { ...BODY, goal: "Create hello.txt in the project root." });
  assert.deepEqual(result, DIRECT);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.prompt, "Create hello.txt in the project root.");
});

test('mode "direct" with two agents is refused with a clear message', async () => {
  const two = { ...clone(PLAN), mode: "direct" };
  await refused(plan({ answer: two }), 502, /"direct"[^.]*(one agent|2 agents)/i);
});

test('mode "team" with several agents comes back as before, plus mode and why', async () => {
  const { result } = await plan();
  assert.equal(result.mode, "team");
  assert.equal(result.why, WHY);
  assert.deepEqual(result.agents, PLAN.agents);
});

test("review-only agents need no project write folders even when project folders exist", async () => {
  const review = {
    name: "Project status review",
    mode: "direct",
    why: "One report, one agent.",
    agents: [
      {
        key: "evidence",
        title: "Review current project evidence",
        prompt:
          "Read the project without changing it. Write the evidence-based status and next steps only in your own report folder.",
        folders: [],
        doneWhen: ["The report separates proven work, unknowns and next steps with source paths."],
        waitsFor: [],
      },
    ],
  };
  const { result } = await plan(
    { answer: review },
    {},
    { ...BODY, goal: "Review the latest project state without changing project files." },
  );
  assert.deepEqual(result, review, "a review agent needs only its own report folder, not a project write scope");
});

// 28 Oct: "create hello.txt in the sandbox" could never pass: no agent could write a file in the project root.
test('an agent that writes a file in the project root may have the whole project, "."', async () => {
  const root = {
    name: "Hello check",
    mode: "direct",
    why: "One file.",
    agents: [
      {
        key: "hello",
        title: "Write hello.txt",
        prompt: "Create hello.txt in the project root with one line: hello.",
        folders: ["."],
        doneWhen: ["hello.txt holds one line: hello"],
        waitsFor: [],
      },
    ],
  };
  const { result } = await plan({ answer: root }, {}, { ...BODY, goal: "Create hello.txt in the project root." });
  assert.deepEqual(result, root);
});

test("reads a plan wrapped in a code fence, and the final answer rather than the commentary before it", async () => {
  const { result } = await plan({
    answer: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``,
    extra: [{ type: "agentMessage", id: "note", text: "Let me plan.", phase: "commentary" }],
  });
  assert.deepEqual(result, PLAN);
});

test("with a board, sends it and the keep-and-fill rule; the plan keeps the keys and fills what was empty", async () => {
  const board = [
    {
      key: "agent-1",
      title: "Notes API",
      prompt: "Keep the API small.",
      folders: ["api"],
      doneWhen: ["Smoke test passes"],
      waitsFor: [],
    },
    { key: "agent-2", title: "Notes screen", prompt: "", folders: [], doneWhen: [], waitsFor: ["agent-1"] },
  ];
  const filled = {
    name: "Notes app",
    mode: "team",
    why: WHY,
    agents: [
      {
        key: "agent-1",
        title: "Notes API",
        prompt: "Keep the API small.",
        folders: ["api"],
        doneWhen: ["the API tests pass"],
        waitsFor: [],
      },
      {
        key: "agent-2",
        title: "Notes screen",
        prompt: "Add the notes screen in web/ with its tests.",
        folders: ["web"],
        doneWhen: ["the screen lists notes"],
        waitsFor: ["agent-1"],
      },
      {
        key: "docs",
        title: "Write the notes guide",
        prompt: "Write docs/guide.md for the notes app.",
        folders: ["docs"],
        doneWhen: ["docs/guide.md exists"],
        waitsFor: ["agent-2"],
      },
    ],
  };
  const { client, result } = await plan({ answer: filled }, {}, { ...BODY, agents: board });
  const prompt = client.sent.find(row => row.method === "turn/start")!.params.input[0]!.text;
  assert.match(prompt, /Keep every existing agent's key/);
  assert.match(prompt, /fill only what is empty \(prompt, folders, doneWhen\)[^.]*unless the goal asks/i);
  for (const row of board) {
    assert.ok(prompt.includes(`"key": "${row.key}"`));
    assert.ok(prompt.includes(`"title": "${row.title}"`));
  }
  assert.ok(prompt.includes("Keep the API small."));
  assert.ok(prompt.includes("Smoke test passes"), "its criteria too");
  assert.doesNotMatch(prompt, /board is empty/i);
  assert.deepEqual(
    result.agents.map(row => row.key),
    ["agent-1", "agent-2", "docs"],
  );
  assert.equal(result.agents[0]!.prompt, "Keep the API small.");
  assert.deepEqual(result.agents[1]!.folders, ["web"]);
});

test("an existing agent may keep a folder the user chose that is no longer listed; other agents may not use it", async () => {
  const board = [{ key: "agent-1", title: "Old", prompt: "Work.", folders: ["legacy"], doneWhen: [], waitsFor: [] }];
  const keeps = {
    name: "Team",
    mode: "team",
    why: "The board already has agents.",
    agents: [{ key: "agent-1", title: "Old", prompt: "Work.", folders: ["legacy"], doneWhen: [], waitsFor: [] }],
  };
  assert.deepEqual((await plan({ answer: keeps }, {}, { ...BODY, agents: board })).result, keeps);
  const other = {
    ...keeps,
    agents: [
      ...keeps.agents,
      { key: "new", title: "New", prompt: "Work.", folders: ["legacy"], doneWhen: [], waitsFor: [] },
    ],
  };
  await refused(
    plan({ answer: other }, {}, { ...BODY, agents: board }),
    502,
    /"new".*"legacy".*not in the project's folder list/,
  );
});

test("a plan may return an existing agent's fields empty (the canvas keeps its own), but not a new agent's", async () => {
  const board = [
    {
      key: "agent-1",
      title: "Notes API",
      prompt: "Keep the API small.",
      folders: ["api"],
      doneWhen: ["Smoke test passes"],
      waitsFor: [],
    },
  ];
  const empty = {
    name: "Team",
    mode: "team",
    why: "The board already has agents.",
    agents: [{ key: "agent-1", title: "", prompt: "", folders: [], doneWhen: [], waitsFor: [] }],
  };
  assert.deepEqual((await plan({ answer: empty }, {}, { ...BODY, agents: board })).result, empty);
  const added = {
    ...empty,
    agents: [
      ...empty.agents,
      { key: "fresh", title: "Fresh", prompt: "", folders: ["web"], doneWhen: [], waitsFor: [] },
    ],
  };
  await refused(plan({ answer: added }, {}, { ...BODY, agents: board }), 502, /Agent "fresh".*prompt/);
});

test("with no folder list every agent must come back with no folders", async () => {
  const bare = {
    name: "Team",
    mode: "direct",
    why: "One step.",
    agents: [{ key: "a", title: "Do it", prompt: "Do it.", folders: [], doneWhen: [], waitsFor: [] }],
  };
  const { folders: _folders, ...body } = BODY;
  const { client, result } = await plan({ answer: bare }, {}, body);
  assert.deepEqual(result, bare);
  assert.match(client.sent.find(row => row.method === "turn/start")!.params.input[0]!.text, /no folder list/i);
  await refused(
    plan({ answer: { ...bare, agents: [{ ...bare.agents[0], folders: ["api"] }] } }, {}, body),
    502,
    /not in the project's folder list/,
  );
});

for (const [label, answer, pattern] of REFUSALS) {
  test(`refuses ${label} with a clear message and still releases the conversation`, async () => {
    const client = fakeClient({ answer });
    await refused(planCanvas(client, { ...BODY, maxAgents: 3 }), 502, pattern);
    assert.deepEqual(client.methods().slice(-1), ["thread/unsubscribe"]);
  });
}

test("a turn that fails is reported with the engine message", async () => {
  const client = fakeClient({ status: "failed", error: "The model is not available" });
  await refused(planCanvas(client, BODY), 502, /could not plan.*The model is not available/i);
  assert.ok(client.methods().includes("thread/unsubscribe"));
});

test("times out with a clear error, stops the turn and releases the conversation", async () => {
  const client = fakeClient({ silent: true });
  const started = Date.now();
  await refused(
    planCanvas(client, BODY, { timeoutMs: 40 }),
    504,
    /did not finish planning within 90 seconds|did not finish planning/,
  );
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(client.sent.slice(-2), [
    { method: "turn/interrupt", params: { threadId: THREAD, turnId: "t1" } },
    { method: "thread/unsubscribe", params: { threadId: THREAD } },
  ]);
  assert.equal(client.bus.listenerCount("side"), 0, "stops listening");
});

test("releases the ephemeral conversation after a plan, and deletes it if Elpis did not keep it ephemeral", async () => {
  const kept = fakeClient();
  await planCanvas(kept, BODY);
  assert.deepEqual(kept.sent.slice(-1), [{ method: "thread/unsubscribe", params: { threadId: THREAD } }]);
  assert.equal(kept.methods().includes("thread/delete"), false);
  assert.equal(kept.bus.listenerCount("side"), 0);
  const stored = fakeClient({ ephemeral: false });
  await planCanvas(stored, BODY);
  assert.deepEqual(stored.methods().slice(-2), ["thread/unsubscribe", "thread/delete"]);
  assert.deepEqual(stored.sent.at(-1)!.params, { threadId: THREAD });
});

test("a failing release does not hide the plan", async () => {
  const client = fakeClient();
  const rpc = client.sideRpc;
  Object.assign(client, {
    sideRpc: async (method: string, params: unknown) => {
      if (method === "thread/unsubscribe") throw new BridgeError("gone", 502);
      return rpc(method, params);
    },
  });
  assert.deepEqual(await planCanvas(client, BODY), PLAN);
});
