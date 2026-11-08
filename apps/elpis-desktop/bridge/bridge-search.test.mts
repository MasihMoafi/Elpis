import test from "node:test";
import assert from "node:assert/strict";
import { required, ROOT, CHILD, CREATED, MODEL, FORK, fixture } from "./bridge.fixtures.mts";

test("configured connection models use only that endpoint and never authorize the same ID on the main route", async () => {
  const { client, socket, configRead, requirementsRead } = fixture();
  await client.initialize();
  configRead.config.model_providers.local = {
    name: "gpt-oss",
    base_url: "http://127.0.0.1:1234/v1",
    experimental_bearer_token: "LOCAL CATALOG KEY",
  };
  const original = globalThis.fetch,
    calls: { url: string | URL | Request; authorization: string | null }[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(options?.headers instanceof Headers);
    calls.push({ url, authorization: options.headers.get("authorization") });
    return new Response(JSON.stringify({ data: [{ id: "unique-local-book-model", name: "Book model" }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const local = await client.models({ provider: "local" });
    assert.deepEqual(
      local.data.map(model => model.model),
      ["unique-local-book-model"],
    );
    assert.deepEqual(calls, [{ url: "http://127.0.0.1:1234/v1/models", authorization: "Bearer LOCAL CATALOG KEY" }]);
    assert.doesNotMatch(JSON.stringify(local), /LOCAL CATALOG KEY|Authorization|base_url/);
    await client.createThread({ provider: "local", model: required(local.data[0]).model });
    const sent = socket.sent.findLast(message => message.method === "thread/start");
    assert.equal(required(required(sent).params).modelProvider, "local");
    assert.equal(required(required(sent).params).model, "unique-local-book-model");
    await assert.rejects(client.createThread({ model: "unique-local-book-model" }), /current Elpis model list/);
    // A built-in key provider (OpenRouter with a pasted key) is a connection too, not in config.toml (7 Nov).
    await client.createThread({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" });
    assert.equal(
      required(required(socket.sent.findLast(message => message.method === "thread/start")).params).modelProvider,
      "openrouter",
    );
    await assert.rejects(client.createThread({ model: "deepseek/deepseek-v4.1-flash" }), /current Elpis model list/);
    await assert.rejects(client.models({ provider: "missing" }), /saved API address/);
    requirementsRead.requirements = { modelProvider: "openai" };
    await assert.rejects(client.models({ provider: "local" }), /restricted/);
    assert.equal(calls.length, 1, "missing and restricted connections must not make an endpoint request");
  } finally {
    globalThis.fetch = original;
    client.close();
  }
});

test("connection models forward the OpenRouter audio filter and explain a missing connection key", async () => {
  const { client, configRead } = fixture();
  await client.initialize();
  configRead.config.model_providers.openrouter = {
    base_url: "https://openrouter.ai/api/v1",
    experimental_bearer_token: "catalog-key",
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "voice/audio", architecture: { input_modalities: ["audio"] }, supported_parameters: [] },
          { id: "text/chat", architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
        ],
      }),
    );
  try {
    const result = await client.models({ provider: "openrouter", inputModality: "audio" });
    assert.deepEqual(
      result.data.map(row => row.model),
      ["voice/audio"],
    );
    await assert.rejects(client.models({ inputModality: "audio" }), /OpenRouter audio models/);
    await assert.rejects(client.models({ provider: "openrouter", inputModality: "video" }), /OpenRouter audio models/);
    configRead.config.model_providers.openrouter = {
      base_url: "https://openrouter.ai/api/v1",
      env_key: "ELPIS_D1_MISSING_KEY",
    };
    await assert.rejects(
      client.models({ provider: "openrouter", inputModality: "audio" }),
      /Add an API key for this connection/,
    );
  } finally {
    globalThis.fetch = original;
    client.close();
  }
});

test("the current API default loads its own catalog instead of the engine startup catalog", async () => {
  const { client, socket, configRead, requirementsRead } = fixture();
  await client.initialize();
  configRead.config.model_provider = "anthropic-credits";
  configRead.config.model = "claude-opus-5-5";
  configRead.config.model_providers["anthropic-credits"] = {
    name: "Anthropic credits",
    base_url: "http://127.0.0.1:44103/v1",
    wire_api: "responses",
    requires_openai_auth: false,
    http_headers: {
      "x-elpis-gateway-token": "PRIVATE GATEWAY TOKEN",
      "x-elpis-provider": "anthropic-credits",
      "x-elpis-wire": "anthropic_messages",
    },
  };
  const original = globalThis.fetch,
    calls: { url: string | URL | Request; provider: string | null }[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(options?.headers instanceof Headers);
    calls.push({ url, provider: options.headers.get("x-elpis-provider") });
    return new Response(JSON.stringify({ models: [{ slug: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const before = socket.sent.filter(message => message.method === "model/list").length;
    const credits = await client.models({ provider: "anthropic-credits" });
    assert.deepEqual(
      credits.data.map(model => model.model),
      ["claude-opus-5-5"],
    );
    assert.deepEqual(calls, [{ url: "http://127.0.0.1:44103/v1/models", provider: "anthropic-credits" }]);
    assert.equal(
      socket.sent.filter(message => message.method === "model/list").length,
      before,
      "the old engine catalog is not relabeled",
    );
    assert.doesNotMatch(JSON.stringify(credits), /PRIVATE GATEWAY TOKEN|x-elpis-/);
    await client.createThread({ provider: "anthropic-credits", model: required(credits.data[0]).model });
    const start = socket.sent.findLast(message => message.method === "thread/start");
    assert.deepEqual(
      [required(required(start).params).modelProvider, required(required(start).params).model],
      ["anthropic-credits", "claude-opus-5-5"],
    );
    await client.createThread({ provider: "anthropic-credits" });
    const inherited = socket.sent.findLast(message => message.method === "thread/start");
    assert.equal(required(required(inherited).params).modelProvider, "anthropic-credits");
    assert.equal(
      required(required(inherited).params).model,
      undefined,
      "a primary connection can inherit its configured model",
    );
    requirementsRead.requirements = { modelProvider: "openai" };
    await assert.rejects(client.models({ provider: "anthropic-credits" }), /restricted/);
    assert.equal(calls.length, 1, "managed policy is checked before another endpoint lookup");
  } finally {
    globalThis.fetch = original;
    client.close();
  }
});

test("saved-conversation search passes its term and cursor to the native list before decoration", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  try {
    await client.listThreads({ searchTerm: "Augustus", cursor: "saved-page", limit: 25 });
    const params = required(socket.sent.findLast(message => message.method === "thread/list")).params;
    assert.equal(required(params).searchTerm, "Augustus");
    assert.equal(required(params).cursor, "saved-page");
    assert.equal(required(params).limit, 25);
    const count = socket.sent.filter(message => message.method === "thread/list").length;
    await assert.rejects(client.listThreads({ searchTerm: " " }), /conversation search/);
    assert.equal(socket.sent.filter(message => message.method === "thread/list").length, count);
  } finally {
    client.close();
  }
});

test("search finds a chat by its name in any letter case, also past the first page the sidebar loaded", async () => {
  const { client, threads } = fixture({ threadListPaging: true });
  await client.initialize();
  const chat = (id: string, name: string, preview: string, source = "vscode") =>
    threads.set(id, { id, name, preview, source, status: { type: "idle" }, cwd: "/work" });
  for (let i = 0; i < 230; i++) chat(`filler-${i}`, `Filler chat ${i}`, `lorem ${i}`);
  chat("named-main", "main", "Set up the repo");
  chat("branch", "Main branch cleanup", "tidy the branches");
  chat("hermes", "Hermes main setup", "configure hermes");
  chat("domain", "Domain notes", "dns records");
  chat("mention", "Release checklist", "merge into main tomorrow");
  chat("run", "main", "background run", "exec");
  try {
    for (const term of ["main", "MAIN", "mai", "Main"]) {
      const found = (await client.listThreads({ searchTerm: term, limit: 100 })).data.map(thread => thread.id);
      assert.deepEqual(
        ["named-main", "branch", "hermes", "domain", "mention"].filter(id => !found.includes(id)),
        [],
        `${term} misses named chats`,
      );
      assert.ok(!found.includes("run") && !found.some(id => id.startsWith("filler-")), `${term} lists only matches`);
    }
  } finally {
    client.close();
  }
});

test("background sources are excluded from ordinary lists and search, and explicitly available to Agent runs", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  threads.set(CREATED, {
    id: CREATED,
    source: "exec",
    name: "Worker · inspect",
    parentThreadId: ROOT,
    status: { type: "idle" },
  });
  threads.set(FORK, { id: FORK, source: "vscode", name: "Worker · my own chat", status: { type: "idle" } });
  try {
    for (const options of [{}, { searchTerm: "Worker" }, { archived: false }]) {
      const listed = await client.listThreads(options);
      assert.deepEqual(
        listed.data.map(thread => thread.id),
        [ROOT, FORK],
      );
      assert.ok(
        !required(
          required(required(socket.sent.findLast(row => row.method === "thread/list")).params).sourceKinds,
        ).includes("exec"),
      );
    }
    assert.deepEqual(
      (await client.listThreads({ includeAgentRuns: true })).data.map(thread => thread.id),
      [ROOT, CHILD, CREATED, FORK],
    );
    assert.deepEqual(
      (await client.listThreads({ ancestorThreadId: ROOT })).data.map(thread => thread.id),
      [CHILD, CREATED],
    );
  } finally {
    client.close();
  }
});

test("listed spawned agents recover their parent from recorded source without grouping independent desktop chats", async () => {
  const { client, threads } = fixture();
  await client.initialize();
  required(threads.get(CHILD)).parentThreadId = null;
  threads.set(FORK, { id: FORK, source: "vscode", name: "Elpis — keyboard shortcuts", status: { type: "idle" } });
  try {
    const listed = (await client.listThreads({ includeAgentRuns: true })).data;
    const agent = listed.find(thread => thread.id === CHILD);
    assert.ok(agent);
    assert.equal(agent.parentThreadId, ROOT, "the source records subAgent.thread_spawn.parent_thread_id");
    assert.equal(agent.desktopAccess.writable, false);
    assert.equal(
      required(listed.find(thread => thread.id === FORK)).parentThreadId,
      undefined,
      "a name is not evidence of parentage",
    );
  } finally {
    client.close();
  }
});

test("background runs are read-only; only an idle run may explicitly continue in a normal chat without sending", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  threads.set(CREATED, {
    id: CREATED,
    source: "exec",
    name: "Worker · inspect",
    parentThreadId: ROOT,
    model: MODEL,
    modelProvider: "openai",
    canAcceptDirectInput: true,
    status: { type: "active" },
  });
  try {
    for (const id of [CHILD, CREATED]) {
      assert.equal((await client.readThread(id)).thread.desktopAccess.writable, false);
      await assert.rejects(client.send(id, { text: "Hello" }), /background|parent|continued conversation name/i);
      await assert.rejects(client.continueThread(id, {}), /finish/i);
    }
    assert.equal(socket.sent.filter(row => row.method === "thread/fork" || row.method === "turn/start").length, 0);
    required(threads.get(CREATED)).status = { type: "idle" };
    assert.equal((await client.readThread(CREATED)).thread.desktopAccess.canContinue, true);
    const continued = await client.continueThread(CREATED, {});
    assert.equal(continued.thread.id, FORK);
    assert.equal(continued.thread.desktopAccess.writable, true);
    assert.equal(continued.thread.source, "appServer");
    assert.ok("forkedFromId" in continued.thread);
    assert.equal(continued.thread.forkedFromId, CREATED);
    assert.equal(required(threads.get(CREATED)).source, "exec");
    assert.equal(required(threads.get(CREATED)).parentThreadId, ROOT);
    assert.equal(socket.sent.filter(row => row.method === "turn/start").length, 0);
    assert.deepEqual(required(socket.sent.find(row => row.method === "thread/fork")).params, {
      threadId: CREATED,
      model: MODEL,
      modelProvider: "openai",
    });
    await client.send(FORK, { text: "Now talk here" });
    assert.equal(required(required(socket.sent.find(row => row.method === "turn/start")).params).threadId, FORK);
  } finally {
    client.close();
  }
});

test("opening a completed parent-owned child reads history without resuming it", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  required(threads.get(CHILD)).status = { type: "notLoaded" };
  delete required(threads.get(CHILD)).canAcceptDirectInput;
  try {
    const opened = await client.resume(CHILD, {});
    assert.equal(opened.thread.desktopAccess.writable, false);
    assert.equal(opened.activeTurnId, null);
    assert.equal(required((await client.readThread(CHILD)).data[0]).item.text, "Actual fixture transcript");
    assert.equal(
      socket.sent.some(
        row =>
          ["thread/resume", "thread/subscribe", "thread/settings/update"].includes(row.method ?? "") &&
          required(row.params).threadId === CHILD,
      ),
      false,
    );
  } finally {
    client.close();
  }
});

test("a child in a legacy drain reports history-only until its viewer reconnects", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "thread/subscribe" || request.params.threadId !== CHILD) return send(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({
          id: request.id,
          result: { thread: structuredClone(threads.get(CHILD)), followingLive: false },
        }),
      ),
    );
  };
  try {
    const first = await client.resume(CHILD, {});
    assert.ok("followingLive" in first);
    assert.equal(first.followingLive, false);
    const second = await client.resume(CHILD, {});
    assert.ok("followingLive" in second);
    assert.equal(second.followingLive, false, "a second open keeps the truthful state");
    assert.equal(
      socket.sent.filter(row => row.method === "thread/subscribe" && required(row.params).threadId === CHILD).length,
      1,
    );
    assert.equal(
      socket.sent.some(
        row =>
          ["thread/resume", "thread/settings/update", "turn/start"].includes(row.method ?? "") &&
          required(row.params).threadId === CHILD,
      ),
      false,
    );
  } finally {
    client.close();
  }
});

