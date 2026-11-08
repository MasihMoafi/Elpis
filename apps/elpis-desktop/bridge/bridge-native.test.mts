import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startDesktopServer } from "./server.mts";
import { required, ROOT, CHILD, fixture } from "./bridge.fixtures.mts";

test("live voice delivers SDP privately and ends the native call when its window disconnects", async t => {
  const { client, socket } = fixture();
  await client.initialize();
  const nativeSend = socket.send;
  let stopCount = 0,
    holdStart = false,
    chatgpt = true;
  let startRequest:
    | {
        params: {
          transport: { type: string };
          voice: string;
          initialItems: { role: string; text: string }[];
          delegationAckFiller: boolean;
        };
      }
    | undefined;
  let finishStart: (() => void) | undefined, savedVoice: unknown;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const answer = (result: unknown) =>
      queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, result })));
    if (request.method === "config/read") {
      answer({ config: { realtime: savedVoice ? { voice: savedVoice } : undefined } });
      return;
    }
    if (request.method === "config/batchWrite") {
      socket.sent.push(request);
      savedVoice = request.params.edits[0].value;
      answer({});
      return;
    }
    if (request.method === "account/read" && !chatgpt) {
      queueMicrotask(() =>
        socket.emit("message", JSON.stringify({ id: request.id, result: { account: { type: "apiKey" } } })),
      );
      return;
    }
    if (!request.method?.startsWith("thread/realtime/")) return nativeSend(raw);
    socket.sent.push(request);
    if (request.method === "thread/realtime/start") startRequest = request;
    if (request.method === "thread/realtime/stop") stopCount++;
    const reply = () => {
      socket.emit(
        "message",
        JSON.stringify({
          id: request.id,
          result: request.method.endsWith("listVoices")
            ? { voices: { v1: ["cove", "juniper"], v2: ["alloy"], defaultV1: "cove", defaultV2: "alloy" } }
            : {},
        }),
      );
      if (request.method.endsWith("/start"))
        socket.emit(
          "message",
          JSON.stringify({ method: "thread/realtime/sdp", params: { threadId: ROOT, sdp: "v=0\r\nanswer" } }),
        );
    };
    if (holdStart && request.method.endsWith("/start")) finishStart = reply;
    else queueMicrotask(reply);
  };
  const app = await startDesktopServer({ client });
  t.after(() => app.close());
  const url = new URL(app.url),
    origin = url.origin;
  const auth = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }),
  });
  const headers = {
    Origin: origin,
    Cookie: required(required(auth.headers.get("set-cookie")).split(";")[0]),
    "Content-Type": "application/json",
  };
  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(origin + "/api/voice", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  const catalog = await (await fetch(origin + "/api/voice", { headers })).json();
  assert.deepEqual(
    catalog,
    { available: true, voices: ["cove", "juniper"], voice: "cove" },
    "no saved choice: the native default",
  );
  const choose = (voice: string) =>
    fetch(origin + "/api/voice/choice", { method: "POST", headers, body: JSON.stringify({ voice }) });
  assert.equal((await post({ threadId: "invalid", sdp: "v=0\r\noffer" })).status, 400);
  const unsupported = await choose("alloy"); // a voice of another protocol version
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /Choose one of the listed voices/);
  assert.equal(
    socket.sent.filter(row => row.method === "config/batchWrite").length,
    0,
    "an unlisted voice is never saved",
  );
  assert.deepEqual(await (await choose("juniper")).json(), {
    available: true,
    voices: ["cove", "juniper"],
    voice: "juniper",
  });
  assert.deepEqual(required(required(socket.sent.find(row => row.method === "config/batchWrite")).params).edits, [
    { keyPath: "realtime.voice", value: "juniper", mergeStrategy: "replace" },
  ]);
  assert.equal(socket.sent.filter(row => row.method === "thread/realtime/start").length, 0);
  const abort = new AbortController();
  const response = await post({ threadId: ROOT, sdp: "v=0\r\noffer" }, abort.signal);
  assert.equal(response.status, 200);
  assert.match(required(response.headers.get("content-type")), /ndjson/);
  const reader = required(response.body).getReader();
  let received = "";
  while (!received.includes("answer")) received += new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(received, /PRIVATE CONFIG SECRET|auth|token/);
  assert.equal(JSON.parse(received.trim()).sdp, "v=0\r\nanswer");
  assert.equal(required(startRequest).params.transport.type, "webrtc");
  assert.equal(required(startRequest).params.voice, "juniper", "the call speaks in the saved voice");
  assert.equal(
    required(required(startRequest).params.initialItems[0]).role,
    "developer",
    "voice receives the current Elpis execution context",
  );
  // 5 Nov: the voice told Masih a finished edit "hit a snag" while it waited. It waits silently and reports only the agent's outcome.
  assert.equal(
    required(startRequest).params.delegationAckFiller,
    false,
    "no filler speech of its own while the agent works",
  );
  assert.match(
    required(required(startRequest).params.initialItems[0]).text,
    /never say a task failed, hit a snag or could not be done unless its reply says so/,
  );
  assert.equal((await post({ threadId: ROOT, sdp: "v=0\r\noffer" })).status, 409);
  abort.abort();
  await reader.cancel().catch(() => {});
  const deadline = Date.now() + 2000;
  while (!stopCount && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopCount, 1, "closing the stream must release the native call");
  holdStart = true;
  const duringStart = new AbortController();
  const pending = await post({ threadId: ROOT, sdp: "v=0\r\noffer" }, duringStart.signal);
  const startingDeadline = Date.now() + 2000;
  while (!finishStart && Date.now() < startingDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof finishStart, "function");
  duringStart.abort();
  await required(pending.body)
    .cancel()
    .catch(() => {});
  required(finishStart)();
  const endedDeadline = Date.now() + 2000;
  while (stopCount < 2 && Date.now() < endedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopCount, 2, "End during native startup must stop the late call");
  chatgpt = false;
  const denied = await post({ threadId: ROOT, sdp: "v=0\r\noffer" });
  assert.match(await denied.text(), /Voice needs a ChatGPT connection/);
  assert.equal(
    socket.sent.filter(row => row.method === "thread/realtime/start").length,
    2,
    "API-key accounts must never start a call",
  );
});

