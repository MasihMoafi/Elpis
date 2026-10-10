// Actual bridge, deterministic local engine, isolated state; no provider calls.
// Run: node --test tools/elpis-claude/test/resume-list.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const self = fileURLToPath(import.meta.url);

if (process.argv.includes("app-server")) {
  const fixture = () => JSON.parse(fs.readFileSync(process.env.RESUME_FIXTURE, "utf8"));
  const record = event => fs.appendFileSync(process.env.RESUME_TRACE, JSON.stringify(event) + "\n");
  let active = 0, maxActive = 0;
  const handle = async (msg, send) => {
    if (msg.id === undefined) return;
    let result = {};
    if (msg.method === "thread/list") result = fixture().pages[msg.params?.cursor ?? "first"];
    if (msg.method === "thread/read") {
      assert.equal(msg.params.includeTurns, false);
      const { threadId } = msg.params;
      const row = fixture().threads[threadId];
      record({ start: threadId });
      maxActive = Math.max(maxActive, ++active);
      if (row?.hang) return;
      await pause(row?.delay ?? fixture().delay ?? 0);
      active--;
      record({ finish: threadId });
      if (!row || row.error) {
        send({ id: msg.id, error: row?.error ?? { code: -32600, message: `thread not found: ${threadId}` } });
        return;
      }
      result = { thread: row.thread };
    }
    if (msg.method === "fixture/stats") result = { active, maxActive };
    send({ id: msg.id, result });
  };
  const listenAt = process.argv.indexOf("--listen");
  if (listenAt >= 0) {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", socket => {
      record({ connection: "open" });
      socket.on("close", () => record({ connection: "close" }));
      socket.on("message", data => handle(JSON.parse(String(data)), msg => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      }));
    });
    server.listen(process.argv[listenAt + 1].replace(/^unix:\/\//, ""));
  } else {
    readline.createInterface({ input: process.stdin }).on("line", line => {
      handle(JSON.parse(line), msg => process.stdout.write(JSON.stringify(msg) + "\n"));
    });
  }
} else {
  async function setup(t, fixture, store, shared = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-resume-list-"));
    const config = path.join(root, "fixture.json"), trace = path.join(root, "trace.jsonl");
    fs.writeFileSync(config, JSON.stringify(fixture)); fs.writeFileSync(trace, "");
    fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify(store));
    const engine = path.join(root, "engine");
    fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(self)};\n`, { mode: 0o755 });
    const log = path.join(root, "bridge.log");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url))], {
      cwd: root, stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root,
        XDG_RUNTIME_DIR: root, TMPDIR: root, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, "sessions.json"),
        ACP_BRIDGE_LOG: log, PORT: "0", ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
        RESUME_FIXTURE: config, RESUME_TRACE: trace,
        ...(shared ? { ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: path.join(root, "bridge.sock") } : {}) },
    });
    let stderr = "", socket;
    child.stderr.on("data", data => { stderr += data; });
    t.after(async () => {
      socket?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
        await exited; clearTimeout(timer);
      }
      assert.equal(child.signalCode, null, stderr);
      spawnSync("gio", ["trash", root]);
    });
    async function until(condition, label, ms = 5000) {
      const end = Date.now() + ms;
      while (!condition()) { assert(Date.now() < end, `${label}: ${stderr}`); await pause(10); }
    }
    await until(() => fs.existsSync(log) && /LISTENING/.test(fs.readFileSync(log, "utf8")), "bridge startup");
    const endpoint = shared ? `ws+unix://${path.join(root, "bridge.sock") }:/`
      : `ws://127.0.0.1:${fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/)[1]}`;
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    const pending = new Map(), stray = []; let seq = 0;
    socket.on("message", data => {
      const msg = JSON.parse(String(data)), waiter = pending.get(msg.id);
      if (!waiter) { stray.push(msg); return; }
      pending.delete(msg.id); clearTimeout(waiter.timer);
      waiter.resolve(msg);
    });
    const call = (method, params = {}, timeout = 7000) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} fixture deadline`)); }, timeout);
      pending.set(id, { resolve, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    assert.ok((await call("initialize", { clientInfo: { name: "resume_fixture", version: "1" }, capabilities: { experimentalApi: true } })).result);
    const records = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return { call, records, stray, until, close: () => socket.close(),
      write: value => fs.writeFileSync(config, JSON.stringify(value)) };
  }
  const thread = (id, updatedAt, extra = {}) => ({ id, updatedAt, createdAt: updatedAt, recencyAt: updatedAt,
    cwd: "/fixture/work", source: "cli", modelProvider: "openai", preview: "", ...extra });
  const saved = (text, extra = {}) => ({ model: "claude/haiku", turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text }] }] }], ...extra });
  const list = { sortKey: "updated_at", sourceKinds: ["cli", "vscode"], limit: 25 };

  test("81 saved roots are discovered concurrently with a bounded read window", async t => {
    const store = {}, threads = {};
    for (let i = 0; i < 81; i++) {
      store[`legacy-${i}`] = saved(`Saved root ${i}`);
      threads[`legacy-${i}`] = { thread: thread(`legacy-${i}`, i + 1) };
    }
    const native = thread("native", 90, { preview: "Native chat" });
    store.native = saved("Already listed");
    const fixture = await setup(t, { delay: 25, threads, pages: { first: { data: [native], nextCursor: null } } }, store);
    const before = Date.now(), reply = await fixture.call("thread/list", list);
    const elapsed = Date.now() - before;
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.result.data.map(row => row.id), ["native", ...Array.from({ length: 81 }, (_, i) => `legacy-${80 - i}`)]);
    assert.ok(reply.result.data.slice(1).every(row => row.model === "claude/haiku" && row.preview.startsWith("Saved root")));
    const { result: stats } = await fixture.call("fixture/stats");
    assert.ok(stats.maxActive > 1, `serial discovery observed (${elapsed} ms)`);
    assert.ok(stats.maxActive <= 8, `unbounded discovery: ${stats.maxActive} reads`);
    assert.equal(fixture.records().filter(row => row.start).length, 81);
    t.diagnostic(`81 roots: ${elapsed} ms; peak ${stats.maxActive} concurrent reads`);
  });

  test("discovery preserves filters, stable ordering, pagination, and stale-record handling", async t => {
    const store = {}, threads = {};
    const add = (id, time, extra = {}, options = {}) => {
      store[id] = saved(id.includes("review") ? "" : `keep ${id}`);
      threads[id] = { thread: thread(id, time, extra), ...options };
    };
    add("newer", 110); add("tie-a", 80, {}, { delay: 30 }); add("tie-b", 80); add("boundary", 60); add("older", 40);
    add("elsewhere", 95, { cwd: "/other" }); add("other-provider", 94, { modelProvider: "other" });
    add("noninteractive", 93, { source: "exec" }); add("archived", 92, { path: "/fixture/archived_sessions/a.jsonl" });
    add("native-preview", 91, { preview: "Engine lists this independently" });
    add("review", 85); store.review.turns[0].items = [{ type: "enteredReviewMode", review: "keep review" }];
    store.child = saved("keep child", { parentThreadId: "newer" }); store.empty = { turns: [] };
    store.stale = saved("keep deleted"); store._default = { model: "claude/opus" };
    const top = thread("native-top", 100, { preview: "Native" }), bottom = thread("native-bottom", 60, { preview: "Native" });
    const fixture = await setup(t, { threads, pages: {
      first: { data: [top, bottom], nextCursor: "second" }, second: { data: [], nextCursor: null }, unknown: { data: [], nextCursor: null },
    } }, store);
    const request = { ...list, cwd: ["/fixture/work"], modelProviders: ["openai"], searchTerm: "keep" };
    const first = await fixture.call("thread/list", request);
    assert.deepEqual(first.result.data.map(row => row.id), ["newer", "native-top", "review", "tie-a", "tie-b", "native-bottom", "boundary"]);
    assert.equal(first.result.nextCursor, "second");
    const second = await fixture.call("thread/list", { ...request, cursor: "second" });
    assert.deepEqual(second.result.data.map(row => row.id), ["older"]);
    const before = fixture.records().filter(row => row.start).length;
    assert.deepEqual((await fixture.call("thread/list", { ...request, cursor: "unknown" })).result.data, []);
    assert.equal(fixture.records().filter(row => row.start).length, before);
    assert.ok(!fixture.records().some(row => ["child", "empty", "_default"].includes(row.start)));
    const missingSearch = await fixture.call("thread/list", { ...request, searchTerm: "not-present" });
    assert.deepEqual(missingSearch.result.data.map(row => row.id), ["native-top", "native-bottom"]);
  });

  test("a stalled read fails explicitly, ignores late replies, and releases a shared connection", async t => {
    const data = { threads: {
      stalled: { hang: true }, late: { delay: 5500, thread: thread("late", 2) }, healthy: { thread: thread("healthy", 3) },
    }, pages: { first: { data: [], nextCursor: null } } };
    const fixture = await setup(t, data, { stalled: saved("stalled"), late: saved("late"), healthy: saved("healthy") }, true);
    const before = Date.now(), reply = await fixture.call("thread/list", list);
    assert.ok(reply.error, "must not silently return an incomplete successful list");
    assert.match(reply.error.message, /timed out.*retry/i);
    assert.ok(Date.now() - before < 6500);
    assert.ok(fixture.records().some(row => row.finish === "healthy"), "one stall must not prevent unrelated reads");
    await pause(700);
    assert.ok(!fixture.stray.some(msg => String(msg.id).startsWith("acp-bridge-engine-")), "late internal replies must not leak to the client");
    data.threads.stalled = { thread: thread("stalled", 1) }; data.threads.late.delay = 0;
    fixture.write(data);
    const retried = await fixture.call("thread/list", list);
    assert.deepEqual(retried.result.data.map(row => row.id), ["healthy", "late", "stalled"]);
    fixture.close();
    await fixture.until(() => fixture.records().some(row => row.connection === "close"), "stalled request leaked the shared engine connection");
  });
}
