import test from "node:test";
import assert from "node:assert/strict";
import { required, ROOT, CHILD, CREATED, MODEL, FORK, fixture } from "./bridge.fixtures.mts";

test("existing chats are written directly after a native rejoin; parent-owned agents explicitly continue in a fork", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  const listed = await client.listThreads({ includeAgentRuns: true });
  assert.equal(listed.data.length, 2);
  assert.deepEqual(
    listed.data.map(thread => [thread.desktopAccess.writable, thread.desktopAccess.mode]),
    [
      [true, "direct"],
      [false, "continue"],
    ],
  );
  assert.ok(
    required(required(required(socket.sent.find(row => row.method === "thread/list")).params).sourceKinds).includes(
      "subAgentThreadSpawn",
    ),
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    socket.sent.filter(row => row.method === "thread/subscribe").map(row => required(row.params).threadId),
    [CHILD],
    "working agents are followed live without resuming them",
  );
  const liveChild = await client.resume(CHILD, {});
  assert.equal(liveChild.activeTurnId, "running-turn");
  assert.equal(liveChild.thread.desktopAccess.writable, false);
  assert.equal(
    socket.sent.some(
      row =>
        ["thread/resume", "thread/settings/update", "turn/start"].includes(row.method ?? "") &&
        required(row.params).threadId === CHILD,
    ),
    false,
  );
  const events: { data: { method?: string; params: { delta?: string } } }[] = [];
  client.on("event", event => events.push(event));
  socket.emit(
    "message",
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: CHILD, turnId: "running-turn", itemId: "child-message", delta: "live child" },
    }),
  );
  assert.ok(
    events.some(event => event.data?.method === "item/agentMessage/delta" && event.data.params.delta === "live child"),
  );
  const child = await client.readThread(CHILD);
  assert.equal(required(child.data[0]).item.text, "Actual fixture transcript");
  await client.send(ROOT, { text: "Continue the root" });
  assert.deepEqual(
    socket.sent.filter(row => row.method === "thread/resume").map(row => row.params),
    [
      {
        threadId: ROOT,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" },
      },
    ],
  );
  assert.deepEqual(
    socket.sent.filter(row => row.method === "turn/start").map(row => required(row.params).threadId),
    [ROOT],
  );
  // Elpis refuses direct turns for a multi-agent v2 agent, so its history continues in a fork with its model.
  required(threads.get(CHILD)).status = { type: "idle" };
  await assert.rejects(client.send(CHILD, { text: "Follow up" }), /continued conversation name/);
  const continued = await client.send(CHILD, { text: "Follow up", continueAs: "Failure reporting (continued)" });
  assert.ok("thread" in continued);
  assert.equal(continued.thread.id, FORK);
  assert.equal(continued.continuedFrom, CHILD);
  assert.equal(continued.thread.name, "Failure reporting (continued)");
  assert.deepEqual(required(socket.sent.find(row => row.method === "thread/fork")).params, {
    threadId: CHILD,
    model: MODEL,
    modelProvider: "openai",
  });
  assert.deepEqual(
    socket.sent.filter(row => row.method === "turn/start").map(row => required(row.params).threadId),
    [ROOT, FORK],
    "never a direct turn on the agent",
  );
  client.close();
});

test("a continued-agent conversation survives a failed name or first send, and an explicit retry reuses it", async t => {
  for (const method of ["thread/name/set", "turn/start"])
    await t.test(method, async () => {
      const { client, socket, threads } = fixture();
      try {
        await client.initialize();
        required(threads.get(CHILD)).status = { type: "idle" };
        const send = socket.send;
        let reject = true;
        socket.send = raw => {
          const request = JSON.parse(raw);
          if (reject && request.method === method && request.params?.threadId === FORK) {
            reject = false;
            socket.sent.push(request);
            queueMicrotask(() =>
              socket.emit(
                "message",
                JSON.stringify({
                  id: request.id,
                  error: { code: -32000, message: "Fixture continuation write rejected" },
                }),
              ),
            );
          } else send(raw);
        };
        const result = await client.send(CHILD, { text: "Follow up", continueAs: "Failure reporting (continued)" });
        assert.ok("thread" in result && "sendError" in result);
        assert.equal(result.thread.id, FORK);
        assert.equal(result.continuedFrom, CHILD);
        assert.equal(result.thread.desktopAccess.mode, "direct");
        assert.equal("turn" in result ? result.turn : undefined, undefined);
        assert.match(result.sendError, /Fixture continuation write rejected/);
        assert.equal(result.thread.name, method === "thread/name/set" ? undefined : "Failure reporting (continued)");
        assert.equal(
          socket.sent.filter(row => row.method === "turn/start").length,
          method === "thread/name/set" ? 0 : 1,
          "a naming failure does not send, and a send failure is not automatically retried",
        );
        const retried = await client.send(result.thread.id, { text: "Follow up" });
        assert.ok("turn" in retried);
        assert.equal(retried.turn.id, "new-turn");
        assert.equal(
          socket.sent.filter(row => row.method === "thread/fork").length,
          1,
          "retry stays in the acknowledged conversation",
        );
        assert.equal(
          required(required(socket.sent.filter(row => row.method === "turn/start").at(-1)).params).threadId,
          FORK,
        );
      } finally {
        client.close();
      }
    });
});

