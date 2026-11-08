import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { required, ROOT, CHILD, FORK, fixture } from "./bridge.fixtures.mts";

test("replacement checks every native page of the selected turn before reverting", async () => {
  const prompt = {
    turnId: "turn-1",
    item: { type: "userMessage", id: "prompt", content: [{ type: "text", text: "Original prompt" }] },
  };
  const { client, socket } = fixture({
    replacementPages: {
      start: { data: [prompt], nextCursor: "next" },
      next: {
        data: [{ turnId: "turn-1", item: { type: "agentMessage", id: "reply", text: "Done" } }],
        nextCursor: null,
      },
    },
  });
  try {
    await client.initialize();
    const result = await client.revert(ROOT, { beforeTurnId: "turn-1", text: "Edited prompt" });
    assert.ok(result && "turn" in result);
    assert.equal(result.turn.id, "new-turn");
    const reads = socket.sent.filter(row => row.method === "thread/items/list");
    assert.equal(reads.length, 2);
    assert.deepEqual(
      reads.map(row => required(row.params).turnId),
      ["turn-1", "turn-1"],
    );
    assert.equal(required(required(reads[1]).params).cursor, "next");
    assert(socket.sent.indexOf(required(reads[1])) < socket.sent.findIndex(row => row.method === "thread/revert"));
  } finally {
    client.close();
  }
});

test("replacement refuses unsafe or incomplete native inputs before any mutation", async t => {
  const prompt = {
    turnId: "turn-1",
    item: { type: "userMessage", id: "prompt", content: [{ type: "text", text: "Original prompt" }] },
  };
  const variants = {
    "missing user input": { start: { data: [], nextCursor: null } },
    "unreadable input part": {
      start: { data: [{ ...prompt, item: { ...prompt.item, content: ["not a part"] } }], nextCursor: null },
    },
    "unknown page completeness": { start: { data: [prompt] } },
    "wrong turn": { start: { data: [{ ...prompt, turnId: "another-turn" }], nextCursor: null } },
    "repeating page cursor": { start: { data: [prompt], nextCursor: "next" }, next: { data: [], nextCursor: "next" } },
    "page traversal limit": Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        index ? `page-${index}` : "start",
        { data: index ? [] : [prompt], nextCursor: `page-${index + 1}` },
      ]),
    ),
  };
  for (const [name, replacementPages] of Object.entries(variants))
    await t.test(name, async () => {
      const { client, socket } = fixture({ replacementPages });
      try {
        await client.initialize();
        await assert.rejects(client.revert(ROOT, { beforeTurnId: "turn-1", text: "Edited prompt" }));
        assert.equal(socket.sent.filter(row => ["thread/revert", "turn/start"].includes(row.method ?? "")).length, 0);
      } finally {
        client.close();
      }
    });
});

test("replacement resends the edited text with the message's attachments and keeps the chat as it was in an archived copy", async t => {
  const prompt = {
    turnId: "turn-1",
    item: { type: "userMessage", id: "prompt", content: [{ type: "text", text: "Original prompt" }] },
  };
  const image = { type: "localImage", path: "/tmp/book.png" },
    quoted = {
      type: "text",
      text: "File: note.txt\nBody",
      textElements: [{ byteRange: { start: 0, end: 5 }, placeholder: "Attachment: note.txt" }],
    };
  const variants = {
    "image and file attachments": {
      start: {
        data: [{ ...prompt, item: { ...prompt.item, content: [...prompt.item.content, image, quoted] } }],
        nextCursor: null,
      },
      kept: [image, quoted],
    },
    "a delivered follow-up goes with its turn": {
      start: { data: [prompt], nextCursor: "next" },
      next: {
        data: [
          { ...prompt, item: { ...prompt.item, id: "delivered", content: [{ type: "text", text: "Follow-up" }] } },
        ],
        nextCursor: null,
      },
      kept: [],
    },
  };
  for (const [name, { kept, ...replacementPages }] of Object.entries(variants))
    await t.test(name, async () => {
      const { client, socket } = fixture({ replacementPages });
      try {
        await client.initialize();
        const result = await client.revert(ROOT, { beforeTurnId: "turn-1", text: "Edited prompt" });
        assert.ok(result && "turn" in result);
        assert.equal(result.turn.id, "new-turn");
        assert.deepEqual(required(required(socket.sent.find(row => row.method === "turn/start")).params).input, [
          { type: "text", text: "Edited prompt", text_elements: [] },
          ...kept,
        ]);
        const order = ["thread/fork", "thread/archive", "thread/revert", "turn/start"].map(method =>
          socket.sent.findIndex(row => row.method === method),
        );
        assert.deepEqual(
          [...order].sort((a, b) => a - b),
          order,
          "the copy is kept and archived before anything is replaced",
        );
        assert.equal(
          required(required(socket.sent.find(row => row.method === "thread/fork")).params).beforeTurnId,
          undefined,
          "the copy is the whole chat",
        );
        assert.deepEqual((await client.versions(ROOT, { action: "list" })).versions, [
          { turnId: "new-turn", index: 2, count: 2, previous: FORK },
        ]);
        assert.deepEqual((await client.versions(FORK, { action: "list" })).versions, [
          { turnId: "turn-1", index: 1, count: 2, next: ROOT },
        ]);
      } finally {
        client.close();
      }
    });
});

