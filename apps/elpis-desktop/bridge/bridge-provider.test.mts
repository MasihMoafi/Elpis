import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existingSocket } from "./client.mts";
import { required, ROOT, CHILD, CREATED, fixture } from "./bridge.fixtures.mts";

test("provider settings redact stored keys and apply private versioned native configuration", async () => {
  const { client, socket, configRead, requirementsRead } = fixture();
  await client.initialize();
  requirementsRead.requirements = { modelProvider: null };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-provider-settings-"));
  const configPath = path.join(root, "config.toml");
  await fs.writeFile(configPath, "fixture", { mode: 0o644 });
  required(configRead.layers[0]).name.file = configPath;
  configRead.config.model_providers.saved = {
    name: "Stored OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    experimental_bearer_token: "provider-fixture-secret",
  };
  const snapshot = await client.providerSettings();
  assert.equal(snapshot.application.scope, "newConversations");
  assert(
    snapshot.application.credentialClearMessage.includes("does not revoke authentication in existing conversations"),
  );
  const saved = snapshot.providers.find(provider => provider.id === "saved");
  assert.deepEqual(required(saved).auth, { source: "stored", keySet: true, envKey: null, acceptsKey: false });
  assert(!JSON.stringify(snapshot).includes("provider-fixture-secret"));
  assert.equal(required((await client.providers()).openrouter.find(provider => provider.id === "saved")).keySet, true);
  const input = {
    version: "user-version",
    id: "saved",
    name: "Updated OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credential: { action: "replace", value: "provider-fixture-replacement" },
  };
  const updated = await client.saveProvider(input);
  assert(!JSON.stringify(updated).includes("provider-fixture-replacement"));
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  const write = socket.sent.findLast(row => row.method === "config/batchWrite");
  assert.equal(required(required(write).params).expectedVersion, "user-version");
  assert(
    required(required(required(write).params).edits).some(
      edit =>
        edit.keyPath === "model_providers.saved.experimental_bearer_token" &&
        edit.value === "provider-fixture-replacement",
    ),
  );
  assert(
    required(required(required(write).params).edits).some(
      edit => edit.keyPath === "model_providers.saved.env_key" && edit.value === null,
    ),
  );
  for (const value of ["", "********", "••••••••"]) {
    await client.saveProvider({ ...input, credential: { action: "replace", value } });
    assert(
      !required(required(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params).edits).some(
        edit => /bearer_token|env_key/.test(edit.keyPath),
      ),
    );
  }
  await client.saveProvider({ ...input, credential: { action: "clear" } });
  assert.deepEqual(
    required(required(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params).edits)
      .slice(-2)
      .map(edit => edit.value),
    [null, null],
  );
  client.close();
});

test("custom API models are validated under the selected native provider for creation and follow-up", async () => {
  const { client, socket, configRead, threads } = fixture();
  await client.initialize();
  await client.models();
  delete configRead.config.model_providers.local.http_headers;
  for (const model of ["claude/opus", "agy/gemini-pro", "bad model;"])
    await assert.rejects(client.createThread({ provider: "local", model }), /Subscription model|model ID/);
  await assert.rejects(
    client.createThread({ provider: "unknown", model: "fixture/custom-model" }),
    /configured provider/,
  );
  await assert.rejects(client.createThread({ model: "fixture/custom-model" }), /current Elpis model list/);
  assert.equal(socket.sent.filter(row => row.method === "thread/start").length, 0);
  await client.createThread({ provider: "local", model: "fixture/custom-model" });
  assert.deepEqual(
    required(socket.sent.findLast(row => row.method === "thread/start")).params,
    {
      model: "fixture/custom-model",
      modelProvider: "local",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":danger-full-access",
      elpisPermissionSource: "default",
    },
    "a new chat starts in the default mode, Full access",
  );
  // Reflect the native thread/read route rather than trusting the renderer's selection.
  required(threads.get(CREATED)).modelProvider = "local";
  required(threads.get(CREATED)).model = "fixture/custom-model";
  await client.send(CREATED, { text: "follow-up", model: "fixture/custom-model" });
  assert.equal(
    required(required(socket.sent.findLast(row => row.method === "turn/start")).params).model,
    "fixture/custom-model",
  );
  await client.steer(CREATED, { text: "steer same route", expectedTurnId: "new-turn" });
  assert.equal(required(required(socket.sent.findLast(row => row.method === "turn/steer")).params).threadId, CREATED);
  await assert.rejects(
    client.send(ROOT, { text: "default provider stays catalog bound", model: "fixture/custom-model" }),
    /current Elpis model list/,
  );
  client.close();
});