test("an unknown continued-agent send outcome preserves its fork without replaying the write", async () => {
  const { client, socket, threads } = fixture();
  try {
    await client.initialize();
    client.timeoutMs = 20;
    required(threads.get(CHILD)).status = { type: "idle" };
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === "turn/start")
        socket.sent.push(request); // Native outcome is deliberately unknown.
      else send(raw);
    };
    const result = await client.send(CHILD, { text: "Follow up", continueAs: "Failure reporting (continued)" });
    assert.ok("thread" in result && "sendError" in result);
    assert.equal(result.thread.id, FORK);
    assert.equal(result.continuedFrom, CHILD);
    assert.equal("turn" in result ? result.turn : undefined, undefined);
    assert.match(result.sendError, /outcome is unknown/);
    assert.equal(socket.sent.filter(row => row.method === "turn/start").length, 1);
    assert.equal(socket.sent.filter(row => row.method === "thread/fork").length, 1);
  } finally {
    client.close();
  }
});

test("a failed continuation fork does not report an acknowledged conversation or send a message", async () => {
  const { client, socket, threads } = fixture();
  try {
    await client.initialize();
    required(threads.get(CHILD)).status = { type: "idle" };
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === "thread/fork") {
        socket.sent.push(request);
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({ id: request.id, error: { code: -32000, message: "Fixture fork rejected" } }),
          ),
        );
      } else send(raw);
    };
    await assert.rejects(
      client.send(CHILD, { text: "Follow up", continueAs: "Failure reporting (continued)" }),
      /Fixture fork rejected/,
    );
    assert.equal(socket.sent.filter(row => ["thread/name/set", "turn/start"].includes(row.method ?? "")).length, 0);
  } finally {
    client.close();
  }
});

for (const found of [true, false])
  test(`fork recovers a stale turn only through its exact persisted message (found=${found})`, async () => {
    const { client, socket } = fixture();
    try {
      await client.initialize();
      const send = socket.send;
      socket.send = raw => {
        const request = JSON.parse(raw);
        if (request.method === "thread/fork" && request.params.lastTurnId === "stale-turn") {
          socket.sent.push(request);
          queueMicrotask(() =>
            socket.emit(
              "message",
              JSON.stringify({ id: request.id, error: { code: -32600, message: "turn not found: stale-turn" } }),
            ),
          );
        } else if (request.method === "thread/items/list") {
          socket.sent.push(request);
          queueMicrotask(() =>
            socket.emit(
              "message",
              JSON.stringify({
                id: request.id,
                result: {
                  data: [
                    { turnId: "newer-turn", item: { id: "newer-answer", type: "agentMessage" } },
                    ...(found
                      ? [{ turnId: "persisted-turn", item: { id: "selected-answer", type: "agentMessage" } }]
                      : []),
                  ],
                  nextCursor: null,
                },
              }),
            ),
          );
        } else send(raw);
      };
      if (found) {
        const result = await client.forkThread(ROOT, { lastTurnId: "stale-turn", lastItemId: "selected-answer" });
        assert.equal(result.thread.id, FORK);
        assert.deepEqual(
          socket.sent.filter(row => row.method === "thread/fork").map(row => required(row.params).lastTurnId),
          ["stale-turn", "persisted-turn"],
        );
      } else {
        await assert.rejects(
          client.forkThread(ROOT, { lastTurnId: "stale-turn", lastItemId: "selected-answer" }),
          /refresh|reload/i,
        );
        assert.equal(
          socket.sent.filter(row => row.method === "thread/fork").length,
          1,
          "Never fork latest history when the selected message is missing",
        );
      }
      assert.equal(
        socket.sent.some(row => row.method === "turn/start"),
        false,
        "Fork recovery never sends a new message",
      );
    } finally {
      client.close();
    }
  });

