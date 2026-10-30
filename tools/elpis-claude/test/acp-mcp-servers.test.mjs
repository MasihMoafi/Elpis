import assert from "node:assert/strict";
import test from "node:test";
import { acpServersFrom, appMcpConfig, redactMcpConfigForLog, restoreMcpSession, restoredMcpOverrides } from "../acp-mcp-servers.mjs";

test("ACP mapping keeps existing stdio shape and excludes disabled/internal servers", () => {
  const config = {
    "mcp_servers.local": { command: "node", args: ["server.mjs", 7], env: { PRIVATE: "stdio-secret" } },
    "mcp_servers.off": { enabled: false, command: "unused" },
    "mcp_servers.elpis-agents": { command: "internal" },
    "features.multi_agent": true,
  };
  assert.deepEqual(appMcpConfig(config), {
    "mcp_servers.local": config["mcp_servers.local"],
    "mcp_servers.off": config["mcp_servers.off"],
  });
  assert.deepEqual(acpServersFrom(appMcpConfig(config), "thread-1"), [{
    name: "local", command: "node", args: ["server.mjs", "7"],
    env: [{ name: "PRIVATE", value: "stdio-secret" }, { name: "ELPIS_THREAD_ID", value: "thread-1" }],
  }]);
});

test("restored selections resolve current enabled servers and warn for disabled or deleted names", () => {
  const result = restoredMcpOverrides({ config: { mcp_servers: {
    rag: { command: "python", args: ["server.py"] },
    disabled: { url: "https://example.test/mcp", enabled: false },
  } } }, ["rag", "disabled", "deleted"]);
  assert.deepEqual(result.config, { "mcp_servers.rag": { command: "python", args: ["server.py"], enabled: true } });
  assert.deepEqual(result.warnings, [
    'MCP server "disabled" is disabled in MCP settings and stays off in this chat.',
    'MCP server "deleted" is no longer configured and stays off in this chat.',
  ]);
});

test("resume refreshes a cached MCP map against global disables and leaves legacy mappings unchanged", async () => {
  const cache = new Map([
    ["thread-saved", {
      "mcp_servers.rag": { command: "/old/rag", enabled: true },
      "mcp_servers.elpis_browser": { command: "browser-internal", enabled: true },
    }],
    ["thread-legacy", { "mcp_servers.legacy": { command: "/legacy", enabled: true } }],
  ]);
  const warnings = [];
  let reads = 0;
  const selections = { get: id => id === "thread-saved" ? ["rag"] : undefined };
  const readConfig = async () => { reads++; return { config: { mcp_servers: { rag: { command: "/new/rag", enabled: false } } } }; };
  await restoreMcpSession("thread-saved", { selections, cache, readConfig, onWarning: warning => warnings.push(warning) });
  assert.deepEqual(cache.get("thread-saved"), {
    "mcp_servers.elpis_browser": { command: "browser-internal", enabled: true },
  }, "stale user servers are removed while the internal browser server remains available");
  assert.deepEqual(acpServersFrom(cache.get("thread-saved"), "thread-saved"), [{
    name: "elpis_browser", command: "browser-internal", args: [], env: [{ name: "ELPIS_THREAD_ID", value: "thread-saved" }],
  }]);
  assert.deepEqual(warnings, ['MCP server "rag" is disabled in MCP settings and stays off in this chat.']);

  await restoreMcpSession("thread-legacy", { selections, cache, readConfig, onWarning: warning => warnings.push(warning) });
  assert.deepEqual(cache.get("thread-legacy"), { "mcp_servers.legacy": { command: "/legacy", enabled: true } }, "missing metadata keeps legacy live behavior");
  assert.equal(reads, 1, "legacy sessions do not need a config read");
});

test("failed MCP refresh clears selected user servers but keeps the internal browser server", async () => {
  const cache = new Map([[
    "thread-saved", {
      "mcp_servers.rag": { command: "/old/rag", enabled: true },
      "mcp_servers.elpis_browser": { command: "browser-internal", enabled: true },
    },
  ]]);
  const warnings = [];
  await restoreMcpSession("thread-saved", {
    selections: { get: () => ["rag"] }, cache,
    readConfig: async () => { throw new Error("settings unavailable"); },
    onWarning: warning => warnings.push(warning),
  });
  assert.deepEqual(cache.get("thread-saved"), {
    "mcp_servers.elpis_browser": { command: "browser-internal", enabled: true },
  });
  assert.deepEqual(warnings, ["MCP servers in this chat could not be checked and stay off for this session."]);
});