test("HTTP requires capability/cookie, strict origin/host, allowlisted routes and contained assets", async t => {
  const { client, socket } = fixture();
  await client.initialize();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-desktop-test-"));
  const out = path.join(temp, "out");
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, "index.html"), "<h1>Elpis</h1>");
  await fs.writeFile(path.join(temp, "secret.txt"), "PLANTED PRIVATE FILE");
  await fs.symlink(path.join(temp, "secret.txt"), path.join(out, "leak.txt"));
  const app = await startDesktopServer({ client, staticDir: out });
  t.after(() => app.close());
  const url = new URL(app.url);
  const origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const post = (pathname: string, data: unknown, headers = {}) =>
    fetch(origin + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...headers },
      body: JSON.stringify(data),
    });
  assert.equal((await fetch(origin + "/")).status, 200);
  assert.equal((await fetch(origin + "/api/threads")).status, 401);
  assert.equal((await post("/api/session", { token: "wrong" })).status, 403);
  assert.equal((await post("/api/session", { token }, { Origin: "https://evil.example" })).status, 403);
  const auth = await post("/api/session", { token });
  assert.equal(auth.status, 200);
  assert.match(required(auth.headers.get("set-cookie")), /HttpOnly; SameSite=Strict/);
  const cookie = required(required(auth.headers.get("set-cookie")).split(";")[0]);
  const get = (pathname: string) => fetch(origin + pathname, { headers: { Cookie: cookie } });
  const result = await (await get("/api/threads")).json();
  assert.deepEqual(
    result.data.map((thread: { id: string }) => thread.id),
    [ROOT],
  );
  const all = await (await get("/api/threads?includeAgentRuns=true")).json();
  assert.equal(all.data.length, 2);
  assert.equal((await get("/api/threads?includeAgentRuns=yes")).status, 400);
  const child = await (await get(`/api/threads/${CHILD}`)).json();
  assert.equal(child.thread.id, CHILD);
  assert.equal(child.thread.desktopAccess.writable, false);
  assert.equal((await post(`/api/threads/${CHILD}/continue`, {}, { Cookie: cookie })).status, 409);
  const settings = await (await get("/api/settings")).json();
  assert.equal(settings.smartPrune.enabled, true);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE CONFIG SECRET|private\/config/);
  const context = await (await get(`/api/threads/${ROOT}/context`)).json();
  assert.equal(context.tokenUsage, null);
  for (const route of ["/api/dashboard", "/api/dashboard/", "/api/dashboard/agents.json"]) {
    assert.equal((await get(route)).status, 404, "OBSRM: the retired page transport is no longer served");
  }
  assert.equal((await post("/api/settings", { background_model: "changed" }, { Cookie: cookie })).status, 400);
  assert.equal((await post(`/api/threads/${ROOT}/context`, {}, { Cookie: cookie })).status, 405);
  assert.equal((await get("/api/threads?archived=yes")).status, 400);
  assert.equal((await get("/api/threads?archived=true")).status, 200);
  assert.equal((await get("/api/threads?archived=false")).status, 200);
  assert.equal(
    (await post(`/api/threads/${ROOT}/rename`, { name: "Renamed over HTTP" }, { Cookie: cookie })).status,
    200,
  );
  assert.equal(
    (await post(`/api/threads/${ROOT}/turns`, { text: "written directly" }, { Cookie: cookie })).status,
    200,
  );
  for (const route of ["/api/mcp", "/api/providers"])
    assert.doesNotMatch(await (await get(route)).text(), /PRIVATE CONFIG SECRET|token=/);
  assert.equal((await post("/api/rpc", { method: "command/exec" }, { Cookie: cookie })).status, 404);
  assert.equal((await get("/api/threads?limit=10000")).status, 400);
  // Node fetch rewrites Host; raw HTTP verifies the server's actual Host guard.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(
      origin + "/api/threads",
      { agent: new http.Agent(), headers: { Cookie: cookie, Host: "evil.example" } },
      response => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post("/api/threads", {}, { Cookie: cookie, Origin: "null" })).status, 403);
  assert.equal((await get("/leak.txt")).status, 403);
  assert.equal(
    socket.sent.some(row => row.method === "command/exec"),
    false,
  );
});

