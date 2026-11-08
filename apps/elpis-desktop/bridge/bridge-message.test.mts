import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startDesktopServer } from "./server.mts";
import { required, ROOT, CHILD, CREATED, MODEL, fixture } from "./bridge.fixtures.mts";
import type { ApprovalEvent } from "./bridge.fixtures.mts";

test("a message to a chat the app wrongly thinks busy is delivered, not refused as unavailable (A58)", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  await client.models();
  await client.createThread({ model: MODEL });
  // As the engine: a steer naming any turn but the running one is refused.
  const send = socket.send;
  let running: string | null = null;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const refusal =
      request.params?.input?.[0]?.text === "Review this"
        ? "active turn uses a different output schema"
        : request.params?.expectedTurnId === running
          ? null
          : running
            ? `expected active turn id \`${request.params?.expectedTurnId}\` but found \`${running}\``
            : "no active turn to steer";
    if (request.method !== "turn/steer" || !refusal) return send(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit("message", JSON.stringify({ id: request.id, error: { code: -32600, message: refusal } })),
    );
  };
  // The turn the app saw has finished: the message starts a new turn.
  const restarted = await client.steer(CREATED, { text: "Are you there?", expectedTurnId: "finished-turn" });
  assert.ok(
    restarted &&
      typeof restarted === "object" &&
      "turn" in restarted &&
      restarted.turn &&
      typeof restarted.turn === "object" &&
      "id" in restarted.turn,
  );
  assert.equal(restarted.turn.id, "new-turn");
  assert.equal(
    required(required(required(required(socket.sent.findLast(row => row.method === "turn/start")).params).input)[0])
      .text,
    "Are you there?",
  );
  // Another turn replaced it: the message joins the running turn instead.
  running = "running-turn";
  const steered = await client.steer(CREATED, { text: "Also this", expectedTurnId: "new-turn" });
  assert.ok(steered && typeof steered === "object" && "turnId" in steered);
  assert.equal(steered.turnId, "running-turn");
  assert.equal(socket.sent.filter(row => row.method === "turn/start").length, 1);
  // Any other refusal keeps the engine's reason instead of a bare code.
  await assert.rejects(
    client.steer(CREATED, { text: "Review this", expectedTurnId: "running-turn" }),
    /different output schema/,
  );
});

test("a message steered into a compaction is handed back for the queue, not refused or sent as a new turn", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  await client.models();
  await client.createThread({ model: MODEL });
  // As the engine (codex-rs app-server turn_processor.rs): a compact turn cannot be steered.
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "turn/steer") return send(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({ id: request.id, error: { code: -32600, message: "cannot steer a compact turn" } }),
      ),
    );
  };
  assert.deepEqual(await client.steer(CREATED, { text: "After compacting", expectedTurnId: "compact-turn" }), {
    compacting: true,
  });
  assert.equal(
    socket.sent.filter(row => row.method === "turn/start").length,
    0,
    "nothing starts beside the compaction",
  );
  assert.equal(socket.sent.filter(row => row.method === "thread/turns/list").length, 0);
  // A review turn still says why it refuses.
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "turn/steer") return send(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({ id: request.id, error: { code: -32600, message: "cannot steer a review turn" } }),
      ),
    );
  };
  await assert.rejects(
    client.steer(CREATED, { text: "Review this", expectedTurnId: "review-turn" }),
    /cannot steer a review turn/,
  );
});

test("approvals are only forwarded for owned roots and only accept exact offered decisions, including amendments", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  await client.createThread({});
  const events: ApprovalEvent[] = [];
  client.on("event", event => events.push(event));
  const always = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "diff"] } };
  const approval = (threadId: string) => ({
    id: "approval-native",
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: "turn1", command: "echo hello", availableDecisions: ["accept", always, "decline"] },
  });
  socket.emit("message", JSON.stringify(approval(ROOT)));
  assert.equal(events.length, 0);
  socket.emit("message", JSON.stringify(approval(CREATED)));
  const first = required(events[0]);
  assert.ok(first.type === "approval");
  const visible = first.data;
  assert.equal(visible.wireId, undefined);
  assert.throws(() => client.answerApproval(visible.id, { decision: "rm -rf" }), /Unsupported/);
  assert.throws(() => client.answerApproval(visible.id, { decision: "acceptForSession" }), /not offered/);
  assert.throws(
    () =>
      client.answerApproval(visible.id, {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] } },
      }),
    /not offered/,
  );
  client.answerApproval(visible.id, { decision: always });
  assert.deepEqual(socket.sent.at(-1), { id: "approval-native", result: { decision: always } });
  assert.throws(() => client.answerApproval(visible.id, { decision: "accept" }), /no longer pending/);
  socket.emit(
    "message",
    JSON.stringify({ id: "future", method: "future/requestApproval", params: { threadId: CREATED } }),
  );
  assert.equal(required(required(socket.sent.at(-1)).error).code, -32601);
  client.close();
});

