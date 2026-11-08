import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeMcp } from "./claude-mcp-import.mts";
import { required, ROOT, FORK, fixture } from "./bridge.fixtures.mts";

test("other failures to read a chat are still reported", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const answer = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "thread/items/list") return answer(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({ id: request.id, error: { code: -32603, message: "failed to list thread items: disk" } }),
      ),
    );
  };
  try {
    await assert.rejects(
      client.readThread(ROOT, {}),
      error => error !== null && typeof error === "object" && "code" in error && error.code === -32603,
    );
    assert.equal(
      socket.sent.some(message => message.method === "thread/read" && required(message.params).includeTurns),
      false,
    );
  } finally {
    client.close();
  }
});

test("dictation reads the ChatGPT sign-in, the Elpis home and the Gemini key privately, and only trusts Google for the key", async () => {
  const { client, configRead } = fixture();
  await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-dictation-"));
  const variable = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    required(configRead.layers[0]).name.file = path.join(root, "config.toml");
    assert.deepEqual(
      await client.transcriptionEnvironment(),
      { chatgpt: false, home: root, geminiKey: null },
      "signed in, but no sign-in file in the home (a keyring store): the ChatGPT route cannot work",
    );
    await fs.writeFile(path.join(root, "auth.json"), "{}"); // a placeholder: only its existence is checked, never its contents
    assert.deepEqual(await client.transcriptionEnvironment(), { chatgpt: true, home: root, geminiKey: null });
    process.env.GEMINI_API_KEY = "  gm-env-key  ";
    assert.equal((await client.transcriptionEnvironment()).geminiKey, "gm-env-key");
    await client.saveProviderKey({ provider: "google-gemini", key: "gm-saved-key" });
    assert.equal(
      (await client.transcriptionEnvironment()).geminiKey,
      "gm-saved-key",
      "a key saved in the Elpis home stands before the variable, as in the engine",
    );
    configRead.config.model_providers["google-gemini"] = {
      name: "Proxy",
      base_url: "https://proxy.example/v1beta",
      env_key: "GEMINI_API_KEY",
      wire_api: "gemini_generate_content",
    };
    assert.equal(
      (await client.transcriptionEnvironment()).geminiKey,
      null,
      "a Google Gemini connection pointed elsewhere never receives the key",
    );
  } finally {
    if (variable === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = variable;
    client.close();
  }
});

test("Voice can return the fallback engine to Automatic, which is no explicit backend at all", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  try {
    await client.saveMcp({
      version: "user-version",
      action: "whispertype",
      name: "whispertype",
      backend: null,
      model: null,
    });
    assert.deepEqual(required(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params).edits, [
      { keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_BACKEND", value: null, mergeStrategy: "replace" },
      { keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_CLOUD_MODEL", value: null, mergeStrategy: "replace" },
    ]);
    delete configRead.config.mcp_servers.whispertype.env.WHISPERTYPE_BACKEND;
    assert.deepEqual(required((await client.mcp()).servers.find(server => server.name === "whispertype")).whispertype, {
      backend: null,
      model: "openai/gpt-4o-mini-transcribe",
    });
    await assert.rejects(
      client.saveMcp({ version: "user-version", action: "whispertype", name: "whispertype", backend: "auto" }),
      /OpenRouter, Codex sign-in or local/,
    );
  } finally {
    client.close();
  }
});

test("A101 archived view sorts all pages by actual archive date and keeps why each was archived", async t => {
  const { client, threads } = fixture();
  threads.set(FORK, { id: FORK, source: "cli", cwd: os.tmpdir(), name: "Other task", status: { type: "idle" } });
  await client.initialize();
  t.after(() => client.close());
  await client.archiveThread(ROOT, {});
  await client.archiveThread(FORK, {});
  const result = await client.listArchivedThreads({ limit: 1 });
  assert.equal(required(result.data[0]).id, FORK);
  assert.equal(required(result.data[0]).archiveReason, "Archived by you.");
  assert.ok(required(required(result.data[0]).archivedAt) > 0);
  const second = await client.listArchivedThreads({ limit: 1, cursor: result.nextCursor });
  assert.equal(required(second.data[0]).id, ROOT);
  assert.equal(required(second.data[0]).archiveReason, "Archived by you.");
});

test("A101 archive order spans native pages, survives restart, and keeps pagination stable after restore", async t => {
  const archiveDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "a101-archive-pages-"));
  const h = fixture({ archiveDirectory, threadListPaging: true });
  await h.client.initialize();
  t.after(() => h.client.close());
  h.threads.clear();
  for (let i = 0; i < 105; i++) {
    const id = `00000000-0000-0000-0000-${(i + 100).toString(16).padStart(12, "0")}`;
    h.threads.set(id, { id, name: `Task ${i}`, archived: true, source: "cli", status: { type: "notLoaded" } });
    await fs.writeFile(
      path.join(archiveDirectory, `${id}.json`),
      JSON.stringify({ archivedAt: 1000 + i, archiveReason: `Reason ${i}` }),
    );
  }
  const first = await h.client.listArchivedThreads({ limit: 100 });
  assert.equal(required(first.data[0]).name, "Task 104");
  assert.equal(required(first.data.at(-1)).name, "Task 5");
  await h.client.unarchiveThread(required(first.data.at(-1)).id, {});
  const last = await h.client.listArchivedThreads({ limit: 100, cursor: first.nextCursor });
  assert.deepEqual(
    last.data.map(row => row.name),
    ["Task 4", "Task 3", "Task 2", "Task 1", "Task 0"],
  );
  assert.equal(last.nextCursor, null);
  const cold = fixture({ archiveDirectory, threadListPaging: true });
  await cold.client.initialize();
  t.after(() => cold.client.close());
  cold.threads.clear();
  for (const [id, row] of h.threads) cold.threads.set(id, structuredClone(row));
  const reloaded = await cold.client.listArchivedThreads({ limit: 1 });
  assert.equal(required(reloaded.data[0]).archiveReason, "Reason 104");
  await assert.rejects(cold.client.listArchivedThreads({ cursor: "broken" }), /Invalid archive page cursor/);
  cold.threads.clear();
  assert.deepEqual(await cold.client.listArchivedThreads({}), { data: [], nextCursor: null });
});

