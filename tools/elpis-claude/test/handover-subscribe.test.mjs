import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { drainProxy } from "../handover.mjs";
import { startToken } from "../shared-runtime.mjs";

test("old-drain subscription falls back to one read, while other results stay exact", async (t) => {
  const base = path.join(os.homedir(), ".cache", "elpis-tests");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "follow-drain-"));
  const previousSocket = process.env.ELPIS_BRIDGE_SOCKET;
  process.env.ELPIS_BRIDGE_SOCKET = path.join(root, "bridge.sock");
  const drainSocket = path.join(root, "drain.sock");
  const threads = ["legacy", "read-fails", "modern", "broken", "wrong-error"];
  const token = startToken(process.ppid);
  assert(token, "the old bridge identity is available");
  fs.writeFileSync(path.join(root, "drain.json"), JSON.stringify({ pid: process.ppid, token, sock: drainSocket, threads }));
  const server = http.createServer();
  const upstream = new WebSocketServer({ server });
  const seen = [];
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    seen.push(request);
    if (request.method === "initialize") return socket.send(JSON.stringify({ id: request.id, result: {} }));
    const id = request.params?.threadId;
    if (request.method === "thread/subscribe") {
      if (id === "legacy" || id === "read-fails") return socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: "Invalid request: unknown variant `thread/subscribe`, expected another method" } }));
      if (id === "broken") return socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: "engine failed" } }));
      if (id === "wrong-error") return socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: "Invalid request: another error" } }));
      return socket.send(JSON.stringify({ id: request.id, result: { thread: { id, status: { type: "active" } } } }));
    }
    if (request.method === "thread/read") {
      if (id === "read-fails") return socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: "history failed" } }));
      return socket.send(JSON.stringify({ id: request.id, result: { thread: { id, status: { type: "active" } } } }));
    }
  }));
  server.listen(drainSocket);
  await once(server, "listening");
  const received = [], closed = [];
  const viewer = { readyState: WebSocket.OPEN, pending: new Set(), sendWire: line => received.push(JSON.parse(line)), close: (...args) => { closed.push(args); viewer.readyState = WebSocket.CLOSED; } };
  const proxy = drainProxy(viewer);
  t.after(async () => {
    proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    if (previousSocket === undefined) delete process.env.ELPIS_BRIDGE_SOCKET; else process.env.ELPIS_BRIDGE_SOCKET = previousSocket;
    const trash = spawnSync("gio", ["trash", root]);
    assert.equal(trash.status, 0, String(trash.stderr));
  });
  proxy.take({ method: "initialize", params: { clientInfo: { name: "test", version: "1" }, capabilities: { experimentalApi: true } } });
  for (const [index, threadId] of threads.entries()) assert.equal(proxy.take({ id: index + 1, method: "thread/subscribe", params: { threadId, includeTurns: false } }), true);
  assert.equal(proxy.take({ id: 99, method: "thread/subscribe", params: { threadId: "new-runtime" } }), false);
  const until = async (predicate, message) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(message);
  };
  await until(() => received.length === threads.length, "all responses arrive");
  const response = id => received.find(message => message.id === id);
  assert.equal(response(1).result.followingLive, false);
  assert.equal(response(1).result.thread.id, "legacy");
  assert.equal(response(2).error.message, "history failed");
  assert.equal(response(3).result.followingLive, undefined);
  assert.equal(response(4).error.message, "engine failed");
  assert.equal(response(5).error.message, "Invalid request: another error");
  assert.deepEqual(seen.filter(request => request.method === "thread/read").map(request => request.params.threadId).sort(), ["legacy", "read-fails"]);
  assert.equal(seen.some(request => ["thread/resume", "thread/settings/update", "turn/start"].includes(request.method)), false);
  for (const socket of upstream.clients) socket.send(JSON.stringify({ method: "bridge/released", params: { threadId: "legacy" } }));
  await until(() => closed.length === 1, "the viewer reconnects when the old child finishes");
  assert.equal(closed[0][0], 1012);
});