test("replacement reports an acknowledged rewind when its new turn is rejected or unconfirmed", async t => {
  for (const timeout of [false, true])
    await t.test(timeout ? "unknown start outcome" : "start rejected", async () => {
      const { client, socket } = fixture();
      try {
        await client.initialize();
        if (timeout) client.timeoutMs = 20;
        const send = socket.send;
        socket.send = raw => {
          const request = JSON.parse(raw);
          if (request.method === "turn/start") {
            socket.sent.push(request);
            if (!timeout)
              queueMicrotask(() =>
                socket.emit(
                  "message",
                  JSON.stringify({ id: request.id, error: { code: -32000, message: "Fixture replacement rejected" } }),
                ),
              );
          } else send(raw);
        };
        const result = await client.revert(ROOT, { beforeTurnId: "turn-1", text: "Edited prompt" });
        assert.ok(result && "rewound" in result && "sendError" in result && typeof result.sendError === "string");
        assert.equal(result.rewound, true);
        assert.equal(result.beforeTurnId, "turn-1");
        assert.equal("turn" in result ? result.turn : undefined, undefined);
        assert.match(result.sendError, timeout ? /outcome is unknown/ : /Fixture replacement rejected/);
        assert.equal(socket.sent.filter(row => row.method === "thread/revert").length, 1);
        assert.equal(
          socket.sent.filter(row => row.method === "turn/start").length,
          1,
          "never replay an unconfirmed write",
        );
      } finally {
        client.close();
      }
    });
});

test("a rejected native rewind never claims success and never starts its replacement", async () => {
  const { client, socket } = fixture();
  try {
    await client.initialize();
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === "thread/revert") {
        socket.sent.push(request);
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({ id: request.id, error: { code: -32000, message: "Fixture rewind rejected" } }),
          ),
        );
      } else send(raw);
    };
    await assert.rejects(
      client.revert(ROOT, { beforeTurnId: "turn-1", text: "Edited prompt" }),
      /Fixture rewind rejected/,
    );
    assert.equal(socket.sent.filter(row => row.method === "turn/start").length, 0);
  } finally {
    client.close();
  }
});

// 3 Nov, Masih: deleting a chat silently deleted the chat continued from it (his working Hermes chat).
test("deleting a chat that a continued chat was forked from archives it and never deletes the fork", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  await client.listThreads();
  required(threads.get(CHILD)).status = { type: "idle" };
  await client.send(CHILD, { text: "Follow up", continueAs: "Failure reporting (continued)" });
  const events: { data?: { method?: string } }[] = [];
  client.on("event", event => events.push(event));
  const result = await client.deleteThread(ROOT, {});
  assert.deepEqual(result, { deleted: true, archived: true, alsoDeleted: [] });
  assert.deepEqual(
    socket.sent.filter(row => row.method === "thread/delete").map(row => required(row.params).threadId),
    [ROOT],
    "no fork is ever deleted",
  );
  assert.ok(threads.has(FORK), "the continued chat stays");
  assert.equal(
    required(threads.get(ROOT)).archived,
    true,
    "the deleted chat is archived, keeping the history its fork uses",
  );
  socket.emit("message", JSON.stringify({ method: "thread/deleted", params: { threadId: ROOT } }));
  assert.equal(
    events.filter(event => event.data?.method === "thread/deleted").length,
    0,
    "forgotten chats emit nothing more",
  );
  client.close();
});