test("an effort picked in a chat is saved at once; a running native turn takes it now, a Claude turn through its bridge", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  await client.models();
  await client.createThread({ model: MODEL });
  await client.send(CREATED, { text: "Do the task", model: MODEL });
  const sent = (method: string) => socket.sent.filter(row => row.method === method).map(row => row.params);
  assert.deepEqual(await client.setEffort(CREATED, { effort: "xhigh" }), { reasoningEffort: "xhigh" });
  assert.deepEqual(
    sent("thread/settings/update").at(-1),
    { threadId: CREATED, effort: "xhigh" },
    "later turns and a restart keep it",
  );
  assert.deepEqual(
    sent("turn/settings/update"),
    [{ threadId: CREATED, turnId: "running-turn", effort: "xhigh" }],
    "the running turn takes it",
  );
  // A Claude turn is not the engine's: the bridge applies the saved effort to it.
  Object.assign(required(threads.get(CREATED)), { model: "claude/opus" });
  await client.setEffort(CREATED, { effort: "low" });
  assert.deepEqual(sent("thread/settings/update").at(-1), { threadId: CREATED, effort: "low" });
  assert.equal(sent("turn/settings/update").length, 1);
  // An idle chat only saves it.
  Object.assign(required(threads.get(CREATED)), { model: MODEL, status: { type: "idle" } });
  await client.setEffort(CREATED, { effort: "medium" });
  assert.equal(sent("turn/settings/update").length, 1);
  const before = socket.sent.length;
  await assert.rejects(client.setEffort(CREATED, { effort: "very high" }), /reasoning effort/);
  await assert.rejects(client.setEffort(CREATED, {}), /reasoning effort/);
  await assert.rejects(client.setEffort(CHILD, { effort: "high" }), /parent/);
  assert.equal(
    socket.sent.slice(before).some(row => required(row.method).endsWith("settings/update")),
    false,
    "a refused effort changes nothing",
  );
  client.close();
});

test("new roots send, steer and interrupt through typed protocol without overriding permissions", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  await client.models();
  await assert.rejects(client.createThread({ model: "invented" }), /model list/);
  await assert.rejects(client.createThread({ approvalPolicy: "never" }), /Unsupported/);
  const created = await client.createThread({ model: MODEL });
  assert.equal(created.thread.desktopAccess.writable, true);
  const first = client.send(CREATED, { text: "Do the task", model: MODEL });
  const duplicate = assert.rejects(client.send(CREATED, { text: "Race" }), /Use Steer/);
  const started = await first;
  assert.ok("turn" in started);
  assert.equal(started.turn.id, "new-turn");
  await duplicate;
  assert.equal(
    socket.sent.filter(row => row.method === "turn/start").length,
    1,
    "a queued duplicate never starts another turn or silently steers",
  );
  await assert.rejects(client.send(CREATED, { text: "Do not silently steer" }), /Use Steer/);
  const steered = await client.steer(CREATED, { text: "Clarify", expectedTurnId: "new-turn" });
  assert.ok(steered && typeof steered === "object" && "turnId" in steered);
  assert.equal(steered.turnId, "new-turn");
  await client.interrupt(CREATED, { turnId: "new-turn" });
  const request = socket.sent.find(row => row.method === "turn/start");
  const { additionalContext, ...params } = required(required(request).params);
  assert.equal(required(required(additionalContext)["elpis.subagents"]).kind, "application");
  assert.deepEqual(params, {
    threadId: CREATED,
    input: [{ type: "text", text: "Do the task", text_elements: [] }],
    model: MODEL,
  });
  assert.equal(
    socket.sent.some(row => row.method === "thread/resume"),
    false,
  );
  client.close();
  assert.equal(socket.closed, true);
});

test("opening a chat and finishing background work release idle chats, keeping selected and working chats (A47)", async t => {
  const { client, socket, threads } = fixture();
  t.after(() => client.close());
  await client.initialize();
  await client.models();
  const released = () =>
    socket.sent.filter(row => row.method === "thread/unsubscribe").map(row => required(row.params).threadId);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  await client.createThread({ model: MODEL });
  await client.resume(ROOT, {});
  await settle();
  assert.deepEqual(released(), [CREATED]);
  // Back in the left chat, it is followed again and runs a turn; leaving it then keeps it followed.
  await client.resume(CREATED, {});
  await settle();
  assert.deepEqual(released(), [CREATED, ROOT]);
  await client.send(CREATED, { text: "Work", model: MODEL });
  await client.resume(ROOT, {});
  await settle();
  assert.deepEqual(released(), [CREATED, ROOT]);
  const completed = (id: string) =>
    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: id, turn: { id: "new-turn", status: "completed", items: [] } },
      }),
    );
  completed(ROOT);
  await settle();
  assert.deepEqual(released(), [CREATED, ROOT], "the selected idle chat stays followed");
  completed(CREATED);
  await settle();
  assert.deepEqual(released(), [CREATED, ROOT], "an old completion cannot release a chat that is working again");
  required(threads.get(CREATED)).status = { type: "idle" };
  completed(CREATED);
  await settle();
  assert.deepEqual(
    released(),
    [CREATED, ROOT, CREATED],
    "background completion releases history without requiring another chat switch",
  );
  const reopened = await client.resume(CREATED, {});
  assert.equal(reopened.thread.id, CREATED, "the released chat can be resumed from its durable history");
});
