import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopClient } from "./client.mts";
import { startDesktopServer } from "./server.mts";
import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import { required, ROOT, CHILD, fixture } from "./bridge.fixtures.mts";
import type { FixtureGraph } from "./bridge.fixtures.mts";

test("workflow history Remove and restart Undo are profile-scoped; active work and chats are preserved", async () => {
  const dir = createTestTempDir(path.join(os.tmpdir(), "elpis-history-"));
  const home = path.join(dir, "profile"),
    ambient = path.join(dir, "ambient");
  const savedId = "00000000-0000-0000-0000-000000000098",
    activeId = "00000000-0000-0000-0000-000000000099",
    nativeId = "00000000-0000-0000-0000-000000000096";
  const saved = {
    id: savedId,
    rootThreadId: ROOT,
    name: "Finished team",
    status: "cancelled",
    tasks: [{ id: "not-started", status: "pending" }],
  };
  const seed = async (profile: string, record: FixtureGraph) => {
    await fs.mkdir(path.join(profile, "desktop-workflows"), { recursive: true });
    const file = path.join(profile, "desktop-workflows", `${record.id}.json`),
      bytes = JSON.stringify(record);
    await fs.writeFile(file, bytes);
    return { file, bytes };
  };
  const original = await seed(home, saved),
    untouched = await seed(ambient, { ...saved, name: "Other profile" });
  const beforeHome = process.env.ELPIS_HOME,
    connect = DesktopClient.connect;
  let app: Awaited<ReturnType<typeof startDesktopServer>> | null = null;
  const fixtures: { first?: ReturnType<typeof fixture>; second?: ReturnType<typeof fixture> } = {};
  const open = async (client?: DesktopClient) => {
    const result = await startDesktopServer({
      ...(client ? { client } : {}),
      elpisHome: home,
      trashFile: path.join(home, "chat-trash.json"),
      loveSpot: { directory: path.join(home, "drawing"), screenshots: path.join(home, "screenshots") },
    });
    const url = new URL(result.url),
      origin = url.origin;
    const auth = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }),
    });
    assert.equal(auth.status, 200);
    const headers = {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: required(required(auth.headers.get("set-cookie")).split(";")[0]),
    };
    return {
      app: result,
      request: (route = "", method = "GET") =>
        fetch(`${origin}/api/workflows/history${route}`, {
          method,
          headers,
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
    };
  };
  try {
    process.env.ELPIS_HOME = ambient;
    // Stand in only for the Unix transport: the server's actual options construct the real client and storage.
    DesktopClient.connect = async options => {
      const first = fixture({ clientOptions: { ...options, home: required(options).home, workflowOptions: {} } });
      fixtures.first = first;
      await first.client.initialize();
      required(first.threads.get(CHILD)).source = { subAgent: { other: `work_graph:${activeId}:review` } };
      first.workflowRecords.push({
        id: activeId,
        rootThreadId: ROOT,
        name: "Still working",
        status: "running",
        tasks: [],
      });
      return first.client;
    };
    let opened = await open();
    app = opened.app;
    let request = opened.request;
    const first = required(fixtures.first);
    DesktopClient.connect = connect;
    let history: { data: { id: string; name: string; removable: boolean }[]; canUndo: boolean } = await (
      await request()
    ).json();
    assert.deepEqual(history.data.map(run => run.name).sort(), ["Finished team", "Still working"]);
    assert.equal(history.canUndo, false);
    const refused = await request(`/${activeId}/remove`, "POST");
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /finish|running/i);
    assert.equal((await request("/00000000-0000-0000-0000-000000000097/remove", "POST")).status, 404);
    const continuation: typeof saved & { next: { status: string | undefined } } = {
      ...saved,
      id: nativeId,
      status: "succeeded",
      next: { status: "waiting" },
    };
    required(first).workflowRecords.push(continuation);
    for (const status of ["waiting", "starting", "running", "unknown", undefined]) {
      continuation.next.status = status;
      const blocked = await request(`/${nativeId}/remove`, "POST");
      assert.equal(blocked.status, 409, `a succeeded parent cannot hide a ${status ?? "missing-status"} continuation`);
      const visible = (await (await request()).json()).data.find((run: { id: string }) => run.id === nativeId);
      assert.ok(visible);
      assert.equal(visible.removable, false);
    }
    continuation.next.status = "succeeded";
    assert.equal(
      (await request(`/${nativeId}/remove`, "POST")).status,
      200,
      "only a terminal continuation permits removal",
    );
    assert.equal((await request("/undo", "POST")).status, 200);
    required(first).workflowRecords.pop();
    // A second Remove waits behind a held metadata write. Its native run resumes before that queue advances.
    const resumed = { ...saved, id: nativeId, status: "completed" };
    required(first).workflowRecords.push(resumed);
    const gate = () => {
      let release: (() => void) | undefined;
      const promise = new Promise<void>(done => {
        release = done;
      });
      return { promise, resolve: () => required(release)() };
    };
    const writing = gate(),
      releaseWrite = gate(),
      queued = gate();
    const renameBeforeQueue = fs.rename,
      removeBeforeQueue = required(first).client.removeWorkflowHistory;
    let holdWrite = true;
    let firstRemoval: Promise<Response> | undefined, queuedRemoval: Promise<Response> | undefined;
    fs.rename = async (source, target) => {
      if (holdWrite && target === path.join(home, "desktop-workflow-history.json")) {
        holdWrite = false;
        writing.resolve();
        await releaseWrite.promise;
      }
      return renameBeforeQueue(source, target);
    };
    required(first).client.removeWorkflowHistory = function (id: unknown, body: unknown) {
      const pending = removeBeforeQueue.call(this, id, body);
      if (id === nativeId) queued.resolve();
      return pending;
    };
    try {
      firstRemoval = request(`/${savedId}/remove`, "POST");
      await writing.promise;
      queuedRemoval = request(`/${nativeId}/remove`, "POST");
      await queued.promise;
      // The fixture transport replies in microtasks; drain any eager reads while the first write stays held.
      await new Promise(resolve => setImmediate(resolve));
      resumed.status = "running";
      releaseWrite.resolve();
      assert.equal((await firstRemoval).status, 200);
      assert.equal(
        (await queuedRemoval).status,
        409,
        "the queued action must read resumed state, not a pre-queue snapshot",
      );
      assert.ok(
        (await (await request()).json()).data.some((run: { id: string }) => run.id === nativeId),
        "resumed work stays in history",
      );
    } finally {
      releaseWrite.resolve();
      fs.rename = renameBeforeQueue;
      required(first).client.removeWorkflowHistory = removeBeforeQueue;
      await Promise.allSettled(
        [firstRemoval, queuedRemoval].filter((value): value is Promise<Response> => value !== undefined),
      );
    }
    assert.equal((await request("/undo", "POST")).status, 200);
    required(first).workflowRecords.pop();
    const rename = fs.rename;
    fs.rename = (source, target) =>
      target === path.join(home, "desktop-workflow-history.json")
        ? Promise.reject(Object.assign(new Error("Disk full"), { code: "ENOSPC" }))
        : rename(source, target);
    try {
      const failed = await request(`/${savedId}/remove`, "POST");
      assert.equal(failed.status, 503);
      assert.match((await failed.json()).error, /Nothing was removed/);
    } finally {
      fs.rename = rename;
    }
    history = await (await request()).json();
    assert.ok(history.data.some(run => run.id === savedId));
    assert.equal(history.canUndo, false);
    assert.equal((await request(`/${savedId}/remove`, "POST")).status, 200);
    history = await (await request()).json();
    assert.deepEqual(
      history.data.map(run => run.id),
      [activeId],
    );
    assert.equal(history.canUndo, true);
    // Even an external resume must make a removed record visible again while it works.
    const native = { ...saved, id: nativeId, status: "completed" };
    required(first).workflowRecords.push(native);
    assert.equal((await request(`/${nativeId}/remove`, "POST")).status, 200);
    native.status = "running";
    assert.ok(
      (await (await request()).json()).data.some((run: { id: string }) => run.id === nativeId),
      "removal cannot conceal resumed work",
    );
    assert.equal((await request("/undo", "POST")).status, 200);
    required(first).workflowRecords.pop();
    await app.close();
    app = null;
    const second = fixture({ clientOptions: { home, workflowOptions: {} } });
    fixtures.second = second;
    await second.client.initialize();
    opened = await open(second.client);
    app = opened.app;
    request = opened.request;
    history = await (await request()).json();
    assert.deepEqual(history.data, []);
    assert.equal(history.canUndo, true);
    assert.equal((await request("/undo", "POST")).status, 200);
    history = await (await request()).json();
    assert.deepEqual(
      history.data.map(run => run.name),
      ["Finished team"],
    );
    assert.equal(history.canUndo, false);
    assert.equal(await fs.readFile(original.file, "utf8"), original.bytes, "history removal never rewrites the run");
    assert.equal(await fs.readFile(untouched.file, "utf8"), untouched.bytes, "the ambient profile is untouched");
    for (const f of [first, second])
      assert.deepEqual(
        f.socket.sent.filter(row =>
          /thread\/(?:archive|unarchive|delete)|workGraph\/(?:run|stop)|workflowRun\/(?:start|stop|resume)/.test(
            row.method ?? "",
          ),
        ),
        [],
        "history actions never mutate chats or execution",
      );
  } finally {
    DesktopClient.connect = connect;
    if (beforeHome === undefined) delete process.env.ELPIS_HOME;
    else process.env.ELPIS_HOME = beforeHome;
    await app?.close();
    fixtures.first?.client.close();
    fixtures.second?.client.close();
    removeTestTempDir(dir);
  }
});

