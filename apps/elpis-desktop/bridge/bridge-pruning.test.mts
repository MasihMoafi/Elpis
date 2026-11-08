import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { startDesktopServer } from "./server.mts";
import { required, ROOT, CHILD, MODEL, fixture } from "./bridge.fixtures.mts";

test("internal gateway routes are neither local servers nor editable custom providers", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  // How config/read reports a provider the engine routes through its own gateway (here, the Anthropic credits).
  configRead.config.model_providers["anthropic-credits"] = {
    name: "Anthropic promotional credits",
    base_url: "http://127.0.0.1:44103/v1",
    wire_api: "responses",
    requires_openai_auth: false,
    http_headers: {
      "x-elpis-gateway-token": "GATEWAY SECRET",
      "x-elpis-provider": "anthropic-credits",
      "x-elpis-wire": "anthropic_messages",
      "x-elpis-upstream": "https://api.anthropic.com/v1",
    },
  };
  const providers = await client.providers();
  assert.equal("local" in providers, false);
  assert.doesNotMatch(JSON.stringify(providers), /anthropic-credits|44103/);
  const settings = await client.providerSettings();
  const credits = settings.providers.find(provider => provider.id === "anthropic-credits");
  assert.equal(required(credits).gateway, true);
  assert.equal(required(credits).editable, false);
  assert.equal(required(credits).auth.acceptsKey, false);
  assert.equal(required(settings.providers.find(provider => provider.id === "openrouter")).gateway, false);
  assert.doesNotMatch(JSON.stringify(settings), /GATEWAY SECRET/);
  await assert.rejects(
    client.saveProvider({
      version: "user-version",
      id: "anthropic-credits",
      name: "Changed",
      baseUrl: "https://api.anthropic.com/v1",
      credential: { action: "preserve" },
    }),
    error => error !== null && typeof error === "object" && "status" in error && error.status === 403,
  );
  assert.equal(
    socket.sent.filter(row => row.method === "config/batchWrite").length,
    0,
    "an internal route is never rewritten",
  );
  // Its models come from the gateway's own list, so a chat can start on one of them.
  await client.createThread({ provider: "anthropic-credits", model: "claude-sonnet-5-5" });
  const start = required(socket.sent.findLast(row => row.method === "thread/start")).params;
  assert.deepEqual([required(start).model, required(start).modelProvider], ["claude-sonnet-5-5", "anthropic-credits"]);
  client.close();
});

test("hooks list native discovery and change only hooks.state for a listed, unmanaged hook", async () => {
  const { client, socket, hooksList } = fixture();
  await client.initialize();
  const hooks = await client.hooks();
  assert.equal(hooks.version, "user-version");
  assert.deepEqual(hooks.warnings, ["hooks.json: unknown field ignored"]);
  assert.deepEqual(
    hooks.hooks.map(hook => [hook.event, hook.command, hook.trust, hook.managed]),
    [
      ["preToolUse", "rtk hook claude", "untrusted", false],
      ["stop", "audit", "managed", true],
    ],
  );
  const key = required(required(hooksList.data[0]).hooks[0]).key;
  await client.saveHook({ version: "user-version", key, trust: true });
  await client.saveHook({ version: "user-version", key, enabled: false });
  assert.deepEqual(
    socket.sent.filter(row => row.method === "config/batchWrite").map(row => row.params),
    [
      {
        edits: [
          { keyPath: "hooks.state", value: { [key]: { trusted_hash: "sha256:current" } }, mergeStrategy: "upsert" },
        ],
        expectedVersion: "user-version",
        reloadUserConfig: true,
      },
      {
        edits: [{ keyPath: "hooks.state", value: { [key]: { enabled: false } }, mergeStrategy: "upsert" }],
        expectedVersion: "user-version",
        reloadUserConfig: true,
      },
    ],
  );
  await assert.rejects(
    client.saveHook({
      version: "user-version",
      key: required(required(hooksList.data[0]).hooks[1]).key,
      enabled: false,
    }),
    /Managed hooks/,
  );
  await assert.rejects(
    client.saveHook({ version: "user-version", key: "user:/missing:stop:0:0", enabled: false }),
    /no longer configured/,
  );
  await assert.rejects(client.saveHook({ version: "outdated", key, enabled: true }), /Reload settings/);
  await assert.rejects(
    client.saveHook({ version: "user-version", key, enabled: true, trust: true }),
    /enable, disable or trust/,
  );
  await assert.rejects(client.saveHook({ version: "user-version", key, trust: false }), /confirmed/);
  assert.equal(socket.sent.filter(row => row.method === "config/batchWrite").length, 2);
  await client.resetMemories({});
  assert.equal(socket.sent.filter(row => row.method === "memory/reset").length, 1);
  await assert.rejects(client.resetMemories({ all: true }), /Unsupported/);
  client.close();
});

