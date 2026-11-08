import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { required, ROOT, CREATED, MODEL, FORK, fixture, wholeTurnHistory } from "./bridge.fixtures.mts";

test("changing a chat's permissions applies now through the engine settings and reads the mode back", async () => {
  const { client, socket, threads, engineSettings } = fixture();
  await client.initialize();
  const events: { data: { method?: string; params: { permissions?: string } } }[] = [];
  client.on("event", event => events.push(event));
  try {
    // Native and bridged (Claude) chats alike, idle or running: the change is a settings update, not a queued turn field.
    required(threads.get(ROOT)).status = { type: "active" };
    const BRIDGED = "00000000-0000-0000-0000-000000000009";
    threads.set(BRIDGED, {
      id: BRIDGED,
      name: "Claude chat",
      source: "cli",
      model: "claude/opus",
      modelProvider: "openai",
      status: { type: "idle" },
    });
    for (const id of [ROOT, BRIDGED]) {
      assert.deepEqual(await client.setPermissions(id, { permissions: "full" }), { permissions: "full" });
      const update = required(socket.sent.findLast(message => message.method === "thread/settings/update")).params;
      assert.deepEqual(update, {
        threadId: id,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: ":danger-full-access",
        elpisPermissionSource: "chat",
      });
      assert.equal(required(engineSettings.get(id)).approvalPolicy, "never", "the engine holds the new mode");
      assert.equal(
        socket.sent.some(message => message.method === "turn/start"),
        false,
        "nothing waits for the next turn",
      );
    }
    assert.deepEqual(await client.setPermissions(ROOT, { permissions: "auto" }), { permissions: "auto" });
    assert.deepEqual(required(engineSettings.get(ROOT)).approvalsReviewer, "auto_review");
    assert.deepEqual(await client.setPermissions(ROOT, { permissions: "bypass" }), { permissions: "bypass" });
    assert.deepEqual(required(socket.sent.findLast(message => message.method === "thread/settings/update")).params, {
      threadId: ROOT,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":bypass-permissions",
      elpisPermissionSource: "chat",
    });
    // The app hears the applied mode from the engine's notification.
    assert.equal(
      required(events.filter(event => event.data?.method === "thread/settings/updated").at(-1)).data.params.permissions,
      "bypass",
    );
    // Choosing the mode a chat already has changes nothing, so no notification comes; the mode is read back instead.
    assert.deepEqual(await client.setPermissions(ROOT, { permissions: "bypass" }), { permissions: "bypass" });
    // A refusal is reported, not assumed applied.
    await assert.rejects(client.setPermissions(ROOT, { permissions: "root" }), /permission mode/);
  } finally {
    client.close();
  }
});

test("Full access and Bypass also answer what the chat was already asking; questions and Approve for me still wait", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  await client.createThread({});
  const ask = (id: string, method: string, params: Record<string, unknown>, thread = CREATED) =>
    socket.emit("message", JSON.stringify({ id, method, params: { threadId: thread, turnId: "turn1", ...params } }));
  const answered = (id: string) => socket.sent.find(message => message.id === id && "result" in message)?.result;
  const waiting = () => client.pendingApprovals.map(approval => approval.method).sort();
  try {
    ask("command", "item/commandExecution/requestApproval", {
      command: "npm test",
      availableDecisions: ["accept", "decline"],
    });
    ask("file", "item/fileChange/requestApproval", {});
    ask("tool", "mcpServer/elicitation/request", {
      serverName: "rag",
      mode: "form",
      message: "Run query_knowledge_base?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call" },
    });
    ask("form", "mcpServer/elicitation/request", {
      serverName: "survey",
      mode: "form",
      message: "Details",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    });
    ask("question", "item/tool/requestUserInput", { questions: [{ id: "q", header: "Pick", question: "Which?" }] });
    assert.equal(client.pendingApprovals.length, 5);
    // "Approve for me" hands later requests to the reviewer; a request already put to the person stays theirs.
    await client.setPermissions(CREATED, { permissions: "auto" });
    assert.equal(client.pendingApprovals.length, 5);
    await client.setPermissions(CREATED, { permissions: "full" });
    assert.deepEqual(answered("command"), { decision: "accept" });
    assert.deepEqual(answered("file"), { decision: "accept" });
    assert.deepEqual(answered("tool"), { action: "accept", content: null, _meta: null });
    assert.deepEqual(
      waiting(),
      ["item/tool/requestUserInput", "mcpServer/elicitation/request"],
      "a form and a question are answers, not permissions",
    );
    // Bypass grants a waiting permission request for its turn.
    await client.setPermissions(CREATED, { permissions: "ask" });
    const network = { network: { enabled: true }, fileSystem: null };
    ask("grant", "item/permissions/requestApproval", { permissions: network, reason: "fetch" });
    await client.setPermissions(CREATED, { permissions: "bypass" });
    assert.deepEqual(answered("grant"), { permissions: { network: { enabled: true } }, scope: "turn" });
  } finally {
    client.close();
  }
});