test("manual workflows require an idle root and dispatch the reviewed graph through ACP", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  const task = {
    id: "inspect",
    title: "Inspect",
    instruction: "Read the evidence",
    kind: "explore",
    dependsOn: [],
    writeScopes: [],
    acceptanceCriteria: ["Report evidence"],
  };
  const draft = { rootThreadId: ROOT, name: "Reviewed workflow", maxConcurrency: 2, tasks: [task] };
  assert.deepEqual(await client.workflows(ROOT), { data: [] });
  await assert.rejects(client.runWorkflow({ ...draft, rootThreadId: CHILD }), /root conversation/);
  required(threads.get(ROOT)).status = { type: "active" };
  await assert.rejects(client.runWorkflow(draft), /Wait for/);
  required(threads.get(ROOT)).status = { type: "idle" };
  await assert.rejects(client.runWorkflow({ ...draft, approvalPolicy: "never" }), /Unsupported/);
  await assert.rejects(client.runWorkflow({ ...draft, tasks: [{ ...task, model: "bad model" }] }), /model ID/);
  assert.equal(
    socket.sent.some(row => row.method === "workGraph/run"),
    false,
  );
  const started = await client.runWorkflow(draft);
  const record = (await client.workflows(ROOT)).data.find(row => row.id === started.graphId);
  assert.ok(record);
  assert.ok(record.tasks[0]);
  assert.ok("instruction" in record.tasks[0]);
  assert.equal(record.name, draft.name);
  assert.equal(record.tasks[0].instruction, task.instruction);
  assert.equal(
    socket.sent.some(row => row.method === "turn/start"),
    false,
  );
  assert.equal(socket.sent.filter(row => row.method === "workGraph/run").length, 0);
  client.close();
});