test("workflow workers keep recorded task names and lineage when native list omits their parent", async () => {
  const { client, socket, threads, workflowRecords } = fixture({ omitWorkflowParentInList: true });
  await client.initialize();
  const graphId = "10000000-0000-0000-0000-000000000001";
  threads.set(CHILD, {
    id: CHILD,
    name: null,
    parentThreadId: ROOT,
    status: { type: "idle" },
    source: { subAgent: { other: `work_graph:${graphId}:inspect` } },
  });
  workflowRecords.push({
    id: graphId,
    rootThreadId: ROOT,
    tasks: [{ id: "inspect", title: "Inspect actual project", assignedThreadId: CHILD }],
  });
  const worker = (await client.listThreads({ includeAgentRuns: true })).data.find(thread => thread.id === CHILD);
  assert.ok(worker);
  assert.equal(worker.workflowTaskTitle, "Inspect actual project");
  assert.equal(worker.parentThreadId, ROOT, "list must preserve the native read and recorded graph lineage");
  assert.deepEqual(
    socket.sent.filter(row => row.method === "thread/read").map(row => required(row.params).threadId),
    [CHILD],
  );
  const again = (await client.listThreads({ includeAgentRuns: true })).data.find(thread => thread.id === CHILD);
  assert.ok(again);
  assert.equal(again.parentThreadId, ROOT);
  assert.equal(
    socket.sent.filter(row => row.method === "thread/read").length,
    1,
    "verified workflow metadata is reused",
  );
  required(threads.get(CHILD)).source = { subAgent: { other: `work_graph:${graphId}:different-task` } };
  const unrelated = (await client.listThreads({ includeAgentRuns: true })).data.find(thread => thread.id === CHILD);
  assert.ok(unrelated);
  assert.equal(unrelated.workflowTaskTitle, undefined);
  assert.equal(unrelated.parentThreadId, null, "unrecorded task cannot inherit cached lineage");
  client.close();
});

test("workflow history includes native teams discovered through their task chats", async () => {
  const { client, threads, workflowRecords } = fixture();
  try {
    await client.initialize();
    const id = "00000000-0000-0000-0000-000000000099";
    required(threads.get(CHILD)).source = { subAgent: { other: `work_graph:${id}:review` } };
    workflowRecords.push({ id, rootThreadId: ROOT, name: "Native review", status: "running", tasks: [] });
    const result = await client.workflowHistory();
    assert.equal(result.data.length, 1);
    assert.ok(result.data[0]);
    assert.equal(result.data[0].id, id);
    assert.equal(result.data[0].rootThreadId, ROOT);
  } finally {
    client.close();
  }
});