test("an unreadable saved selection fails closed in the cached ACP session", async () => {
  const cache = new Map([[
    "thread-corrupt", {
      "mcp_servers.rag": { command: "/old/rag", enabled: true },
      "mcp_servers.elpis_browser": { command: "browser-internal", enabled: true },
    },
  ]]);
  const warnings = [];
  let configReads = 0;
  await restoreMcpSession("thread-corrupt", {
    selections: { get: () => { throw new Error("corrupt record"); } }, cache,
    readConfig: async () => { configReads++; return {}; },
    onWarning: warning => warnings.push(warning),
  });
  assert.deepEqual(cache.get("thread-corrupt"), {
    "mcp_servers.elpis_browser": { command: "browser-internal", enabled: true },
  });
  assert.deepEqual(acpServersFrom(cache.get("thread-corrupt"), "thread-corrupt"), [{
    name: "elpis_browser", command: "browser-internal", args: [], env: [{ name: "ELPIS_THREAD_ID", value: "thread-corrupt" }],
  }]);
  assert.equal(configReads, 0);
  assert.deepEqual(warnings, ["Saved MCP choices for this chat could not be read; user MCP servers stay off."]);
});

test("ACP HTTP mapping resolves headers with native precedence and bearer override", () => {
  const config = {
    "mcp_servers.remote": {
      url: "https://mcp.example.test/mcp",
      http_headers: { "X-Token": "static-token", Authorization: "Basic static" },
      env_http_headers: { "x-token": "MCP_API_KEY", "X-Region": "MCP_REGION" },
      bearer_token_env_var: "MCP_BEARER",
    },
  };
  const env = { MCP_API_KEY: "env-token", MCP_REGION: "eu", MCP_BEARER: "bearer-token-secret" };
  const before = structuredClone(config);
  const [server] = acpServersFrom(config, "thread-2", env);
  assert.deepEqual([server.type, server.name, server.url], ["http", "remote", "https://mcp.example.test/mcp"]);
  assert.deepEqual(Object.fromEntries(server.headers.map(header => [header.name.toLowerCase(), header.value])), {
    "x-token": "env-token", authorization: "Bearer bearer-token-secret", "x-region": "eu",
  });
  assert.deepEqual(config, before, "resolved credentials stay out of the thread config");
});

test("ACP HTTP mapping refuses missing environment credentials without exposing values", () => {
  const config = { "mcp_servers.remote": { url: "https://mcp.example.test", env_http_headers: { Authorization: "MCP_SECRET" } } };
  assert.throws(() => acpServersFrom(config, "thread-3", {}), error => {
    assert.match(error.message, /MCP server "remote"/);
    assert.match(error.message, /MCP_SECRET/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

test("ACP HTTP mapping rejects unsupported authentication instead of dropping a selected server", () => {
  assert.throws(() => acpServersFrom({ "mcp_servers.oauth": { url: "https://mcp.example.test" } }, "thread-4", {}), /requires OAuth authentication/);
  assert.throws(() => acpServersFrom({ "mcp_servers.chatgpt": { url: "https://mcp.example.test", auth: "chatgpt" } }, "thread-4", {}), /requires ChatGPT session authentication/);
  assert.throws(() => acpServersFrom({ "mcp_servers.ema": { url: "https://mcp.example.test", auth: "ema_auth" } }, "thread-4", {}), /requires enterprise authentication/);
  assert.throws(() => acpServersFrom({ "mcp_servers.helper": { url: "https://mcp.example.test", http_headers_helper: "echo secret" } }, "thread-4", {}), /local HTTP headers helper/);
  assert.throws(() => acpServersFrom({ "mcp_servers.broken": { enabled: true } }, "thread-4", {}), /no supported transport/);
});

test("ACP debug logs redact configured MCP values, arguments and URL paths", () => {
  const line = JSON.stringify({ method: "thread/start", params: { config: {
    "mcp_servers.remote": { url: "https://example.test/mcp/path-secret?token=query-secret", http_headers: { Authorization: "Bearer header-secret" }, bearer_token: "bearer-secret" },
    "mcp_servers.local": { command: "run-with-secret", args: ["--token", "argument-secret"], env: { API_KEY: "env-secret" } },
  } } });
  const logged = redactMcpConfigForLog(line);
  for (const secret of ["path-secret", "query-secret", "header-secret", "bearer-secret", "run-with-secret", "argument-secret", "env-secret"]) assert.equal(logged.includes(secret), false, `${secret} is absent from debug logs`);
  assert.match(logged, /example\.test/);
});
