import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { compileFunction } from "node:vm";
import { DesktopClient } from "./client.mts";
import { startDesktopServer } from "./server.mts";
import { isAgentRun } from "../lib/agent-runs.mts";
import { required, ROOT, CREATED, MODEL, FORK, fixture } from "./bridge.fixtures.mts";

test("LEDGER uses native marketplace/catalog/plugin methods and versioned plugin config; rejects forged or stale changes", async () => {
  const f = fixture();
  const plugin = { id: "docs@ledger", name: "docs", installed: false, enabled: false, installPolicy: "AVAILABLE" };
  const marketplace = { name: "ledger", path: "/catalog/.claude-plugin/marketplace.json", plugins: [plugin] };
  const send = f.socket.send;
  let rejectInstall = false;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    let result;
    if (request.method === "skills/list") result = { data: [] };
    else if (request.method === "plugin/list") result = { marketplaces: [marketplace] };
    else if (request.method === "plugin/installed")
      result = { marketplaces: [{ ...marketplace, plugins: plugin.installed ? [plugin] : [] }] };
    else if (request.method === "plugin/search")
      result = { data: [{ plugin, marketplaceName: "ledger", marketplacePath: marketplace.path }], nextCursor: "next" };
    else if (request.method === "plugin/install") {
      if (!rejectInstall) {
        plugin.installed = true;
        plugin.enabled = true;
      }
      result = { appsNeedingAuth: [{ name: "Calendar", secret: "private" }] };
    } else if (request.method === "plugin/uninstall") {
      plugin.installed = false;
      result = {};
    } else if (request.method === "marketplace/add" || request.method === "marketplace/remove") result = {};
    else return send(raw);
    f.socket.sent.push(request);
    queueMicrotask(() =>
      f.socket.emit(
        "message",
        JSON.stringify(
          rejectInstall && request.method === "plugin/install"
            ? { id: request.id, error: { code: -32602, message: "Plugin blocked by policy" } }
            : { id: request.id, result },
        ),
      ),
    );
  };
  f.client.close();
  // Give customize the same isolated GitHub connector used by production, without invoking a command.
  f.socket.closed = false;
  const client = new DesktopClient(f.socket, {
    githubConnector: { snapshot: async () => ({ name: "GitHub", transport: "gh", enabled: false }) },
  });
  await client.initialize();
  try {
    const last = (method: string) => f.socket.sent.findLast(row => row.method === method)?.params;
    for (const source of [
      "owner/repo",
      "https://example.org/catalog.git",
      "git@example.org:owner/catalog.git",
      "/catalog",
    ]) {
      await client.changeMarketplace({ action: "add", source });
      assert.deepEqual(last("marketplace/add"), { source });
    }
    const found = await client.pluginCatalog({ cwd: "/workspace", search: "docs", cursor: "old-page" });
    assert.equal(found.nextCursor, "next");
    assert.deepEqual(last("plugin/search"), {
      cwds: ["/workspace"],
      searchTerm: "docs",
      cursor: "old-page",
      limit: 50,
    });
    const result = await client.changePlugin({ action: "install", id: plugin.id });
    assert.deepEqual(last("plugin/install"), { pluginName: "docs", marketplacePath: marketplace.path });
    assert.deepEqual(result.appsNeedingAuth, [{ name: "Calendar" }]);
    assert.equal(result.plugins.version, "user-version");
    await client.changePlugin({ action: "enable", id: plugin.id, enabled: false, version: "user-version" });
    assert.deepEqual(last("config/batchWrite"), {
      expectedVersion: "user-version",
      reloadUserConfig: true,
      edits: [{ keyPath: 'plugins."docs@ledger".enabled', value: false, mergeStrategy: "replace" }],
    });
    const writes = () =>
      f.socket.sent.filter(
        row =>
          row.method !== undefined &&
          ["plugin/install", "plugin/uninstall", "config/batchWrite", "marketplace/add"].includes(row.method ?? ""),
      ).length;
    const before = writes();
    await assert.rejects(
      client.changePlugin({ action: "enable", id: plugin.id, enabled: false, version: "stale" }),
      /changed in another client/,
    );
    await assert.rejects(
      client.changePlugin({ action: "enable", id: "forged@market", enabled: false, version: "user-version" }),
      /not installed/,
    );
    await assert.rejects(
      client.changePlugin({ action: "enable", id: plugin.id, enabled: "false", version: "user-version" }),
      /on or off/,
    );
    await assert.rejects(
      client.changeMarketplace({ action: "add", source: "/catalog", cwd: "relative" }),
      /project folder/,
    );
    await assert.rejects(client.changePlugin({ action: "install", id: "forged@market" }), /not listed/);
    assert.equal(writes(), before);
    await client.changePlugin({ action: "uninstall", id: plugin.id });
    assert.deepEqual(last("plugin/uninstall"), { pluginId: plugin.id });
    plugin.installPolicy = "NOT_AVAILABLE";
    await assert.rejects(client.changePlugin({ action: "install", id: plugin.id }), /Installation unavailable/);
    plugin.installPolicy = "AVAILABLE";
    rejectInstall = true;
    await assert.rejects(client.changePlugin({ action: "install", id: plugin.id }), /Plugin blocked by policy/);
    await client.changeMarketplace({ action: "remove", name: "ledger" });
    assert.deepEqual(last("marketplace/remove"), { marketplaceName: "ledger" });
  } finally {
    client.close();
  }
});

