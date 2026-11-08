import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDesktopServer } from "./server.mts";
import { required, MODEL, fixture } from "./bridge.fixtures.mts";

test("the ledger switches write the keys the TUI ledger writes: Smart Prune and Subagents features, and the rag MCP server", async t => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  const writes = () =>
    socket.sent.filter(message => message.method === "config/batchWrite").map(message => message.params);
  assert.deepEqual(
    await client.contextSwitches(),
    { version: "user-version", write: { available: true }, smartPrune: true, subagents: true, rag: true },
    "Subagents is on unless features.multi_agent is false (its default); RAG is the rag server's enabled flag",
  );
  await client.saveContextSwitches({ version: "user-version", subagents: false });
  await client.saveContextSwitches({ version: "user-version", smartPrune: false });
  assert.deepEqual(
    writes(),
    [
      {
        edits: [{ keyPath: "features.multi_agent", value: false, mergeStrategy: "replace" }],
        expectedVersion: "user-version",
        reloadUserConfig: true,
      },
      {
        edits: [{ keyPath: "features.automatic_context_pruning", value: false, mergeStrategy: "replace" }],
        expectedVersion: "user-version",
        reloadUserConfig: true,
      },
    ],
    "one key per switch, reloaded so open chats use it from their next turn",
  );
  assert.equal(
    socket.sent.some(message => message.method === "config/mcpServer/reload"),
    false,
  );
  await client.saveContextSwitches({ version: "user-version", rag: false });
  assert.deepEqual(required(writes().at(-1)).edits, [
    { keyPath: "mcp_servers.rag.enabled", value: false, mergeStrategy: "replace" },
  ]);
  assert.equal(
    socket.sent.some(message => message.method === "config/mcpServer/reload"),
    true,
    "MCP servers reload after the RAG switch",
  );
  configRead.config.features.multi_agent = false;
  required(configRead.config.mcp_servers.rag).enabled = false;
  assert.deepEqual(await client.contextSwitches(), {
    version: "user-version",
    write: { available: true },
    smartPrune: true,
    subagents: false,
    rag: false,
  });
  await assert.rejects(
    client.saveContextSwitches({ version: "old-version", rag: true }),
    error => error !== null && typeof error === "object" && "status" in error && error.status === 409,
  );
  await assert.rejects(client.saveContextSwitches({ version: "user-version", rag: "yes" }), /on or off/);
  await assert.rejects(
    client.saveContextSwitches({ version: "user-version", memories: true }),
    /Unsupported request fields/,
  );
  await assert.rejects(client.saveContextSwitches({ version: "user-version" }), /No switch/);
  delete configRead.config.mcp_servers.rag;
  assert.equal((await client.contextSwitches()).rag, null, "no rag server configured: no RAG switch to flip");
  await assert.rejects(
    client.saveContextSwitches({ version: "user-version", rag: true }),
    error => error !== null && typeof error === "object" && "status" in error && error.status === 409,
  );

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-desktop-test-"));
  const out = path.join(temp, "out");
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, "index.html"), "<h1>Elpis</h1>");
  const app = await startDesktopServer({ client, staticDir: out });
  t.after(() => app.close());
  const url = new URL(app.url),
    origin = url.origin,
    token = new URLSearchParams(url.hash.slice(1)).get("token");
  const request = (method: string, data?: unknown, headers = {}) =>
    fetch(origin + "/api/context/switches", {
      method,
      headers: { "Content-Type": "application/json", Origin: origin, ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  assert.equal((await request("GET")).status, 401);
  const auth = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token }),
  });
  const cookie = required(required(auth.headers.get("set-cookie")).split(";")[0]);
  assert.equal((await (await request("GET", null, { Cookie: cookie })).json()).subagents, false);
  const saved = await request("POST", { version: "user-version", subagents: true }, { Cookie: cookie });
  assert.equal(saved.status, 200);
  assert.deepEqual(required(writes().at(-1)).edits, [
    { keyPath: "features.multi_agent", value: true, mergeStrategy: "replace" },
  ]);
  client.close();
});