test("provider setup rejects unsafe endpoints, policy, stale versions and alternate auth sources before mutation", async () => {
  const { client, socket, configRead, requirementsRead } = fixture();
  await client.initialize();
  requirementsRead.requirements = { modelProvider: null };
  const input = {
    version: "user-version",
    id: "custom",
    name: "Custom",
    baseUrl: "http://localhost:1234/v1",
    credential: { action: "preserve" },
  };
  for (const baseUrl of [
    "http://example.com/v1",
    "https://key@example.com/v1",
    "https://example.com/v1?key=secret",
    "file:///private",
    "http://0.0.0.0:1234/v1",
  ])
    await assert.rejects(client.saveProvider({ ...input, baseUrl }), /HTTPS/);
  await assert.rejects(
    client.saveProvider({ ...input, version: "stale" }),
    error => error !== null && typeof error === "object" && "status" in error && error.status === 409,
  );
  await assert.rejects(client.saveProvider({ ...input, id: "openai" }), /custom provider ID/);
  configRead.config.model_providers.custom = {
    name: "Command auth",
    base_url: input.baseUrl,
    auth: { command: "/bin/true" },
  };
  await assert.rejects(
    client.saveProvider(input),
    error => error !== null && typeof error === "object" && "status" in error && error.status === 403,
  );
  delete configRead.config.model_providers.custom;
  requirementsRead.requirements.modelProvider = "openai";
  await assert.rejects(
    client.saveProvider(input),
    error => error !== null && typeof error === "object" && "status" in error && error.status === 403,
  );
  assert.equal(socket.sent.filter(row => row.method === "config/batchWrite").length, 0);
  client.close();
});

test("MCP credentials preserve blanks and masks and never return secrets", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-mcp-credential-"));
  const configPath = path.join(root, "config.toml");
  await fs.writeFile(configPath, "fixture config", { mode: 0o644 });
  required(configRead.layers[0]).name.file = configPath;
  assert.equal((await client.mcp()).configPath, configPath);
  const saved = await client.saveMcp({
    version: "user-version",
    action: "credentials",
    name: "whispertype",
    env: { OPENROUTER_API_KEY_COMPANY: "new-fixture-key" },
  });
  assert(!JSON.stringify(saved).includes("new-fixture-key"));
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(required(required(socket.sent.findLast(m => m.method === "config/batchWrite")).params).edits, [
    {
      keyPath: "mcp_servers.whispertype.env.OPENROUTER_API_KEY_COMPANY",
      value: "new-fixture-key",
      mergeStrategy: "replace",
    },
  ]);
  const count = socket.sent.filter(m => m.method === "config/batchWrite").length;
  for (const value of ["", "********", "••••••••"])
    await client.saveMcp({
      version: "user-version",
      action: "credentials",
      name: "whispertype",
      env: { OPENROUTER_API_KEY_COMPANY: value },
    });
  assert.equal(socket.sent.filter(m => m.method === "config/batchWrite").length, count);
  await assert.rejects(
    client.saveMcp({
      version: "user-version",
      action: "credentials",
      name: "missing",
      env: { OPENROUTER_API_KEY: "key" },
    }),
    /Unknown MCP/,
  );
  for (const name of ["LD_PRELOAD", "API.KEY"])
    await assert.rejects(
      client.saveMcp({ version: "user-version", action: "credentials", name: "rag", env: { [name]: "bad" } }),
      /credential/,
    );
  client.close();
});