test("delete locks release across sequential, descendant and bulk deletes, but still reject a concurrent mutation of the same chat", async t => {
  const f = fixture();
  t.after(() => f.client.close());
  await f.client.initialize();
  await f.client.listThreads();
  required(f.threads.get(CHILD)).status = { type: "idle" };
  await f.client.send(CHILD, { text: "Follow up", continueAs: "Failure reporting (continued)" });
  assert.deepEqual(await f.client.deleteThread(ROOT, {}), { deleted: true, archived: true, alsoDeleted: [] });
  assert.ok(
    f.threads.has(FORK) && required(f.threads.get(ROOT)).archived,
    "the continued fork stays and the root is archived",
  );

  const ids = [8, 9, 10, 11, 12].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`);
  for (const id of ids) f.threads.set(id, { id, cwd: os.tmpdir(), source: "cli", status: { type: "idle" } });
  assert.deepEqual(
    await f.client.deleteThread(ids[0], {}),
    { deleted: true, alsoDeleted: [] },
    "the next delete starts after the first released its lock",
  );
  assert.deepEqual(
    await Promise.all(ids.slice(1, 4).map(id => f.client.deleteThread(id, {}))),
    ids.slice(1, 4).map(() => ({ deleted: true, alsoDeleted: [] })),
    "independent bulk deletes may run together",
  );

  const held = required(ids[4]),
    send = f.socket.send,
    release: { current?: () => void } = {};
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === "thread/delete" && request.params.threadId === held && !release.current) {
      f.socket.sent.push(request);
      release.current = () => {
        f.threads.delete(held);
        queueMicrotask(() => f.socket.emit("message", JSON.stringify({ id: request.id, result: {} })));
      };
      return;
    }
    send(raw);
  };
  const deleting = f.client.deleteThread(held, {});
  for (let attempt = 0; !release.current && attempt < 20; attempt++)
    await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    f.client.renameThread(held, { name: "Too soon" }),
    error =>
      error instanceof Error && "status" in error && error.status === 409 && /Another operation/.test(error.message),
  );
  required(release.current)();
  await deleting;
  assert.deepEqual(
    await f.client.deleteThread(held, {}),
    { deleted: true, alsoDeleted: [] },
    "a deleted ID holds no stale lock",
  );
});

test("deleting a chat waits for its pending operation and then releases its lock", async t => {
  const f = fixture();
  t.after(() => f.client.close());
  await f.client.initialize();
  await f.client.listThreads();
  const id = "00000000-0000-0000-0000-000000000080";
  f.threads.set(id, { id, cwd: os.tmpdir(), source: "cli", status: { type: "idle" } });
  const send = f.socket.send,
    release: { current?: () => void } = {};
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === "thread/name/set" && request.params.threadId === id) {
      f.socket.sent.push(request);
      release.current = () => {
        required(f.threads.get(id)).name = request.params.name;
        queueMicrotask(() => f.socket.emit("message", JSON.stringify({ id: request.id, result: {} })));
      };
      return;
    }
    send(raw);
  };
  const renaming = f.client.renameThread(id, { name: "Renamed" });
  for (let attempt = 0; !release.current && attempt < 20; attempt++)
    await new Promise(resolve => setImmediate(resolve));
  assert.ok(release.current, "the earlier operation holds the chat lock");
  const deleting = f.client.archiveThread(id, {}).then(
    value => ({ value }),
    error => ({ error }),
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    f.socket.sent.some(row => row.method === "thread/archive" && required(row.params).threadId === id),
    false,
  );
  release.current();
  await renaming;
  const result = await deleting;
  if ("error" in result) throw result.error;
  assert.equal(result.value.archived, true);
  assert.equal(required(f.threads.get(id)).archived, true);
  await f.client.unarchiveThread(id, {});
  assert.equal((await f.client.archiveThread(id, {})).archived, true, "the next deletion also works");
});

test("an annotation waits for a pending chat operation and is sent once", async t => {
  const f = fixture();
  t.after(() => f.client.close());
  await f.client.initialize();
  await f.client.listThreads();
  const send = f.socket.send,
    release: { current?: () => void } = {};
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === "thread/name/set" && request.params.threadId === ROOT) {
      f.socket.sent.push(request);
      release.current = () => {
        required(f.threads.get(ROOT)).name = request.params.name;
        queueMicrotask(() => f.socket.emit("message", JSON.stringify({ id: request.id, result: {} })));
      };
      return;
    }
    send(raw);
  };
  const rename = f.client.renameThread(ROOT, { name: "Renamed" });
  for (let attempt = 0; !release.current && attempt < 20; attempt++)
    await new Promise(resolve => setImmediate(resolve));
  assert.ok(release.current, "the earlier operation holds the chat lock");
  const attachment = {
    id: "annotation",
    name: "Browser comments.txt",
    type: "text",
    mimeType: "text/plain",
    text: "Make this heading shorter.",
  };
  const sent = f.client.send(ROOT, { text: "", attachments: [attachment] }).then(
    value => ({ value }),
    error => ({ error }),
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.socket.sent.filter(row => row.method === "turn/start").length, 0);
  release.current();
  await rename;
  const result = await sent;
  if ("error" in result) assert.ifError(result.error);
  assert.ok("value" in result && "turn" in result.value && result.value.turn.id);
  const turns = f.socket.sent.filter(row => row.method === "turn/start");
  assert.equal(turns.length, 1);
  assert.match(JSON.stringify(required(required(turns[0]).params).input), /Make this heading shorter/);
  await assert.rejects(
    f.client.send(ROOT, { text: "", attachments: [{ ...attachment, text: "" }] }),
    /empty or invalid/,
  );
  assert.equal(f.socket.sent.filter(row => row.method === "turn/start").length, 1);
});

test("Claude MCP import previews safely, rejects stale and duplicate entries, and writes without reload", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-claude-mcp-"));
  const configPath = path.join(home, "config.toml");
  await fs.writeFile(configPath, "", { mode: 0o600 });
  const file = path.join(home, ".claude.json");
  const source = {
    mcpServers: {
      shadcn: { command: "npx", args: ["shadcn", "mcp"], env: { SECRET: "private-value" } },
      rag: { command: "old" },
    },
  };
  await fs.writeFile(file, JSON.stringify(source));
  const { client, socket, configRead } = fixture({ clientOptions: { appHome: home } });
  required(configRead.layers[0]).name.file = configPath;
  await client.initialize();
  const preview = await client.previewClaudeMcp();
  assert.deepEqual(
    preview.servers.map(row => [row.name, row.status]),
    [
      ["shadcn", "available"],
      ["rag", "exists"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(preview), /private-value|npx/);
  await assert.rejects(
    client.importClaudeMcp({ version: preview.version, revision: preview.revision, names: ["rag"] }),
    /Unsupported|changed/i,
  );
  const input = { version: preview.version, revision: preview.revision, names: ["shadcn"] };
  await fs.writeFile(file, JSON.stringify({ ...source, changed: true }));
  await assert.rejects(client.importClaudeMcp(input), /changed/);
  await fs.writeFile(file, JSON.stringify(source));
  assert.deepEqual(await client.importClaudeMcp(input), { imported: 1 });
  const writes = socket.sent.filter(row => row.method === "config/batchWrite");
  assert.equal(writes.length, 1);
  assert.deepEqual(required(required(writes[0]).params).edits, [
    { keyPath: "mcp_servers.shadcn", value: source.mcpServers.shadcn, mergeStrategy: "replace" },
  ]);
  assert.equal(required(required(writes[0]).params).reloadUserConfig, false);
  assert.equal(
    socket.sent.some(row => row.method === "config/mcpServer/reload"),
    false,
  );
});