test("a finished child can continue from stored history when its parent is not loaded", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  required(threads.get(CHILD)).status = { type: "notLoaded" };
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === "thread/resume" && request.params.threadId === CHILD) {
      socket.sent.push(request);
      queueMicrotask(() =>
        socket.emit(
          "message",
          JSON.stringify({
            id: request.id,
            error: { code: -32600, message: "parent is not loaded; resume the parent first" },
          }),
        ),
      );
    } else send(raw);
  };
  try {
    const continued = await client.continueThread(CHILD, {});
    assert.equal(continued.thread.id, FORK);
    assert.equal(continued.thread.name, "Chat (continued)");
    assert.equal(
      socket.sent.some(row => row.method === "thread/resume"),
      false,
      "forking a finished run must not load its parent or take over the run",
    );
    assert.equal(
      socket.sent.some(row => row.method === "turn/start"),
      false,
    );
  } finally {
    client.close();
  }
});

test("the auto-review reviewer's own threads are never listed as chats", async () => {
  const { client, threads } = fixture();
  await client.initialize();
  const reviewer = "guardian-review-thread";
  threads.set(reviewer, {
    ...required(threads.get(ROOT)),
    id: reviewer,
    name: "Guardian review",
    source: { subAgent: { other: "guardian" } },
  });
  try {
    assert.deepEqual(
      (await client.listThreads()).data.map(thread => thread.id).filter(id => id === reviewer),
      [],
    );
  } finally {
    client.close();
  }
});