test("MCP credential writes reject unsafe files before any native write", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-mcp-unsafe-"));
  const target = path.join(root, "config.toml");
  await fs.writeFile(target, "fixture", { mode: 0o644 });
  const link = path.join(root, "link.toml");
  await fs.symlink(target, link);
  for (const file of [link, root, path.join(root, "missing.toml")]) {
    required(configRead.layers[0]).name.file = file;
    await assert.rejects(
      client.saveMcp({
        version: "user-version",
        action: "credentials",
        name: "rag",
        env: { OPENROUTER_API_KEY: "fixture-key" },
      }),
      error => error !== null && typeof error === "object" && "status" in error && error.status === 403,
    );
  }
  assert.equal(socket.sent.filter(row => row.method === "config/batchWrite").length, 0);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
  required(configRead.layers[0]).name.file = target;
  await client.saveMcp({
    version: "user-version",
    action: "credentials",
    name: "rag",
    env: { OPENROUTER_API_KEY: "" },
  });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644, "a blank key must not change config or permissions");
  client.close();
});

test("MCP credential errors never echo submitted keys", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-mcp-credential-error-"));
  const configPath = path.join(root, "config.toml");
  await fs.writeFile(configPath, "fixture config", { mode: 0o600 });
  required(configRead.layers[0]).name.file = configPath;
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "config/batchWrite") return send(raw);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({ id: request.id, error: { code: -32603, message: "Rejected secret-fixture-leak" } }),
      ),
    );
  };
  await assert.rejects(
    client.saveMcp({
      version: "user-version",
      action: "credentials",
      name: "rag",
      env: { OPENROUTER_API_KEY: "secret-fixture-leak" },
    }),
    error =>
      error instanceof Error &&
      "status" in error &&
      !error.message.includes("secret-fixture-leak") &&
      error.status === 502,
  );
  client.close();
});

test("socket discovery rejects ordinary files and relative paths without launching anything", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-desktop-socket-test-"));
  const file = path.join(temp, "not-a-socket");
  await fs.writeFile(file, "");
  assert.throws(() => existingSocket(file), /private.*owned/);
  assert.throws(() => existingSocket("relative.sock"), /absolute/);
  assert.throws(() => existingSocket(path.join(temp, "missing")), /No running Elpis bridge/);
});

test("opening a chat rejoins it without overrides, reports its running turn, and subscribes agents too", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const opened = await client.resume(ROOT, {});
  assert.equal(opened.thread.desktopAccess.writable, true);
  assert.equal(opened.activeTurnId, null);
  assert.deepEqual(required(socket.sent.find(message => message.method === "thread/resume")).params, {
    threadId: ROOT,
    excludeTurns: true,
    initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" },
  });
  const again = await client.resume(ROOT, {});
  assert.equal(again.thread.id, ROOT);
  assert.deepEqual(
    socket.sent
      .filter(message => message.method === "thread/resume")
      .map(message => message.params)
      .at(-1),
    { threadId: ROOT, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" } },
    "an owned chat is read again without overrides",
  );
  const agent = await client.resume(CHILD, {});
  assert.equal(agent.thread.desktopAccess.mode, "continue");
  await assert.rejects(client.resume(ROOT, { model: "override" }), /Unsupported/);
  assert.deepEqual(await client.interrupt(CHILD, {}), {});
  assert.deepEqual(
    required(socket.sent.find(message => message.method === "turn/interrupt")).params,
    { threadId: CHILD, turnId: "running-turn" },
    "stop finds the running turn",
  );
  client.close();
});