test("the main model is saved where the TUI reads it: model and model_provider in config.toml", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  await client.saveSettings({ version: "user-version", main: { model: "gpt-6-luna", provider: "openai" } });
  assert.deepEqual(required(required(socket.sent.find(row => row.method === "config/batchWrite")).params).edits, [
    { keyPath: "model", value: "gpt-6-luna", mergeStrategy: "replace" },
    { keyPath: "model_provider", value: "openai", mergeStrategy: "replace" },
  ]);
  await assert.rejects(client.saveSettings({ version: "user-version", main: { model: null } }), /Choose a main model/);
  client.close();
});

test("maintenance edits are narrow, preserve unknowns, and reject stale versions before mutation", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  await client.saveSettings({
    version: "user-version",
    background: { model: "gpt-6-luna", provider: "openai" },
    memory: { use: false },
  });
  assert.deepEqual(required(socket.sent.find(row => row.method === "config/batchWrite")).params, {
    expectedVersion: "user-version",
    reloadUserConfig: false,
    edits: [
      { keyPath: "background_model", value: "gpt-6-luna", mergeStrategy: "replace" },
      { keyPath: "background_provider", value: "openai", mergeStrategy: "replace" },
      { keyPath: "memories.use_memories", value: false, mergeStrategy: "replace" },
    ],
  });
  const writes = () => socket.sent.filter(row => row.method === "config/batchWrite").length;
  await assert.rejects(client.saveSettings({ version: "outdated", memory: { use: true } }), /Reload settings/);
  await assert.rejects(
    client.saveSettings({ version: "user-version", memory: { generate: null } }),
    /enabled or disabled/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", background: { provider: "unknown" } }),
    /configured provider/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", main: { provider: "unknown" } }),
    /configured provider/,
  );
  await assert.rejects(client.saveSettings({ version: "user-version", main: { effort: "high" } }), /Unsupported/);
  await assert.rejects(
    client.saveSettings({ version: "user-version", memory: { admissionPolicy: "all" } }),
    /Unsupported/,
  );
  assert.equal(writes(), 1);
  await assert.rejects(
    client.savePruner({ version: "v1", model: "cheap", provider: "openai" }),
    /running Elpis version/,
  );
  assert.equal(
    socket.sent.some(row => row.method === "pruner/write"),
    false,
  );
  assert.equal(configRead.config.model, MODEL);
  client.close();
});