test("a permission change the engine refuses is shown as an error", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  try {
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === "thread/settings/update") {
        socket.sent.push(request);
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({
              id: request.id,
              error: {
                code: -32600,
                message:
                  "invalid thread settings override: Configured value for `permission_profile` is disallowed by requirements",
              },
            }),
          ),
        );
        return;
      }
      return send(raw);
    };
    await assert.rejects(client.setPermissions(ROOT, { permissions: "bypass" }), /disallowed by requirements/);
  } finally {
    client.close();
  }
});

test("plan mode is sent with the chat model only when it changes, and resume reports it", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  await client.models();
  try {
    Object.assign(required(threads.get(ROOT)), {
      status: { type: "idle" },
      model: "gpt-6-luna",
      reasoningEffort: "high",
      collaborationMode: { mode: "plan", settings: {} },
    });
    assert.equal((await client.resume(ROOT, {})).planMode, true, "a chat left in Plan mode reopens in it");
    await client.send(ROOT, { text: "plan it", mode: "plan" });
    const plan = required(socket.sent.findLast(message => message.method === "turn/start")).params;
    assert.deepEqual(required(plan).collaborationMode, {
      mode: "plan",
      settings: { model: "gpt-6-luna", reasoning_effort: "high", developer_instructions: null },
    });
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "Implement the plan.", mode: "default", model: MODEL });
    assert.deepEqual(
      required(
        required(required(socket.sent.findLast(message => message.method === "turn/start")).params).collaborationMode,
      ).mode,
      "default",
    );
    assert.equal(
      required(
        required(required(socket.sent.findLast(message => message.method === "turn/start")).params).collaborationMode,
      ).settings.model,
      MODEL,
    );
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "plain" });
    assert.equal(
      "collaborationMode" in
        required(required(socket.sent.findLast(message => message.method === "turn/start")).params),
      false,
      "an unchanged mode is left to the engine",
    );
    await assert.rejects(client.send(ROOT, { text: "x", mode: "pair" }), /chat mode/);
  } finally {
    client.close();
  }
});