test("a task reasoning effort is validated and retained for ACP execution", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const task = {
    id: "inspect",
    title: "Inspect",
    instruction: "Read the evidence",
    kind: "explore",
    dependsOn: [],
    writeScopes: [],
    acceptanceCriteria: ["Report evidence"],
  };
  const draft = {
    rootThreadId: ROOT,
    name: "Effort workflow",
    tasks: [
      { ...task, reasoningEffort: "high" },
      { ...task, id: "plain", dependsOn: ["inspect"] },
    ],
  };
  for (const bad of ["", "High", "x", "high effort", "a".repeat(17), 7, null])
    await assert.rejects(
      client.runWorkflow({ ...draft, tasks: [{ ...task, reasoningEffort: bad }] }),
      /reasoning effort/,
      JSON.stringify(bad),
    );
  assert.equal(
    socket.sent.some(row => required(row.method).startsWith("workGraph/run")),
    false,
  );
  const started = await client.runWorkflow(draft);
  const record = (await client.workflows(ROOT)).data.find(row => row.id === started.graphId);
  assert.ok(record);
  assert.ok(record.tasks[0]);
  assert.ok("reasoningEffort" in record.tasks[0]);
  assert.equal(record.tasks[0].reasoningEffort, "high");
  assert.equal(
    socket.sent.some(row => required(row.method).startsWith("workGraph/run")),
    false,
  );
  client.close();
});

test("worktree isolation is validated and retained by the ACP workflow", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  const task = {
    id: "inspect",
    title: "Inspect",
    instruction: "Read the evidence",
    kind: "explore",
    dependsOn: [],
    writeScopes: [],
    acceptanceCriteria: ["Report evidence"],
  };
  const draft = { rootThreadId: ROOT, name: "Isolated workflow", isolation: "worktree", tasks: [task] };
  for (const bad of ["", "Worktree", "copy", true, null, {}])
    await assert.rejects(client.runWorkflow({ ...draft, isolation: bad }), /isolation/, JSON.stringify(bad));
  assert.equal(
    socket.sent.some(row => required(row.method).startsWith("workGraph/run")),
    false,
  );
  const started = await client.runWorkflow(draft);
  const record = (await client.workflows(ROOT)).data.find(row => row.id === started.graphId);
  assert.ok(record);
  assert.ok("isolation" in record);
  assert.equal(record.isolation, "worktree");
  assert.equal(
    socket.sent.some(row => required(row.method).startsWith("workGraph/run")),
    false,
  );
  client.close();
});

test("browser rag command reaches actual native turn input without changing plain text", async () => {
  for (const input of ["/rag", "/rag show", "/ragged show", "rag show"]) {
    const { client, socket } = fixture();
    await client.initialize();
    await client.send(ROOT, { text: input });
    const submitted = required(
      required(required(required(socket.sent.findLast(row => row.method === "turn/start")).params).input)[0],
    ).text;
    if (input === "/rag" || input === "/rag show") {
      assert(required(submitted).includes("rag config show"));
      assert(required(submitted).includes("configured RAG MCP server"));
      assert(required(submitted).endsWith(input === "/rag" ? "RAG request: " : "RAG request: show"));
    } else assert.equal(submitted, input);
    client.close();
  }
});