test("settings pages read and write only listed native options, respecting managed policy", async () => {
  const { client, socket, configRead, requirementsRead } = fixture();
  await client.initialize();
  Object.assign(configRead.config, {
    approval_policy: { granular: { sandbox_approval: true } },
    sandbox_mode: "workspace-write",
    service_tier: "priority",
    developer_instructions: "Be brief.",
    project_root_markers: [".git", ".hg"],
    desktop: { "git-worktree-root": "/work/trees" },
  });
  configRead.config.features.memories = true;
  configRead.config.memories.disable_on_external_context = true;
  const settings = await client.settings();
  assert.deepEqual(settings.options, {
    reasoningEffort: null,
    defaultPermissions: "custom",
    webSearch: null,
    verbosity: null,
    reasoningSummary: null,
    serviceTier: "fast",
    developerInstructions: "Be brief.",
    projectRootMarkers: [".git", ".hg"],
    worktreeRoot: "/work/trees",
  });
  assert.equal(settings.memory.enabled, true);
  assert.equal(settings.memory.skipExternalContext, true);
  await client.saveSettings({
    version: "user-version",
    options: {
      webSearch: null,
      developerInstructions: "  ",
      projectRootMarkers: [" .git ", "package.json"],
      worktreeRoot: "/tmp/trees",
    },
    memory: { enabled: false, skipExternalContext: false },
  });
  assert.deepEqual(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params, {
    expectedVersion: "user-version",
    reloadUserConfig: false,
    edits: [
      { keyPath: "features.memories", value: false, mergeStrategy: "replace" },
      { keyPath: "memories.disable_on_external_context", value: false, mergeStrategy: "replace" },
      { keyPath: "web_search", value: null, mergeStrategy: "replace" },
      { keyPath: "developer_instructions", value: null, mergeStrategy: "replace" },
      { keyPath: "project_root_markers", value: [".git", "package.json"], mergeStrategy: "replace" },
      { keyPath: "desktop.git-worktree-root", value: "/tmp/trees", mergeStrategy: "replace" },
    ],
  });
  const writes = () => socket.sent.filter(row => row.method === "config/batchWrite").length;
  const before = writes();
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { model: "other" } }),
    /Unsupported setting/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { defaultPermissions: "everything" } }),
    /listed values/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { worktreeRoot: "relative/trees" } }),
    /absolute folder/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { projectRootMarkers: ["../up"] } }),
    /without slashes/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { projectRootMarkers: [] } }),
    /one to sixteen/,
  );
  requirementsRead.requirements = { allowedSandboxModes: ["read-only"] };
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { defaultPermissions: "full" } }),
    error =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 403 &&
      "message" in error &&
      typeof error.message === "string" &&
      /managed/.test(error.message),
  );
  requirementsRead.requirements = { allowedPermissionProfiles: { ":workspace": true } };
  assert.deepEqual((await client.settings()).managed.allowedPermissionProfiles, { ":workspace": true });
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { defaultPermissions: "full" } }),
    error =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 403 &&
      "message" in error &&
      typeof error.message === "string" &&
      /managed/.test(error.message),
  );
  requirementsRead.requirements = { allowedApprovalsReviewers: ["user"] };
  assert.deepEqual((await client.settings()).managed.allowedApprovalsReviewers, ["user"]);
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { defaultPermissions: "auto" } }),
    error =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 403 &&
      "message" in error &&
      typeof error.message === "string" &&
      /managed/.test(error.message),
  );
  assert.equal(writes(), before, "refused options write nothing");
  client.close();
});

test("a chat started without a mode gets the default one explicitly, so the engine fallback (asking) never decides it", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  const started = async (body = {}) => {
    await client.createThread(body);
    const { approvalPolicy, approvalsReviewer, permissions } = required(
      required(socket.sent.findLast(row => row.method === "thread/start")).params,
    );
    return { approvalPolicy, approvalsReviewer, permissions };
  };
  Object.assign(configRead.config, { default_permissions: ":danger-full-access" });
  assert.deepEqual(await started(), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    permissions: ":danger-full-access",
  });
  assert.deepEqual(await started({ cwd: "/tmp/project" }), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    permissions: ":danger-full-access",
  });
  assert.equal(
    required(required(socket.sent.findLast(row => row.method === "config/read")).params).cwd,
    "/tmp/project",
    "the project folder's own config layers count",
  );
  configRead.config.approval_policy = "on-request";
  configRead.config.default_permissions = ":workspace";
  assert.deepEqual(await started(), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    permissions: ":workspace",
  });
  assert.deepEqual(
    await started({ permissions: "bypass" }),
    { approvalPolicy: "never", approvalsReviewer: "user", permissions: ":bypass-permissions" },
    "a chosen mode wins",
  );
  configRead.config.default_permissions = ":read-only";
  assert.deepEqual(
    await started(),
    { approvalPolicy: undefined, approvalsReviewer: undefined, permissions: undefined },
    "a custom config is left to the engine",
  );
  client.close();
});