test("a pasted provider key is saved privately in the Elpis home and never sent back", async () => {
  const { client, configRead } = fixture();
  await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-provider-key-"));
  try {
    required(configRead.layers[0]).name.file = path.join(root, "config.toml");
    const before = (await client.providerSettings()).providers.find(provider => provider.id === "openrouter");
    assert.deepEqual([required(before).auth.keySet, required(before).auth.acceptsKey], [false, true]);
    assert.equal(
      required((await client.providers()).openrouter.find(provider => provider.id === "openrouter")).keySet,
      false,
    );
    const after = await client.saveProviderKey({ provider: "openrouter", key: "  sk-or-fixture-secret  " });
    assert.deepEqual(required(after.providers.find(provider => provider.id === "openrouter")).auth, {
      source: "saved",
      keySet: true,
      envKey: "APP_TEST_OPENROUTER_KEY",
      acceptsKey: true,
    });
    assert(!JSON.stringify(after).includes("sk-or-fixture-secret"), "the key is never returned");
    const providers = await client.providers();
    assert.equal(required(providers.openrouter.find(provider => provider.id === "openrouter")).keySet, true);
    assert(!JSON.stringify(providers).includes("sk-or-fixture-secret"), "the connection list never returns the key");
    const file = path.join(root, "provider-keys.json");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { openrouter: "sk-or-fixture-secret" });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "readable by its owner alone");
    await assert.rejects(client.saveProviderKey({ provider: "openrouter", key: "two words" }), /visible ASCII/);
    await assert.rejects(client.saveProviderKey({ provider: "openai", key: "sk-x" }), /does not take an API key/);
  } finally {
    client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fork chat from here copies history through the chosen turn and names the copy", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  try {
    const result = await client.forkThread(ROOT, { lastTurnId: "turn-3" });
    const fork = required(socket.sent.findLast(message => message.method === "thread/fork")).params;
    assert.equal(required(fork).threadId, ROOT);
    assert.equal(required(fork).lastTurnId, "turn-3");
    assert.equal(result.thread.id, FORK);
    assert.equal(result.thread.name, "Existing root (fork)");
    await client.forkThread(ROOT, {});
    assert.equal(
      "lastTurnId" in required(required(socket.sent.findLast(message => message.method === "thread/fork")).params),
      false,
    );
  } finally {
    client.close();
  }
});

test('Smart Prune is switched by its feature key, and a writable config gives no "cannot save" reason', async () => {
  const { optionEdits, settingsSnapshot } = await import("./elpis-features.mts");
  assert.deepEqual(optionEdits({ automaticPruning: true }), [
    { keyPath: "features.automatic_context_pruning", value: true, mergeStrategy: "replace" },
  ]);
  assert.throws(() => optionEdits({ automaticPruning: "yes" }), /listed values/);
  const writable = settingsSnapshot(
    { config: {}, layers: [{ name: { type: "user", file: "/home/fixture/.elpis/config.toml" }, version: "v1" }] },
    { requirements: {} },
  );
  assert.deepEqual(writable.write, { available: true, reason: null });
  assert.match(
    required(settingsSnapshot({ config: {}, layers: [] }, { requirements: {} }).write.reason),
    /no writable config\.toml/,
  );
});

test("the agents a work graph may use follow Elpis: 256 in a graph, and at once its agent threads, never over 32", async () => {
  const { settingsSnapshot } = await import("./elpis-features.mts");
  const allowed = (config: NonNullable<NonNullable<Parameters<typeof settingsSnapshot>[0]>["config"]>) =>
    settingsSnapshot({ config, layers: [] }, { requirements: {} }).agents;
  assert.deepEqual(allowed({}), { graph: 256, atOnce: 6, source: "Elpis default" });
  assert.deepEqual(allowed({ agents: { max_threads: 3 } }), { graph: 256, atOnce: 3, source: "agents.max_threads" });
  assert.equal(allowed({ agents: { max_threads: 50 } }).atOnce, 32);
  // Multi-agent v2 counts the chat itself among its threads per session (4 by default).
  assert.equal(allowed({ features: { multi_agent_v2: true } }).atOnce, 3);
  assert.equal(allowed({ features: { multi_agent_v2: { max_concurrent_threads_per_session: 9 } } }).atOnce, 8);
  assert.equal(
    allowed({ features: { multi_agent_v2: true }, agents: { max_concurrent_threads_per_session: 5 } }).atOnce,
    5,
  );
  assert.equal(allowed({ features: { multi_agent_v2: false }, agents: { max_threads: 2 } }).atOnce, 2);
});

test("an operation Elpis does not support (-32601) shows its message, not only the code", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const answer = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "thread/read") return answer(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({ id: request.id, error: { code: -32601, message: "thread/read is not supported yet" } }),
      ),
    );
  };
  try {
    const error = await client.readThread(ROOT, {}).then(
      () => null,
      failure => failure,
    );
    assert.equal(error?.code, -32601);
    assert.match(error.message, /thread\/read is not supported yet/);
    assert.doesNotMatch(error.message, /rejected the operation/);
  } finally {
    client.close();
  }
});