test("worker approvals follow recorded ancestry and name the requester; resolved requests cannot reappear", async () => {
  const { client, socket, threads } = fixture();
  await client.initialize();
  await client.resume(ROOT, {});
  const grandchild = "00000000-0000-0000-0000-000000000005";
  threads.set(grandchild, {
    id: grandchild,
    name: "Review worker",
    parentThreadId: CHILD,
    source: { subAgent: { other: "work_graph:fixture:review" } },
    status: { type: "active" },
  });
  const events: ApprovalEvent[] = [];
  client.on("event", event => events.push(event));
  const request = (id: string, wire: string) =>
    socket.emit(
      "message",
      JSON.stringify({
        id: wire,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: id,
          turnId: "worker-turn",
          command: "inspect evidence",
          availableDecisions: ["accept", "decline"],
        },
      }),
    );
  request(grandchild, "worker-approval");
  await new Promise(resolve => setImmediate(resolve));
  const approval = events.find(event => event.type === "approval")?.data;
  assert.ok(approval, "owned-root descendant request must be visible");
  assert.equal(approval.ownerThreadId, ROOT);
  assert.equal(approval.thread.name, "Review worker");
  assert.equal(approval.params.threadId, grandchild);
  client.answerApproval(approval.id, { decision: "accept" });
  assert.deepEqual(socket.sent.at(-1), { id: "worker-approval", result: { decision: "accept" } });
  const unrelated = "00000000-0000-0000-0000-000000000006";
  threads.set(unrelated, { id: unrelated, name: "Unrelated root", status: { type: "active" } });
  request(unrelated, "unrelated-approval");
  request(CHILD, "already-resolved");
  socket.emit(
    "message",
    JSON.stringify({ method: "serverRequest/resolved", params: { threadId: CHILD, requestId: "already-resolved" } }),
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event.type === "approval").length, 1);
  assert.equal(client.pendingApprovals.length, 0);
  request(ROOT, "root-resolved-elsewhere");
  const last = required(events.filter(event => event.type === "approval").at(-1)).data;
  socket.emit(
    "message",
    JSON.stringify({
      method: "serverRequest/resolved",
      params: { threadId: ROOT, requestId: "root-resolved-elsewhere" },
    }),
  );
  assert.ok(events.some(event => event.type === "approvalResolved" && event.data.id === last.id));
  assert.equal(client.pendingApprovals.length, 0);
  client.close();
});

test("prompt index route pages the full thread and returns ordered, bounded prompt and reply previews", async t => {
  const prompt = (turnId: string, content: object[]) => ({
    turnId,
    item: { id: `u-${turnId}`, type: "userMessage", content },
  });
  const promptPages = {
    start: {
      data: [
        { turnId: "t5", item: { id: "reply-later", type: "agentMessage", text: "Later fifth answer" } },
        { turnId: "t5", item: { id: "reply", type: "agentMessage", text: "Fifth answer" } },
        prompt("t5", [{ type: "text", text: "Fifth prompt" }]),
        prompt("t4", [{ type: "text", text: "Fourth prompt" }]),
      ],
      nextCursor: "middle",
    },
    middle: {
      data: [
        {
          turnId: "t3",
          item: { id: "reply-3", type: "agentMessage", content: [{ type: "text", text: "Third answer" }] },
        },
        prompt("t3", [{ type: "text", text: "Third prompt" }]),
        { turnId: "t2", item: { id: "reply-2", type: "agentMessage", text: "B".repeat(700) } },
        prompt("t2", [{ type: "text", text: "Second prompt" }]),
      ],
      nextCursor: "oldest",
    },
    oldest: {
      data: [
        prompt("t1", [
          { type: "text", text: "A".repeat(240) },
          { type: "image", image: "not text" },
        ]),
      ],
      nextCursor: null,
    },
  };
  const { client, socket } = fixture({ promptPages });
  await client.initialize();
  const app = await startDesktopServer({ client });
  t.after(() => app.close());
  const url = new URL(app.url),
    origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const auth = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token }),
  });
  assert.equal(auth.status, 200);
  const cookie = required(required(auth.headers.get("set-cookie")).split(";")[0]);
  const route = `/api/threads/${ROOT}/prompts`;
  const response = await fetch(origin + route, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const result: { data: { turnId: string; itemId: string; text: string; reply: string }[] } = await response.json();
  assert.deepEqual(
    result.data.map(row => row.turnId),
    ["t1", "t2", "t3", "t4", "t5"],
  );
  assert.deepEqual(
    result.data.map(row => row.itemId),
    ["u-t1", "u-t2", "u-t3", "u-t4", "u-t5"],
  );
  assert.equal(required(result.data[0]).text, "A".repeat(200));
  assert.deepEqual(
    result.data.slice(1).map(row => row.text),
    ["Second prompt", "Third prompt", "Fourth prompt", "Fifth prompt"],
  );
  assert.deepEqual(
    result.data.map(row => row.reply),
    ["", "B".repeat(600), "Third answer", "", "Fifth answer"],
  );
  assert.doesNotMatch(JSON.stringify(result), /not text/);
  assert.deepEqual(
    socket.sent.filter(row => row.method === "thread/items/list").map(row => required(row.params).cursor ?? null),
    [null, "middle", "oldest"],
  );
  assert.equal(
    (
      await fetch(origin + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
        body: "{}",
      })
    ).status,
    405,
  );
});