test("default permissions: Full access when the config names no approval policy; each preset saves approval, reviewer and sandbox together", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  const user = configRead.layers[0];
  const mode = async () => (await client.settings()).options.defaultPermissions;
  const save = async (defaultPermissions: string) => {
    await client.saveSettings({ version: "user-version", options: { defaultPermissions } });
    return required(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params).edits;
  };
  // As Masih's config: a full-access profile and no approval policy. The engine alone would ask (on-request).
  Object.assign(configRead.config, { default_permissions: ":danger-full-access", approvals_reviewer: "user" });
  required(user).config.default_permissions = ":danger-full-access";
  assert.equal(await mode(), "full");
  configRead.config.default_permissions = required(user).config.default_permissions = ":workspace";
  assert.equal(await mode(), "full", "no approval policy is the Elpis default, Full access");
  configRead.config.approval_policy = "on-request";
  assert.equal(await mode(), "ask");
  configRead.config.approvals_reviewer = "auto_review";
  assert.equal(await mode(), "auto");
  Object.assign(configRead.config, { approval_policy: "never", default_permissions: ":danger-full-access" });
  assert.equal(await mode(), "full");
  configRead.config.default_permissions = ":bypass-permissions";
  assert.equal(await mode(), "custom", "Bypass is per chat, never a Settings preset");
  configRead.config.default_permissions = ":read-only";
  assert.equal(await mode(), "custom");
  const preset = (approval: string, reviewer: string, key: string, sandbox: string) => [
    { keyPath: "approval_policy", value: approval, mergeStrategy: "replace" },
    { keyPath: "approvals_reviewer", value: reviewer, mergeStrategy: "replace" },
    { keyPath: key, value: sandbox, mergeStrategy: "replace" },
  ];
  assert.deepEqual(await save("full"), preset("never", "user", "default_permissions", ":danger-full-access"));
  assert.deepEqual(await save("ask"), preset("on-request", "user", "default_permissions", ":workspace"));
  assert.deepEqual(await save("auto"), preset("on-request", "auto_review", "default_permissions", ":workspace"));
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { defaultPermissions: "bypass" } }),
    /listed values/,
  );
  await assert.rejects(
    client.saveSettings({ version: "user-version", options: { defaultPermissions: null } }),
    /listed values/,
  );
  // A config without profiles keeps the legacy key.
  delete configRead.config.default_permissions;
  delete required(user).config.default_permissions;
  Object.assign(configRead.config, {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    approvals_reviewer: "user",
  });
  required(user).config.sandbox_mode = "workspace-write";
  assert.equal(await mode(), "ask");
  assert.deepEqual(await save("full"), preset("never", "user", "sandbox_mode", "danger-full-access"));
  client.close();
});

// Antigravity's usage vanished ("Usage not reported") after being shown: a model list that timed out read as "no
// subscription models", so the app took the subscriptions for signed out and dropped their usage. Unknown is not signed out.
test("a model list that cannot be read leaves the subscriptions unknown, not signed out", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const fail = (message: string) => {
      socket.sent.push(request);
      queueMicrotask(() =>
        socket.emit("message", JSON.stringify({ id: request.id, error: { code: -32000, message } })),
      );
    };
    if (request.method === "model/list") return fail("model/list timed out");
    // The subscriptions' limits were slower than the bridge waits, so only ChatGPT's came back.
    if (request.method === "account/rateLimits/read") {
      socket.sent.push(request);
      queueMicrotask(() =>
        socket.emit(
          "message",
          JSON.stringify({
            id: request.id,
            result: { rateLimits: { limitId: "codex", primary: null }, rateLimitsByLimitId: {} },
          }),
        ),
      );
      return;
    }
    return send(raw);
  };
  const providers = await client.providers();
  assert.deepEqual([providers.claude.state, providers.gemini.state], ["unknown", "unknown"]);
  assert.deepEqual([providers.claude.usage, providers.gemini.usage], [[], []]);
  socket.send = send;
  // A list that was read and offers no Antigravity model does mean it is not connected.
  const { providersSnapshot } = await import("./elpis-features.mts");
  assert.equal(
    providersSnapshot({ account: null, limits: {}, config: {}, models: [], anthropic: null }).gemini.state,
    "notConnected",
  );
  // Elpis's own Anthropic sign-out stays a sign-out whatever the list says.
  assert.equal(
    providersSnapshot({ account: null, limits: {}, config: {}, models: null, anthropic: { signedOut: true } }).claude
      .state,
    "notConnected",
  );
  client.close();
});