test("Claude MCP preview hides values and retains supported transports for selected import", () => {
  const raw = JSON.stringify({
    mcpServers: {
      shadcn: { command: "npx", args: ["shadcn@latest", "mcp"], env: { SECRET: "private-value" } },
      remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "private-header" } },
      bad: { type: "sse", url: "https://example.test" },
      existing: { command: "x" },
    },
  });
  const parsed = parseClaudeMcp(raw, ["existing"]);
  assert.deepEqual(
    parsed.preview.map(({ name, transport, status }) => [name, transport, status]),
    [
      ["shadcn", "stdio", "available"],
      ["remote", "http", "available"],
      ["bad", "unsupported", "unsupported"],
      ["existing", "stdio", "exists"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(parsed.preview), /private-value|private-header|example\.test|npx/);
  assert.deepEqual(parsed.definitions.shadcn, {
    command: "npx",
    args: ["shadcn@latest", "mcp"],
    env: { SECRET: "private-value" },
  });
  assert.deepEqual(parsed.definitions.remote, {
    url: "https://example.test/mcp",
    http_headers: { Authorization: "private-header" },
  });
  assert.equal(parsed.definitions.existing, undefined);
});

test("malformed definitions and unsupported fields cannot be silently imported", () => {
  const parsed = parseClaudeMcp(
    JSON.stringify({
      mcpServers: {
        bad: { command: "x", env: { SECRET: 3 } },
        extra: { command: "x", unexpected: "x" },
        wrong: { type: "http", url: "file:///tmp/x" },
      },
    }),
    [],
  );
  assert.ok(parsed.preview.every(row => row.status === "unsupported"));
  assert.deepEqual(Object.keys(parsed.definitions), []);
  assert.throws(() => parseClaudeMcp("{", []), /Could not read/);
});

test("the Ledger prompt cache share counts cached input once, for OpenAI and Claude usage alike (5 Nov)", async () => {
  const { cacheUse } = await import("./elpis-features.mts");
  // The engine's inputTokens include cached and cache-written input (elpis-gateway adds Claude's back in).
  const openai = cacheUse({
    last: { inputTokens: 10_200, cachedInputTokens: 9_000, cacheWriteInputTokens: 0 },
    total: { inputTokens: 20_400, cachedInputTokens: 9_000 },
  });
  assert.deepEqual(required(openai).last, {
    prompt: 10_200,
    cacheRead: 9_000,
    cacheWrite: 0,
    uncached: 1_200,
    hitPercent: 88,
  });
  assert.equal(required(required(openai).total).hitPercent, 44);
  const claude = cacheUse({ last: { inputTokens: 12_000, cachedInputTokens: 8_000, cacheWriteInputTokens: 3_000 } });
  assert.deepEqual(required(claude).last, {
    prompt: 12_000,
    cacheRead: 8_000,
    cacheWrite: 3_000,
    uncached: 1_000,
    hitPercent: 67,
  });
  assert.equal(required(claude).total, null);
  assert.equal(cacheUse(null), null, "nothing measured yet");
  assert.equal(cacheUse({ last: { inputTokens: 0 } }), null, "an empty prompt has no share");
});