test("pruning override edits preserve separation and reject stale or incomplete pairs", async () => {
  const { client, socket, configRead } = fixture({ prunerSupported: true });
  await client.initialize();
  const initial = await client.settings();
  assert.equal(initial.smartPrune.explicitOverride.model, "optimizer-original");
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE CONFIG SECRET|systemPrompt/);
  await assert.rejects(client.savePruner({ version: "pruner-v1", model: "gpt-6-luna", provider: null }), /provider ID/);
  await assert.rejects(
    client.savePruner({ version: "outdated", model: "gpt-6-luna", provider: "openai" }),
    /Reload settings/,
  );
  await assert.rejects(
    client.savePruner({ version: "pruner-v1", model: "gpt-6-luna", provider: "unknown" }),
    /configured provider/,
  );
  await assert.rejects(
    client.savePruner({ version: "pruner-v1", model: null, provider: null, systemPrompt: "replace" }),
    /Unsupported/,
  );
  assert.equal(
    socket.sent.some(row => row.method === "pruner/write"),
    false,
  );
  const changed = await client.savePruner({ version: "pruner-v1", model: "gpt-6-luna", provider: "openai" });
  assert.equal(changed.smartPrune.explicitOverride.model, "gpt-6-luna");
  assert.deepEqual(required(socket.sent.find(row => row.method === "pruner/write")).params, {
    expectedVersion: "pruner-v1",
    model: "gpt-6-luna",
    provider: "openai",
  });
  const cleared = await client.savePruner({ version: "pruner-v2", model: null, provider: null });
  assert.equal(cleared.smartPrune.explicitOverride.model, null);
  assert.equal(configRead.config.model, MODEL);
  assert.equal(configRead.config.background_model, "cheap-model");
  assert.equal(
    socket.sent.some(row => row.method === "config/batchWrite"),
    false,
  );
  client.close();
});

test("pruning effort round trips through the shared pruner RPC and Default clears it", async t => {
  const { client, socket, configRead } = fixture({ prunerSupported: true });
  t.after(() => client.close());
  await client.initialize();
  const choice = { model: "gpt-6-luna", provider: "openai" };
  const saved = await client.savePruner({ version: "pruner-v1", ...choice, reasoningEffort: "max" });
  assert.deepEqual(required(socket.sent.find(row => row.method === "pruner/write")).params, {
    expectedVersion: "pruner-v1",
    ...choice,
    reasoningEffort: "max",
  });
  assert.equal(saved.smartPrune.explicitOverride.reasoningEffort, "max");
  assert.equal((await client.settings()).smartPrune.explicitOverride.reasoningEffort, "max");
  const cleared = await client.savePruner({ version: "pruner-v2", ...choice, reasoningEffort: null });
  assert.equal(cleared.smartPrune.explicitOverride.reasoningEffort, null);
  assert.equal(
    required(required(socket.sent.filter(row => row.method === "pruner/write").at(-1)).params).reasoningEffort,
    null,
  );
  assert.equal(configRead.config.model, MODEL);
  assert.equal(
    socket.sent.some(row => row.method === "config/batchWrite"),
    false,
  );
});

test("pruning effort stays unset when omitted and rejects malformed efforts before writing", async t => {
  const { client, socket } = fixture({ prunerSupported: true });
  t.after(() => client.close());
  await client.initialize();
  const choice = { version: "pruner-v1", model: "gpt-6-luna", provider: "openai" };
  assert.equal((await client.settings()).smartPrune.explicitOverride.reasoningEffort, null);
  for (const reasoningEffort of ["", "Max", "high effort", "a".repeat(17), 7, {}, false]) {
    await assert.rejects(client.savePruner({ ...choice, reasoningEffort }), /reasoning effort/);
  }
  assert.equal(
    socket.sent.some(row => row.method === "pruner/write"),
    false,
  );
  const saved = await client.savePruner(choice);
  assert.equal(saved.smartPrune.explicitOverride.reasoningEffort, null);
  assert.equal(
    Object.hasOwn(required(required(socket.sent.find(row => row.method === "pruner/write")).params), "reasoningEffort"),
    false,
  );
});

