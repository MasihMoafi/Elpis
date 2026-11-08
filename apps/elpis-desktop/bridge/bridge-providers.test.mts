import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import { required, ROOT, CHILD, CREATED, fixture } from "./bridge.fixtures.mts";

test("providers report separate sign-in and usage per provider; MCP shows credential presence only", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  process.env.APP_TEST_OPENROUTER_KEY = "PRIVATE CONFIG SECRET";
  delete process.env.APP_TEST_COMPANY_KEY;
  const providers = await client.providers();
  assert.deepEqual(providers.openai.auth, {
    state: "signedIn",
    method: "ChatGPT",
    email: "person@example.com",
    plan: "pro",
  });
  assert.deepEqual(
    providers.openai.usage.map(limit => required(limit).limitId),
    ["codex"],
  );
  assert.deepEqual(
    providers.claude.usage.map(limit => [
      required(limit).limitId,
      required(required(limit).primary).usedPercent,
      required(required(limit).secondary).windowDurationMins,
    ]),
    [["claude", 40, 10080]],
  );
  assert.equal(providers.claude.state, "connected");
  assert.deepEqual(providers.claude.models, ["Opus (Claude subscription)"]);
  assert.deepEqual(
    providers.gemini.usage.map(limit => required(limit).limitId),
    ["antigravity-pro"],
  );
  assert.equal(providers.gemini.state, "connected");
  assert.deepEqual(providers.openrouter, [
    {
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      envKey: "APP_TEST_OPENROUTER_KEY",
      keySet: true,
    },
  ]);
  assert.equal("local" in providers, false, "loopback addresses are not listed as local servers");
  const mcp = await client.mcp();
  assert.deepEqual(
    mcp.servers.map(server => [server.name, server.enabled, server.transport]),
    [
      ["rag", true, "stdio"],
      ["remote", false, "http"],
      ["whispertype", true, "stdio"],
    ],
  );
  assert.deepEqual(required(mcp.servers[0]).credentials, [{ name: "OPENROUTER_API_KEY", source: "config", set: true }]);
  assert.deepEqual(required(mcp.servers[1]).credentials, [
    { name: "APP_TEST_BEARER", source: "environment", set: false },
  ]);
  assert.equal(required(mcp.servers[1]).url, "https://mcp.example/path");
  assert.deepEqual(required(mcp.servers[2]).whispertype, { backend: "local", model: "openai/gpt-4o-mini-transcribe" });
  assert.doesNotMatch(JSON.stringify({ providers, mcp }), /PRIVATE CONFIG SECRET|token/);
  // Writes are versioned native config edits; nothing else is accepted.
  await client.saveMcp({ version: "user-version", action: "enable", name: "remote", enabled: true });
  await client.saveMcp({
    version: "user-version",
    action: "add",
    name: "extra",
    command: "/bin/true",
    args: ["--flag"],
  });
  await client.saveMcp({
    version: "user-version",
    action: "whispertype",
    name: "whispertype",
    backend: "openrouter",
    model: "openai/gpt-4o-mini-transcribe",
  });
  await client.saveMcp({ version: "user-version", action: "remove", name: "rag" });
  assert.deepEqual(
    socket.sent.filter(row => row.method === "config/batchWrite").map(row => required(row.params).edits),
    [
      [{ keyPath: "mcp_servers.remote.enabled", value: true, mergeStrategy: "replace" }],
      [{ keyPath: "mcp_servers.extra", value: { command: "/bin/true", args: ["--flag"] }, mergeStrategy: "replace" }],
      [
        { keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_BACKEND", value: "openrouter", mergeStrategy: "replace" },
        {
          keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_CLOUD_MODEL",
          value: "openai/gpt-4o-mini-transcribe",
          mergeStrategy: "replace",
        },
      ],
      [{ keyPath: "mcp_servers.rag", value: null, mergeStrategy: "replace" }],
    ],
  );
  await assert.rejects(
    client.saveMcp({ version: "stale", action: "remove", name: "rag" }),
    /changed in another client/,
  );
  await assert.rejects(
    client.saveMcp({ version: "user-version", action: "add", name: "bad.name", command: "x" }),
    /server name/,
  );
  await assert.rejects(
    client.saveMcp({ version: "user-version", action: "whispertype", name: "rag", backend: "local" }),
    /Unsupported MCP change/,
  );
  await assert.rejects(
    client.saveMcp({ version: "user-version", action: "whispertype", name: "whispertype", backend: "gpu; rm" }),
    /OpenRouter, Codex sign-in or local/,
  );
  await assert.rejects(
    client.saveMcp({
      version: "user-version",
      action: "whispertype",
      name: "whispertype",
      backend: "local",
      model: "invalid model",
    }),
    { message: "Choose an OpenRouter model." },
  );
  assert.equal(
    socket.sent.filter(row => row.method === "config/batchWrite").length,
    4,
    "refused changes write nothing",
  );
  await client.saveMcp({ version: "user-version", action: "whispertype", name: "whispertype", backend: "codex" });
  assert.deepEqual(
    required(required(socket.sent.filter(row => row.method === "config/batchWrite").at(-1)).params).edits,
    [{ keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_BACKEND", value: "codex", mergeStrategy: "replace" }],
  );
  delete process.env.APP_TEST_OPENROUTER_KEY;
  client.close();
});

test("settings expose supported fields; providers require configured identity and respect managed restrictions", async () => {
  const { client, socket, configRead, requirementsRead } = fixture();
  await client.initialize();
  const settings = await client.settings();
  assert.equal(settings.main.provider, "openai");
  assert.equal(settings.background.purpose, "smartPruneFallback");
  assert.equal(settings.memory.generate, false);
  assert.equal(settings.version, "user-version");
  assert.equal(settings.smartPrune.explicitOverride.available, false);
  assert.equal(settings.write.available, true);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE CONFIG SECRET|http_headers|api_key|config.toml/);
  // This case selects an editable API provider; alternate header auth is covered separately.
  delete configRead.config.model_providers.local.http_headers;
  await assert.rejects(client.createThread({ provider: "unknown", model: "remote" }), /configured provider/);
  await assert.rejects(client.createThread({ provider: "local" }), /model for this provider/);
  assert.equal(socket.sent.filter(message => message.method === "thread/start").length, 0);
  await client.createThread({ provider: "local", model: "remote-model" });
  assert.deepEqual(required(socket.sent.find(message => message.method === "thread/start")).params, {
    model: "remote-model",
    modelProvider: "local",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    permissions: ":danger-full-access",
    elpisPermissionSource: "default",
  });
  requirementsRead.requirements = {
    modelProvider: "openai",
    modelProviders: { local: { name: "Managed", api_key: "PRIVATE CONFIG SECRET" } },
  };
  await assert.rejects(client.createThread({ provider: "local", model: "remote-model" }), /restricted/);
  assert.equal(socket.sent.filter(message => message.method === "thread/start").length, 1);
  configRead.config.features = {};
  configRead.config.memories = {};
  const unknown = await client.settings();
  assert.equal(unknown.smartPrune.enabled, null);
  assert.equal(unknown.memory.use, null);
  client.close();
});

test("main-provider requirements do not prohibit independently configured maintenance providers", async () => {
  const { client, configRead, requirementsRead } = fixture({ prunerSupported: true });
  await client.initialize();
  requirementsRead.requirements = { modelProvider: "openai" };
  await assert.rejects(client.createThread({ provider: "local", model: "remote-model" }), /restricted/);
  await client.saveSettings({ version: "user-version", background: { model: "local-small", provider: "local" } });
  const saved = await client.savePruner({ version: "pruner-v1", model: "local-small", provider: "local" });
  assert.equal(saved.smartPrune.explicitOverride.provider, "local");
  assert.equal(configRead.config.model_provider, "openai");
  client.close();
});

test("context exposes actual scoped events without resuming and strips audit paths", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const initial = await client.context(ROOT);
  assert.equal(initial.tokenUsage, null);
  assert.equal(initial.smartPrune, null);
  const events: unknown[] = [];
  client.on("event", event => events.push(event));
  const emit = (method: string, params: unknown) => socket.emit("message", JSON.stringify({ method, params }));
  emit("thread/tokenUsage/updated", {
    threadId: ROOT,
    tokenUsage: {
      total: { inputTokens: 900, cachedInputTokens: 800, cacheWriteInputTokens: 75, outputTokens: 10 },
      last: { inputTokens: 100 },
      modelContextWindow: 1000,
      contextAttribution: {
        systemInstructions: 20,
        developerMessages: "not a number",
        toolResults: 0,
        estimatedTotal: 100,
        auditPath: "/private/audit",
        secret: "PRIVATE AUDIT",
      },
      secret: "PRIVATE AUDIT",
    },
  });
  emit("thread/smartPrune/updated", {
    threadId: ROOT,
    smartPrune: {
      enabled: true,
      approxSavedTokens: 50,
      optimizerRequests: 2,
      latestAttempt: {
        status: "failed",
        modelSlug: "optimizer-model",
        failureReason: "Failed to connect",
        auditPath: "/private/audit",
      },
    },
  });
  const result = await client.context(ROOT);
  assert.ok(result.tokenUsage?.total && result.tokenUsage.last && result.smartPrune?.latestAttempt);
  assert.equal(result.tokenUsage.total.cachedInputTokens, 800);
  assert.equal(result.tokenUsage.total.cacheWriteInputTokens, 75);
  assert.equal(result.tokenUsage.last.inputTokens, 100, "Latest input remains separate from cumulative usage");
  assert.deepEqual(
    result.tokenUsage.contextAttribution,
    { systemInstructions: 20, toolResults: 0, estimatedTotal: 100 },
    "Composition preserves reported zero, omits unknowns and keeps private fields out",
  );
  assert.equal(result.smartPrune.latestAttempt.modelSlug, "optimizer-model");
  assert.equal(result.smartPrune.latestAttempt.failureReason, "Failed to connect");
  assert.equal((await client.context(CHILD)).smartPrune, null);
  assert.equal((await client.context(CHILD)).tokenUsage, null, "Child context never borrows its parent snapshot");
  assert.doesNotMatch(JSON.stringify([result, events]), /PRIVATE AUDIT|private\/audit/);
  emit("thread/tokenUsage/updated", { threadId: CREATED, tokenUsage: { total: { inputTokens: 100000 } } });
  assert.equal(events.length, 2);
  assert.equal(
    socket.sent.some(message => message.method === "thread/resume"),
    false,
  );
  await assert.rejects(client.context("not-a-thread"), /Invalid thread/);
  client.close();
});