test("the prompt index keeps the original item ID when a turn spans pages of steering messages (A98)", async () => {
  const prompt = (itemId: string, text: string) => ({
    turnId: "long-turn",
    item: { id: itemId, type: "userMessage", content: [{ type: "text", text }] },
  });
  const { client } = fixture({
    promptPages: {
      start: { data: [prompt("last-steer", "Later steering")], nextCursor: "middle" },
      middle: { data: [prompt("earlier-steer", "Earlier steering")], nextCursor: "oldest" },
      oldest: { data: [prompt("original", "The original prompt")], nextCursor: null },
    },
  });
  try {
    await client.initialize();
    assert.deepEqual((await client.readPrompts(ROOT)).data, [
      { turnId: "long-turn", itemId: "original", text: "The original prompt", reply: "" },
    ]);
  } finally {
    client.close();
  }
});

test("provider history cursors fit the HTTP query and stay bound to their chat (A98)", async t => {
  // providerPage records consumed native item IDs. A valid 100-item continuation
  // already exceeds pageQuery's 4096-character HTTP limit.
  const cursor =
    "acp-page:" +
    Buffer.from(JSON.stringify({ nativeSeen: Array.from({ length: 100 }, () => randomUUID()) })).toString("base64url");
  assert.ok(cursor.length > 4096);
  const prompt = (turnId: string) => ({
    turnId,
    item: { id: turnId, type: "userMessage", content: [{ type: "text", text: turnId }] },
  });
  const { client, socket } = fixture({
    promptPages: {
      start: { data: [prompt("newest")], nextCursor: cursor },
      [cursor]: { data: [prompt("oldest")], nextCursor: null },
    },
  });
  await client.initialize();
  const app = await startDesktopServer({ client });
  t.after(() => app.close());
  const url = new URL(app.url),
    origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const auth = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token }),
  });
  const headers = { Cookie: required(required(auth.headers.get("set-cookie")).split(";")[0]) };
  const read = (id: string, after?: string) =>
    fetch(`${origin}/api/threads/${id}?limit=100${after ? "&cursor=" + encodeURIComponent(after) : ""}`, { headers });
  const first = await (await read(ROOT)).json();
  assert.ok(first.nextCursor.length <= 4096, `HTTP cursor is ${first.nextCursor.length} characters`);
  assert.equal((await (await read(ROOT)).json()).nextCursor, first.nextCursor, "repeated pages share a continuation");
  const wrongChat = await read(CHILD, first.nextCursor);
  assert.equal(wrongChat.status, 400);
  const count = socket.sent.filter(row => row.method === "thread/items/list").length;
  const stale = await read(ROOT, "desktop-page:unknown");
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /history|conversation/i);
  assert.equal(
    socket.sent.filter(row => row.method === "thread/items/list").length,
    count,
    "unknown continuations never reach the engine",
  );
  const second = await read(ROOT, first.nextCursor);
  assert.equal(second.status, 200);
  assert.deepEqual(
    (await second.json()).data.map((row: { turnId: string }) => row.turnId),
    ["oldest"],
  );
  assert.equal(
    required(required(socket.sent.filter(row => row.method === "thread/items/list").at(-1)).params).cursor,
    cursor,
    "the engine receives its original cursor",
  );
  const index = await (await fetch(`${origin}/api/threads/${ROOT}/prompts`, { headers })).json();
  assert.deepEqual(
    index.data.map((row: { turnId: string }) => row.turnId),
    ["oldest", "newest"],
  );
});