test("conversation pages keep a full page of chats when recent agent runs outnumber them", async () => {
  const f = fixture({ threadListPaging: true });
  f.threads.clear();
  const chats = [];
  for (let i = 0; i < 120; i++) {
    const chat = { id: randomUUID(), name: `Synthetic chat ${i}`, source: "vscode", status: { type: "idle" } };
    chats.push(chat);
    f.threads.set(chat.id, chat);
    for (let j = 0; j < 2; j++) {
      const run = {
        id: randomUUID(),
        source: j ? { subAgent: { thread_spawn: {} } } : "exec",
        parentThreadId: chat.id,
        status: { type: "idle" },
      };
      f.threads.set(run.id, run);
    }
  }
  const { transpileModule, ModuleKind } = await import("typescript");
  const source = await fs.readFile(new URL("../lib/conversation-page.ts", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const loaded = {} as typeof import("../lib/conversation-page.ts");
  compileFunction(compiled, ["exports", "require"])(loaded, (id: string) => {
    assert.equal(id, "./api");
    return { isAgentRun };
  });
  const server = await startDesktopServer({ client: f.client });
  try {
    const url = new URL(server.url),
      origin = url.origin;
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    const session = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ token }),
    });
    assert.equal(session.status, 200);
    const setCookie = session.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = required(setCookie.split(";")[0]);
    const request = async (route: string) => {
      const response = await fetch(`${origin}/api${route}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await loaded.loadConversationPage(request);
    assert.equal(first.data.filter(thread => !isAgentRun(thread)).length, 100);
    assert.deepEqual(
      first.data.filter(thread => !isAgentRun(thread)).map(thread => thread.id),
      chats.slice(0, 100).map(thread => thread.id),
    );
    assert.ok(first.data.some(isAgentRun), "recent background runs remain available in their own section");
    assert.equal(first.nextCursor, "100");
    const second = await loaded.loadConversationPage(request, first.nextCursor);
    assert.deepEqual(
      second.data.map(thread => thread.id),
      chats.slice(100).map(thread => thread.id),
    );
    assert.equal(second.nextCursor, null);
    const queries = f.socket.sent.filter(request => request.method === "thread/list");
    assert.equal(
      queries.filter(
        request =>
          !required(request.params).sourceKinds?.length || required(request.params).sourceKinds?.includes("exec"),
      ).length,
      1,
      "background runs are refreshed separately from chat pagination",
    );
  } finally {
    await server.close();
    f.client.close();
  }
});

test("Subagents permits optional delegation and refreshes its policy on the next turn of a loaded chat", async () => {
  const { client, socket, threads, configRead } = fixture();
  try {
    await client.initialize();
    await client.resume(ROOT, {});
    const policies = new Set();
    for (const enabled of [undefined, false, true, true]) {
      configRead.config.features.multi_agent = enabled;
      required(threads.get(ROOT)).status = { type: "idle" };
      await client.send(ROOT, { text: "Please solve this task" });
      const params = required(socket.sent.findLast(row => row.method === "turn/start")).params;
      const policy = required(params).additionalContext?.["elpis.subagents"];
      assert.ok(policy);
      assert.equal(policy?.kind, "application", "the setting reaches the model as application instructions");
      policies.add(policy.value);
      if (enabled === false) {
        assert.match(policy.value, /earlier instructions.*delegation.*no longer apply/);
        assert.match(policy.value, /Subagents are disabled/);
        assert.match(policy.value, /Do not start, resume, or delegate/);
        assert.match(policy.value, /even when a user request, AGENTS.md, or skill asks/);
        assert.match(policy.value, /shell-launched agents \(claude, codex, agy, elpis, gemini\)/);
        assert.match(policy.value, /MCP delegate tools/);
      } else {
        assert.match(policy.value, /earlier instructions.*delegation.*no longer apply/);
        assert.match(policy.value, /work directly or delegate/);
        assert.match(policy.value, /never requires spawning an agent/);
        assert.match(policy.value, /Honor explicit user requests/);
      }
      assert.equal(required(required(required(params).input)[0]).text, "Please solve this task");
    }
    assert.equal(
      policies.size,
      4,
      "native mode hints changing between turns cannot leave a deduplicated, stale policy",
    );
    assert.equal(
      socket.sent.filter(row => row.method === "thread/resume").length,
      1,
      "already-loaded chats get the changed policy without reloading",
    );
    assert.equal(
      socket.sent.some(row => row.method === "config/batchWrite"),
      false,
      "sending does not change global settings",
    );
  } finally {
    client.close();
  }
});

test("idle account usage and concurrent desktop readers share one model list; account changes refresh it", async () => {
  const { client, socket } = fixture();
  const reads = () => socket.sent.filter(request => request.method === "model/list").length;
  try {
    await Promise.all([client.models(), client.providers(), client.providers()]);
    assert.equal(reads(), 1, "the first desktop catalogue is shared");
    await client.providers();
    socket.emit("message", JSON.stringify({ method: "account/rateLimits/updated", params: {} }));
    await Promise.all([client.models(), client.providers()]);
    assert.equal(reads(), 1, "usage updates do not change the model catalogue");
    socket.emit("message", JSON.stringify({ method: "account/updated", params: {} }));
    await Promise.all([client.models(), client.providers()]);
    assert.equal(reads(), 2, "a real account change refreshes the shared catalogue");
    await client.saveSettings({ version: "user-version", main: { model: MODEL, provider: "openai" } });
    await client.models();
    assert.equal(reads(), 3, "a saved provider choice refreshes the catalogue");
    await client.signIn({ action: "signOut" });
    await client.models();
    assert.equal(reads(), 4, "sign-out refreshes the catalogue even without an account notification");
  } finally {
    client.close();
  }
});

test("a failed model list is retried and non-default pages are read separately", async () => {
  const { client, socket } = fixture();
  const send = socket.send;
  let fail = true;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === "model/list" && fail) {
      fail = false;
      socket.sent.push(request);
      queueMicrotask(() =>
        socket.emit(
          "message",
          JSON.stringify({ id: request.id, error: { code: -32603, message: "catalogue unavailable" } }),
        ),
      );
    } else send(raw);
  };
  try {
    // The engine's reason reaches the model menu (1 Nov: a failed fetch must say why).
    await assert.rejects(client.models(), /catalogue unavailable/);
    await client.models();
    await client.models({ cursor: "next" });
    assert.equal(socket.sent.filter(request => request.method === "model/list").length, 3);
  } finally {
    client.close();
  }
});

test("desktop browser MCP follows new, resumed and forked desktop chats without writing user config", async () => {
  const browserConfig = {
    "mcp_servers.elpis_browser": {
      command: "node",
      args: ["browser-mcp.mjs"],
      env: { ELPIS_BROWSER_SOCKET: "/tmp/private-browser.sock" },
    },
  };
  const { client, socket } = fixture({ browserConfig });
  try {
    await client.initialize();
    await client.createThread({});
    assert.deepEqual(
      required(required(socket.sent.find(row => row.method === "thread/start")).params).config,
      browserConfig,
    );
    await client.resume(ROOT, {});
    await client.forkThread(ROOT, {});
    for (const method of ["thread/resume", "thread/fork"])
      assert.deepEqual(required(required(socket.sent.find(row => row.method === method)).params).config, browserConfig);
    assert.equal(
      socket.sent.some(row => row.method === "config/batchWrite"),
      false,
    );
  } finally {
    client.close();
  }
});

test("browser session capabilities are separate on create/resume/fork and revoked on deletion", async () => {
  const requested: string[] = [],
    bound: [string, string][] = [],
    closed: string[] = [];
  const browserConfig = {
    forSession(id: string) {
      requested.push(id);
      return { "mcp_servers.elpis_browser": { env: { ELPIS_BROWSER_CAPABILITY: `scope-${id}` } } };
    },
    bind(from: string, to: string) {
      bound.push([from, to]);
    },
    close(id: string) {
      closed.push(id);
    },
  };
  const { client, socket } = fixture({ browserConfig });
  try {
    await client.initialize();
    await client.createThread({});
    await client.resume(ROOT, {});
    await client.forkThread(ROOT, {});
    const start = socket.sent.find(row => row.method === "thread/start"),
      resume = socket.sent.find(row => row.method === "thread/resume"),
      fork = socket.sent.find(row => row.method === "thread/fork");
    assert.equal(new Set(requested).size, 3, "each new or resumed session gets its own scope");
    const browser = required(required(required(resume).params).config)["mcp_servers.elpis_browser"];
    assert.ok(
      browser &&
        typeof browser === "object" &&
        "env" in browser &&
        browser.env &&
        typeof browser.env === "object" &&
        "ELPIS_BROWSER_CAPABILITY" in browser.env,
    );
    assert.equal(browser.env.ELPIS_BROWSER_CAPABILITY, `scope-${ROOT}`);
    assert.deepEqual(bound, [
      [requested[0], CREATED],
      [requested[2], FORK],
    ]);
    assert.notDeepEqual(required(required(start).params).config, required(required(fork).params).config);
    await client.deleteThread(ROOT, {});
    assert.ok(closed.includes(ROOT));
  } finally {
    client.close();
  }
});

test("a chat that runs the canvas's agents turns the multi-agent runtime on for itself only, beside the browser config", async () => {
  // The Ledger's SUBAGENTS switch (features.multi_agent = false) stops a model delegating in ordinary chats; with it the
  // engine refused every canvas run: "multi-agent runtime is disabled; this session cannot run a work graph".
  const browserConfig = { "mcp_servers.elpis_browser": { command: "node", args: ["browser-mcp.mjs"] } };
  const { client, socket } = fixture({ browserConfig });
  try {
    await client.initialize();
    await client.createThread({ cwd: "/tmp/project", agents: true });
    assert.deepEqual(required(required(socket.sent.findLast(row => row.method === "thread/start")).params).config, {
      ...browserConfig,
      "features.multi_agent": true,
    });
    await client.createThread({ cwd: "/tmp/project" });
    assert.deepEqual(
      required(required(socket.sent.findLast(row => row.method === "thread/start")).params).config,
      browserConfig,
      "an ordinary chat keeps the user's switch",
    );
    await assert.rejects(client.createThread({ agents: "yes" }), /agents must be true or false/);
    assert.equal(
      socket.sent.some(row => row.method === "config/batchWrite" || row.method === "config/value/write"),
      false,
      "the user config is never written",
    );
  } finally {
    client.close();
  }
});