test("the context ledger measures the latest request and reconciles the estimated categories to it, as the TUI ledger does", async () => {
  const { contextLedger } = await import("./elpis-features.mts");
  const attribution = {
    userMessages: 1000,
    agentMessages: 3000,
    reasoning: 0,
    toolCalls: 500,
    toolResults: 27000,
    systemInstructions: 8000,
    developerMessages: 1500,
    toolDefinitions: 9000,
    outputSchema: 1000,
    unrecognizedItems: 0,
    estimatedTotal: 51000,
  };
  const usage = (
    last: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
    window: number,
    contextAttribution?: Record<string, number> | null,
  ) => ({
    total: { totalTokens: 900000 },
    last,
    modelContextWindow: window,
    ...(contextAttribution === undefined ? {} : { contextAttribution }),
  });
  const ledger = contextLedger(
    usage({ inputTokens: 48000, outputTokens: 2000, totalTokens: 50000 }, 200000, attribution),
  );
  assert.equal(
    ledger.used,
    50000,
    "measured: the latest request's total tokens (tokens_in_context_window), not the cumulative total",
  );
  assert.equal(ledger.window, 200000);
  assert.deepEqual(
    ledger.categories.map(row => [row.label, row.tokens]),
    [
      ["User messages", 980],
      ["Agent messages", 2941],
      ["Tool calls", 490],
      ["Tool results", 26471],
      ["System instructions", 7843],
      ["Developer messages", 1471],
      ["Tool definitions + schema", 9804],
    ],
    "TUI names and order, zero rows dropped, largest-remainder shares that sum to the measured total",
  );
  assert.equal(
    ledger.categories.reduce((sum, row) => sum + row.tokens, 0),
    50000,
  );
  assert.deepEqual(
    contextLedger(usage({ totalTokens: 50000 }, 200000, null)),
    { used: 50000, window: 200000, categories: [] },
    "no attribution: measured total only",
  );
  assert.deepEqual(
    contextLedger(usage({ totalTokens: 7 }, 0, attribution)).window,
    null,
    "a window of zero is capacity unknown",
  );
  assert.deepEqual(
    contextLedger(usage({ totalTokens: 0 }, 1000, attribution)).categories,
    [],
    "nothing measured, nothing attributed",
  );
  assert.deepEqual(contextLedger(null), { used: null, window: null, categories: [] });

  const { client, socket } = fixture();
  await client.initialize();
  assert.deepEqual((await client.context(ROOT)).ledger, { used: null, window: null, categories: [] });
  const emit = (method: string, params: unknown) => socket.emit("message", JSON.stringify({ method, params }));
  emit("thread/tokenUsage/updated", { threadId: ROOT, tokenUsage: usage({ totalTokens: 51000 }, 200000, attribution) });
  // A replay after resume carries no shares; the last known ones stay, scaled to the new measured total.
  emit("thread/tokenUsage/updated", { threadId: ROOT, tokenUsage: usage({ totalTokens: 50000 }, 200000) });
  const result = await client.context(ROOT);
  assert.ok(result.tokenUsage?.contextAttribution);
  assert.equal(result.tokenUsage.contextAttribution.toolResults, 27000);
  assert.equal(result.ledger.used, 50000);
  assert.equal(required(result.ledger.categories.find(row => row.id === "toolResults")).tokens, 26471);
  assert.deepEqual((await client.context(CHILD)).ledger, { used: null, window: null, categories: [] });
  client.close();
});