test("desktop server closes even when a local request body never finishes", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const app = await startDesktopServer({ client });
  const url = new URL(app.url);
  const pending = net.createConnection({ host: url.hostname, port: Number(url.port) });
  await new Promise(resolve => pending.once("connect", resolve));
  pending.write("POST /api/session HTTP/1.1\r\nHost: " + url.host + "\r\nContent-Length: 1024\r\n\r\n{");
  await new Promise(resolve => setTimeout(resolve, 30));
  const closed = app.close();
  let timer;
  const completed = await Promise.race([
    closed.then(() => true),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 500);
    }),
  ]);
  clearTimeout(timer);
  pending.destroy();
  await closed;
  assert.equal(completed, true, "quitting cannot wait indefinitely for an unfinished HTTP body");
  assert.equal(socket.closed, true, "desktop detaches its connection to the native runtime");
});

test("permission modes become Elpis approval and sandbox settings, and resume reports the mode", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  try {
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "go", permissions: "full" });
    const full = required(socket.sent.findLast(message => message.method === "turn/start")).params;
    // Each mode is a named profile: the engine restores a profile id after a restart, not a bare sandbox.
    assert.deepEqual(
      [
        required(full).approvalPolicy,
        required(full).approvalsReviewer,
        required(full).permissions,
        "sandboxPolicy" in required(full),
      ],
      ["never", "user", ":danger-full-access", false],
    );
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "again", permissions: "auto" });
    const auto = required(socket.sent.findLast(message => message.method === "turn/start")).params;
    assert.deepEqual(
      [
        required(auto).approvalPolicy,
        required(auto).approvalsReviewer,
        required(auto).permissions,
        "sandboxPolicy" in required(auto),
      ],
      ["on-request", "auto_review", ":workspace", false],
    );
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "plain" });
    const plain = required(socket.sent.findLast(message => message.method === "turn/start")).params;
    assert.equal(
      "approvalPolicy" in required(plain) || "sandboxPolicy" in required(plain),
      false,
      "no mode chosen leaves the chat as configured",
    );
    await assert.rejects(client.send(ROOT, { text: "x", permissions: "root" }), /permission mode/);
    await client.createThread({ permissions: "ask" });
    const started = required(socket.sent.findLast(message => message.method === "thread/start")).params;
    assert.deepEqual(
      [
        required(started).approvalPolicy,
        required(started).approvalsReviewer,
        required(started).permissions,
        "sandbox" in required(started),
      ],
      ["on-request", "user", ":workspace", false],
    );
  } finally {
    client.close();
  }
});

test("an agent chat can keep its own permission choice without forking or changing its parent", async () => {
  const { client, engineSettings, socket } = fixture();
  await client.initialize();
  try {
    const parent = structuredClone(engineSettings.get(ROOT));
    assert.equal((await client.setPermissions(CHILD, { permissions: "full" })).permissions, "full");
    assert.equal(required(engineSettings.get(CHILD)).approvalPolicy, "never");
    assert.deepEqual(engineSettings.get(ROOT), parent);
    assert.equal(
      socket.sent.some(row => row.method === "thread/fork"),
      false,
    );
  } finally {
    client.close();
  }
});

test("a running chat the list already follows still reports its mode, Plan and effort when opened", async () => {
  const { client, threads, engineSettings } = fixture();
  await client.initialize();
  try {
    Object.assign(required(threads.get(ROOT)), { status: { type: "active" }, collaborationMode: { mode: "plan" } });
    engineSettings.set(ROOT, {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      activePermissionProfile: null,
      reasoningEffort: "xhigh",
    });
    await client.listThreads({});
    await new Promise(resolve => setTimeout(resolve, 10)); // the list follows the running chat in the background
    const opened = await client.resume(ROOT, {});
    assert.equal(opened.permissions, "full");
    assert.equal(opened.planMode, true);
    assert.equal(opened.thread.reasoningEffort, "xhigh");
    assert.equal(opened.activeTurnId, "running-turn");
    // A chat left as configured reports Ask for approval, not Full access.
    delete required(threads.get(ROOT)).collaborationMode;
    engineSettings.set(ROOT, {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite" },
      activePermissionProfile: null,
      reasoningEffort: null,
    });
    const again = await client.resume(ROOT, {});
    assert.equal(again.permissions, "ask");
    assert.equal(again.planMode, false);
  } finally {
    client.close();
  }
});