test("-32601 mid-conversation: a chat without item pages opens from its turns, a page at a time", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const user = (id: string, text: string) => ({
    type: "userMessage",
    id,
    content: [{ type: "text", text, text_elements: [] }],
  });
  const agent = (id: string, text: string) => ({ type: "agentMessage", id, text });
  wholeTurnHistory(socket, [
    { id: "t1", status: "completed", items: [user("u1", "first"), agent("a1", "one")] },
    { id: "t2", status: "completed", items: [user("u2", "second"), agent("a2", "two")] },
  ]);
  try {
    const first = await client.readThread(ROOT, { limit: 3 });
    assert.equal(first.thread.id, ROOT);
    // Newest first, as thread/items/list's descending pages are.
    assert.deepEqual(
      first.data.map(entry => [entry.turnId, entry.item.id]),
      [
        ["t2", "a2"],
        ["t2", "u2"],
        ["t1", "a1"],
      ],
    );
    assert.equal(typeof first.nextCursor, "string");
    const asked = socket.sent.filter(message => message.method === "thread/items/list").length;
    const rest = await client.readThread(ROOT, { cursor: first.nextCursor, limit: 3 });
    assert.deepEqual(
      rest.data.map(entry => entry.item.id),
      ["u1"],
    );
    assert.equal(rest.nextCursor, null);
    assert.equal(
      socket.sent.filter(message => message.method === "thread/items/list").length,
      asked,
      "its own cursor goes straight to the turns",
    );
    // A recorded message of such a chat is found the same way.
    await assert.rejects(client.media(ROOT, "t1", "u1", 0), /No local media recorded here/);
    await assert.rejects(client.readThread(ROOT, { cursor: "whole-turns:-1" }), /cursor/i);
  } finally {
    client.close();
  }
});

test("-32601 mid-conversation: a new chat before its first message is recorded opens empty", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  wholeTurnHistory(socket, null);
  try {
    const opened = await client.readThread(ROOT, {});
    assert.equal(opened.thread.id, ROOT);
    assert.deepEqual(opened.data, []);
    assert.equal(opened.nextCursor, null);
  } finally {
    client.close();
  }
});

// Live check, 28 Oct: an imported Claude Code chat showed "<EXTERNAL SESSION IMPORTED>" as its reply. The engine's
// importer ends the last turn with that marker as an agent message, after the chat's real last reply.
test("an imported Claude Code chat ends on its own last reply, not the engine import marker", async () => {
  const MARKER = "<EXTERNAL SESSION IMPORTED>";
  const user = (id: string, text: string) => ({
    type: "userMessage",
    id,
    content: [{ type: "text", text, text_elements: [] }],
  });
  const agent = (id: string, text: string) => ({ type: "agentMessage", id, text });
  const turns = [
    {
      id: "t1",
      status: "completed",
      items: [user("u1", "hello import"), agent("a1", "hi from claude code"), agent("marker", MARKER)],
    },
    {
      id: "t2",
      status: "completed",
      items: [user("u2", `What does ${MARKER} mean?`), agent("a2", `${MARKER} is the engine's import note.`)],
    },
  ];
  const pages = fixture();
  await pages.client.initialize();
  const answer = pages.socket.send;
  pages.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "thread/items/list") return answer(raw);
    pages.socket.sent.push(request);
    const data = turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse();
    queueMicrotask(() =>
      pages.socket.emit("message", JSON.stringify({ id: request.id, result: { data, nextCursor: null } })),
    );
  };
  const whole = fixture();
  await whole.client.initialize();
  wholeTurnHistory(whole.socket, turns);
  try {
    for (const { client } of [pages, whole]) {
      assert.deepEqual(
        (await client.readThread(ROOT, {})).data.map(entry => entry.item.id),
        ["a2", "u2", "a1", "u1"],
        "the marker is dropped; a message that only quotes it stays",
      );
      assert.deepEqual(
        (await client.readPrompts(ROOT)).data.map(row => row.reply),
        ["hi from claude code", `${MARKER} is the engine's import note.`],
      );
    }
  } finally {
    pages.client.close();
    whole.client.close();
  }
});