test("agent metadata follows the latest recorded model and effort without inventing them", async t => {
  const temp = createTestTempDir(path.join(os.tmpdir(), "elpis-agent-model-"));
  t.after(() => removeTestTempDir(temp));
  const rollout = path.join(temp, "rollout.jsonl");
  const record = (payload: { model: string; effort: string }) =>
    JSON.stringify({ type: "turn_context", payload }) + "\n";
  await fs.writeFile(rollout, record({ model: "gpt-6-luna", effort: "low" }));
  const { client, threads } = fixture();
  t.after(() => client.close());
  await client.initialize();
  const child = threads.get(CHILD);
  assert.ok(child);
  Object.assign(child, { path: rollout, model: null, reasoningEffort: null });
  const listed = async () => {
    const agent = (await client.listThreads({ includeAgentRuns: true })).data.find(thread => thread.id === CHILD);
    assert.ok(agent);
    return agent;
  };
  const first = await listed();
  assert.deepEqual([first.model, first.reasoningEffort], ["gpt-6-luna", "low"]);
  await fs.appendFile(rollout, record({ model: "gpt-6.1-terra", effort: "high" }));
  const updated = await client.readThreadMetadata(CHILD);
  assert.deepEqual([updated.model, updated.reasoningEffort], ["gpt-6.1-terra", "high"]);
  await fs.appendFile(
    rollout,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_id: CHILD,
        thread_settings: { model: "gpt-6.1-sol", reasoning_effort: "xhigh" },
      },
    }) + "\n",
  );
  const settings = await listed();
  assert.deepEqual([settings.model, settings.reasoningEffort], ["gpt-6.1-sol", "xhigh"]);
  await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
  const unknown = await listed();
  assert.equal(unknown.model, null);
  assert.equal(unknown.reasoningEffort, null);
});

test("saved replies use the model recorded in each turn context and never guess a missing one", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-turn-models-"));
  const rollout = path.join(temp, "rollout.jsonl");
  await fs.writeFile(
    rollout,
    [
      JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-6.1-sol" } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "older" } }),
    ].join("\n"),
  );
  const { rolloutTurnModels } = await import("./elpis-features.mts");
  assert.deepEqual([...(await rolloutTurnModels(rollout))], [["t1", "gpt-6.1-sol"]]);
  const { client, threads } = fixture();
  await client.initialize();
  required(threads.get(ROOT)).path = rollout;
  const page = await client.readThread(ROOT);
  const first = required(page.data[0]);
  assert.ok("model" in first);
  assert.equal(first.model, "gpt-6.1-sol");
  client.close();
});