test("rename, archive, unarchive and edit-and-resend reach native thread methods; agents are never reverted", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  await client.listThreads();
  assert.equal((await client.renameThread(ROOT, { name: "  Parser fix  " })).thread.name, "Parser fix");
  assert.deepEqual(required(socket.sent.filter(row => row.method === "thread/name/set").at(-1)).params, {
    threadId: ROOT,
    name: "Parser fix",
  });
  await assert.rejects(client.renameThread(ROOT, { name: "   " }), /Invalid name|Enter a name/);
  assert.deepEqual(await client.archiveThread(ROOT, {}), { archived: true });
  assert.equal(
    (await client.listThreads()).data.some(thread => thread.id === ROOT),
    false,
    "archived chats leave the list",
  );
  assert.deepEqual(
    (await client.listThreads({ archived: true })).data.map(thread => thread.id),
    [ROOT],
  );
  assert.equal(
    required(required(socket.sent.filter(row => row.method === "thread/list").at(-1)).params).archived,
    true,
  );
  assert.equal((await client.unarchiveThread(ROOT, {})).thread.id, ROOT);
  assert.equal(
    (await client.listThreads()).data.some(thread => thread.id === ROOT),
    true,
    "unarchived chats return",
  );
  await client.revert(ROOT, { beforeTurnId: "turn-1", text: "Edited prompt" });
  assert.deepEqual(
    socket.sent.filter(row => ["thread/revert", "turn/start"].includes(row.method ?? "")).map(row => row.method),
    ["thread/revert", "turn/start"],
  );
  assert.deepEqual(required(socket.sent.find(row => row.method === "thread/revert")).params, {
    threadId: ROOT,
    beforeTurnId: "turn-1",
  });
  assert.match(
    JSON.stringify(required(required(socket.sent.filter(row => row.method === "turn/start").at(-1)).params).input),
    /Edited prompt/,
  );
  required(threads.get(CHILD)).status = { type: "idle" };
  await assert.rejects(client.revert(CHILD, { beforeTurnId: "turn-1", text: "Replace" }), /only from its parent/);
  assert.equal(
    socket.sent.filter(row => row.method === "thread/revert").length,
    1,
    "an agent owned by its parent is never reverted",
  );
  client.close();
});

test("an archived chat opens without an error, and writing in it brings it back and sends; no terminal command is named", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  await client.listThreads();
  await client.archiveThread(ROOT, {});
  const opened = await client.resume(ROOT, {});
  assert.equal(opened.thread.id, ROOT, "opening an archived chat shows it, read from the engine");
  assert.equal(required(threads.get(ROOT)).archived, true, "opening it leaves it archived");
  const events: { data?: { method?: string } }[] = [];
  client.on("event", event => events.push(event));
  await client.send(ROOT, { text: "One more thing" });
  assert.equal(required(threads.get(ROOT)).archived, undefined, "sending brings it back first");
  assert.deepEqual(
    socket.sent
      .filter(
        row => ["thread/unarchive", "turn/start"].includes(row.method ?? "") && required(row.params).threadId === ROOT,
      )
      .map(row => row.method),
    ["thread/unarchive", "turn/start"],
  );
  assert.equal(required(threads.get(CHILD)).archived, undefined, "its agent comes back with it");
  assert.match(
    JSON.stringify(required(required(socket.sent.filter(row => row.method === "turn/start").at(-1)).params).input),
    /One more thing/,
  );
  assert.equal(
    (await client.listThreads()).data.some(thread => thread.id === ROOT),
    true,
    "it is in the chat list again",
  );
  socket.emit("message", JSON.stringify({ method: "thread/unarchived", params: { threadId: ROOT } }));
  assert(
    events.some(event => event.data?.method === "thread/unarchived"),
    "the window hears that a chat came back",
  );
  required(threads.get(ROOT)).status = { type: "idle" };
  required(threads.get(ROOT)).archived = true;
  const error = await client.setServiceTier(ROOT, { enabled: true }).then(
    () => null,
    error => error,
  );
  assert(error, "a change other than a message still needs the chat back");
  assert.doesNotMatch(error.message, /codex/i);
  assert.match(error.message, /archived/i);
  client.close();
});