test("bypass permissions selects the engine profile, never a sandbox, and resume reports it", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  try {
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "go", permissions: "bypass" });
    const turn = required(socket.sent.findLast(message => message.method === "turn/start")).params;
    assert.deepEqual(
      [required(turn).approvalPolicy, required(turn).approvalsReviewer, required(turn).permissions],
      ["never", "user", ":bypass-permissions"],
    );
    assert.equal("sandboxPolicy" in required(turn), false, "the engine rejects a profile combined with a sandbox");
    await client.createThread({ permissions: "bypass" });
    const started = required(socket.sent.findLast(message => message.method === "thread/start")).params;
    assert.deepEqual(
      [required(started).approvalPolicy, required(started).approvalsReviewer, required(started).permissions],
      ["never", "user", ":bypass-permissions"],
    );
    assert.equal("sandbox" in required(started), false);
    // Leaving bypass for Full access selects the full-access profile, which replaces the bypass profile.
    required(threads.get(ROOT)).status = { type: "idle" };
    await client.send(ROOT, { text: "calmer", permissions: "full" });
    const full = required(socket.sent.findLast(message => message.method === "turn/start")).params;
    assert.deepEqual([required(full).permissions, "sandboxPolicy" in required(full)], [":danger-full-access", false]);
  } finally {
    client.close();
  }
  // A chat reopens in the mode the engine reports; only the bypass profile reads as bypass.
  const reopened = async (reported: Record<string, unknown>) => {
    const { client, socket, threads } = fixture();
    await client.initialize();
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method !== "thread/resume") return send(raw);
      socket.sent.push(request);
      queueMicrotask(() =>
        socket.emit(
          "message",
          JSON.stringify({
            id: request.id,
            result: {
              thread: structuredClone(threads.get(request.params.threadId)),
              model: MODEL,
              initialTurnsPage: { data: [] },
              ...reported,
            },
          }),
        ),
      );
    };
    try {
      return (await client.resume(ROOT, {})).permissions;
    } finally {
      client.close();
    }
  };
  const unsandboxed = { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
  assert.equal(await reopened({ ...unsandboxed, activePermissionProfile: { id: ":bypass-permissions" } }), "bypass");
  assert.equal(await reopened({ ...unsandboxed, activePermissionProfile: { id: ":danger-full-access" } }), "full");
  assert.equal(await reopened({ ...unsandboxed, activePermissionProfile: null }), "full");
  assert.equal(
    await reopened({
      ...unsandboxed,
      approvalPolicy: "on-request",
      activePermissionProfile: { id: ":bypass-permissions" },
    }),
    "ask",
    "bypass needs approvals set to never",
  );
});

test("a chat can change folders during a turn through native settings for later turns", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-move-")));
  const nextDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "elpis-move-next-")));
  try {
    assert.deepEqual(await client.setFolder(ROOT, { cwd: dir }), { cwd: dir });
    assert.deepEqual(required(socket.sent.findLast(message => message.method === "thread/settings/update")).params, {
      threadId: ROOT,
      cwd: dir,
    });
    assert.equal(required(threads.get(ROOT)).cwd, dir, "the engine holds the new folder");
    for (const cwd of ["relative/folder", path.join(dir, "missing"), 42])
      await assert.rejects(client.setFolder(ROOT, { cwd }), /folder/i);
    required(threads.get(ROOT)).status = { type: "active" };
    const updates = socket.sent.filter(message => message.method === "thread/settings/update").length;
    assert.deepEqual(await client.setFolder(ROOT, { cwd: nextDir }), { cwd: nextDir });
    assert.equal(required(threads.get(ROOT)).status.type, "active", "the running turn stays active");
    assert.equal(required(threads.get(ROOT)).cwd, nextDir, "the engine saves the new folder for later turns");
    assert.equal(socket.sent.filter(message => message.method === "thread/settings/update").length, updates + 1);
    assert.deepEqual(required(socket.sent.findLast(message => message.method === "thread/settings/update")).params, {
      threadId: ROOT,
      cwd: nextDir,
    });
  } finally {
    client.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(nextDir, { recursive: true, force: true });
  }
});
