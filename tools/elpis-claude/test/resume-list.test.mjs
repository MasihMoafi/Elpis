import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';
// Actual bridge, deterministic local engine, isolated state; no provider calls.
// Run: node --test tools/elpis-claude/test/resume-list.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    record({ method: msg.method, params: msg.params });
    let result = {};
    if (msg.method === "thread/resume") {
      const row = fixture().threads[msg.params.threadId];
      result = { thread: { ...row.thread, turns: msg.params.excludeTurns ? [] : (fixture().turns ?? []) }, approvalPolicy: "on-request", model: "gpt-5.5" };
    }
    if (["thread/turns/list", "thread/items/list"].includes(msg.method)) {
      // As the engine answers before a thread's first recorded message (no state row yet).
      const methodError = fixture()[msg.method === "thread/turns/list" ? "turnsError" : "itemsError"];
      if (methodError) return send({ id: msg.id, error: methodError });
      if (fixture().historyError && (!fixture().errorCursor || msg.params?.cursor === fixture().errorCursor)) return send({ id: msg.id, error: { code: -32600, message: fixture().historyError, data: { native: true } } });
      let data = fixture()[msg.method === "thread/turns/list" ? "turns" : "items"] ?? [];
      const field = msg.method === "thread/turns/list" ? "startedAt" : "startedAtMs";
      data = [...data].sort((a,b)=>(a[field]??0)-(b[field]??0));
      if ((msg.params.sortDirection ?? "desc") === "desc") data.reverse();
      const offset = Number(msg.params.cursor?.split(":")[1] ?? 0);
      const limit = msg.params.limit ?? 25;
      const page = data.slice(offset,offset+limit).map(row=>{
        if (msg.method === "thread/items/list" || msg.params.itemsView === "full") return row;
        return {...row,itemsView:msg.params.itemsView ?? "summary",items:msg.params.itemsView === "notLoaded" ? [] : (row.items??[]).filter(item=>["userMessage","agentMessage"].includes(item.type))};
      });
      result = {data:page,nextCursor:offset+limit<data.length ? `native:${offset+limit}` : null,backwardsCursor:null};
    }
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
  async function setup(t, fixture, store, shared = false, maxPayload = 8 * 1024 * 1024) {
    const root = createTestTempDir(path.join(os.tmpdir(), "elpis-resume-list-"));
    const config = path.join(root, "fixture.json"), trace = path.join(root, "trace.jsonl");
    fs.writeFileSync(config, JSON.stringify(fixture)); fs.writeFileSync(trace, "");
    fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify(store));
    const engine = path.join(root, "engine");
    fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(self)};\n`, { mode: 0o755 });
    const log = path.join(root, "bridge.log");
    const child = spawn(process.execPath, [process.env.ELPIS_RESUME_TEST_ADAPTER ?? fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url))], {
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
      removeTestTempDir(root);
    });
    async function until(condition, label, ms = 5000) {
      const end = Date.now() + ms;
      while (!condition()) { assert(Date.now() < end, `${label}: ${stderr}`); await pause(10); }
    }
    await until(() => fs.existsSync(log) && /LISTENING/.test(fs.readFileSync(log, "utf8")), "bridge startup");
    const endpoint = shared ? `ws+unix://${path.join(root, "bridge.sock") }:/`
      : `ws://127.0.0.1:${fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/)[1]}`;
    socket = new WebSocket(endpoint, { maxPayload });
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

  test("lightweight provider resume excludes history and independently pages summary turns", async t => {
    const turns = Array.from({length:12},(_,i)=>({id:`stored-${i}`,startedAt:i+2,status:"completed",items:[{id:`u-${i}`,type:"userMessage",content:[{type:"text",text:`User ${i}`}]},{id:`tool-${i}`,type:"commandExecution",aggregatedOutput:"x".repeat(700000)},{id:`a-${i}`,type:"agentMessage",text:`Answer ${i}`}]}));
    const native={id:"native",startedAt:1,status:"completed",items:[{id:"native-answer",type:"agentMessage",text:"Native answer"}]};
    const fixture=await setup(t,{threads:{chat:{thread:thread("chat",20)}},turns:[native],pages:{}},{chat:{model:"claude/haiku",turns}});
    await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true});
    const response=await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true,initialTurnsPage:{limit:1,sortDirection:"desc",itemsView:"summary"}});
    assert.equal(response.result.thread.turns.length,0);
    assert.equal(response.result.initialTurnsPage.data.length,1);
    assert.equal(response.result.initialTurnsPage.data[0].id,"stored-11");
    assert.deepEqual(response.result.initialTurnsPage.data[0].items.map(row=>row.type),["userMessage","agentMessage"]);
    const summaryBytes = Buffer.byteLength(JSON.stringify(response));
    assert.ok(summaryBytes < 10000);
    let cursor, total = 0, maxPageBytes = 0;
    const allItems = [];
    do {
      const page = await fixture.call("thread/items/list", { threadId: "chat", limit: 30, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
      assert.ifError(page.error);
      const bytes = Buffer.byteLength(JSON.stringify(page));
      assert.ok(bytes < 8 * 1024 * 1024);
      maxPageBytes = Math.max(maxPageBytes, bytes);
      allItems.push(...page.result.data);
      total += page.result.data.length;
      cursor = page.result.nextCursor;
    } while(cursor);
    assert.equal(total, 36);
    assert.equal(new Set(allItems.map(row => row.item.id)).size, 36);
    assert.equal(allItems.filter(row => row.item.type === "commandExecution").reduce((sum,row)=>sum+row.item.aggregatedOutput.length,0),8400000);
    t.diagnostic(`stored tool bytes=8400000; summary resume bytes=${summaryBytes}; max full-items limit30 page bytes=${maxPageBytes}`);
    const reads=fixture.records().filter(row=>row.method==="thread/turns/list");
    assert(reads.every(row=>row.params.itemsView!=="full"));
    const noPage=await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true});
    assert.deepEqual(noPage.result.thread.turns,[]);
    assert.equal(noPage.result.initialTurnsPage,null);
  });

  test("provider turn and item pages honor bounds and continue stored/native records without duplicates",async t=>{
    const stored=Array.from({length:7},(_,i)=>({id:`stored-${i}`,startedAt:i*2+2,status:"completed",items:[{id:`item-${i}`,type:"agentMessage",text:`Answer ${i}`}]}));
    const native=Array.from({length:6},(_,i)=>({id:`native-${i}`,startedAt:i*2+1,status:"completed",items:[{id:`native-item-${i}`,type:"agentMessage",text:`Native ${i}`}]}));
    const items=native.map(row=>({turnId:row.id,item:row.items[0],startedAtMs:row.startedAt*1000,completedAtMs:row.startedAt*1000}));
    const fixture=await setup(t,{threads:{chat:{thread:thread("chat",20)}},turns:native,items,pages:{}},{chat:{model:"agy/gemini",turns:stored}});
    await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true});
    for(const [method,view] of [["thread/turns/list",{itemsView:"summary"}],["thread/items/list",{}]]){
      const rows=[];let cursor=null;
      do {
        const reply=await fixture.call(method,{threadId:"chat",limit:2,sortDirection:"desc",cursor,...view});
        assert.equal(reply.error,undefined);
        assert(reply.result.data.length<=2,"Stored history must honor page size");
        rows.push(...reply.result.data);cursor=reply.result.nextCursor;
      } while(cursor);
      const ids=rows.map(row=>row.item?.id??row.id);
      assert.equal(rows.length,13);assert.equal(new Set(ids).size,13);
      const times=rows.map(row=>row.startedAtMs??row.startedAt);
      assert.deepEqual(times,[...times].sort((a,b)=>b-a));
    }
  });

  test("provider history preserves full TUI resume, cursor bindings and native failures", async t => {
    const tid = "options-root";
    const turns = Array.from({ length: 4 }, (_, i) => ({ id: `same-${i}`, status: "completed", startedAt: 10, items: [{ id: `tool-${i}`, type: "commandExecution", aggregatedOutput: "kept for full TUI" }] }));
    const state = { threads: { [tid]: { thread: thread(tid, 1) } }, turns: [{ id: "native", startedAt: 3, status: "completed", items: [] }] };
    const fixture = await setup(t, state, { [tid]: { model: "claude/haiku", turns }, other: { model: "claude/haiku", turns: [] } }, false, 100 * 1024 * 1024);
    const full = await fixture.call("thread/resume", { threadId: tid });
    assert.equal(full.result.thread.turns.length, 5);
    assert.equal(full.result.thread.turns.find(turn => turn.id === "same-0").items[0].aggregatedOutput, "kept for full TUI");
    const p = { threadId: tid, limit: 2, sortDirection: "desc", itemsView: "summary" };
    const first = (await fixture.call("thread/turns/list", p)).result;
    assert.deepEqual(first.data.map(turn => turn.id), ["same-3", "same-2"]);
    const second = (await fixture.call("thread/turns/list", { ...p, cursor: first.nextCursor })).result;
    assert.deepEqual(second.data.map(turn => turn.id), ["same-1", "same-0"]);
    const backwards = (await fixture.call("thread/turns/list", { ...p, sortDirection: "asc", cursor: second.backwardsCursor })).result;
    assert.deepEqual(backwards.data.map(turn => turn.id), ["same-1", "same-2"]);
    for (const changes of [{ threadId: "other" }, { itemsView: "full" }, { sortDirection: "asc" }]) {
      const invalid = await fixture.call("thread/turns/list", { ...p, ...changes, cursor: first.nextCursor });
      assert.match(invalid.error.message, /mismatched/);
    }
    assert.match((await fixture.call("thread/items/list", { threadId: tid, cursor: first.nextCursor })).error.message, /mismatched/);
    assert.match((await fixture.call("thread/turns/list", { ...p, cursor: "acp-page:broken" })).error.message, /mismatched/);
    fixture.write({ ...state, historyError: "permission denied reading native history" });
    for (const [method, params] of [["thread/turns/list", p], ["thread/items/list", { threadId: tid }], ["thread/resume", { threadId: tid, excludeTurns: true, initialTurnsPage: { limit: 1 } }]]) {
      const failed = await fixture.call(method, params);
      assert.equal(failed.error.code, -32600);
      assert.deepEqual(failed.error.data, { native: true });
      assert.match(failed.error.message, /permission denied/);
    }
    const metadata = await fixture.call("thread/resume", { threadId: tid, excludeTurns: true });
    assert.equal(metadata.result.thread.turns.length, 0);
    assert.equal(metadata.result.initialTurnsPage, null);
  });

  test("provider pages retain native wire ties, changed page sizes and continuation errors", async t => {
    const tid = "many-native";
    const ids = ["z", "a", "y", "b", "x", "c", "w"];
    const turns = ids.map(id => ({ id, startedAt: 5, status: "completed", items: [] }));
    const state = { threads: { [tid]: { thread: thread(tid, 1) } }, turns };
    const fixture = await setup(t, state, { [tid]: { model: "agy/gemini", turns: [{ id: "stored", startedAt: 5, status: "completed", items: [] }] } });
    const p = { threadId: tid, limit: 3, sortDirection: "desc", itemsView: "notLoaded" };
    let cursor, all = [], pages = [];
    do {
      const reply = await fixture.call("thread/turns/list", { ...p, limit: cursor ? 1 : 3, ...(cursor ? { cursor } : {}) });
      assert.ifError(reply.error); assert.ok(reply.result.data.length <= (cursor ? 1 : 3));
      pages.push(reply.result); all.push(...reply.result.data); cursor = reply.result.nextCursor;
    } while(cursor);
    assert.deepEqual(all.map(turn => turn.id), ["stored", ...ids.toReversed()]);
    assert.equal(new Set(all.map(turn => turn.id)).size, 8);
    const back = await fixture.call("thread/turns/list", { ...p, sortDirection: "asc", cursor: pages[2].backwardsCursor });
    assert.deepEqual(back.result.data.map(turn => turn.id), ["b", "x", "c"]);
    assert.ok(fixture.records().filter(row=>row.method==="thread/turns/list").every(row=>row.params.limit<=3));
    const first = await fixture.call("thread/turns/list", p);
    fixture.write({ ...state, historyError: "native continuation failed", errorCursor: "native:3" });
    const continuation = await fixture.call("thread/turns/list", { ...p, cursor: first.result.nextCursor });
    assert.equal(continuation.error.code, -32600); assert.match(continuation.error.message, /native continuation failed/);
  });

  test("oversized individual items fail explicitly and bridge-only children page without native hydration", async t => {
    const childId = "stored-child";
    const childTurns = Array.from({ length: 3 }, (_, i) => ({ id: `child-turn-${i}`, startedAt: i, status: "completed", items: [{ id: `child-item-${i}`, type: "agentMessage", text: `Child answer ${i}` }] }));
    const fixture = await setup(t, { threads: {}, historyError: "native history must not be read for bridge-only child" }, { [childId]: { parentThreadId: "parent", rootThreadId: "parent", thread: thread(childId, 1, { parentThreadId: "parent" }), turns: childTurns }, huge: { model: "claude/haiku", turns: [{ id: "huge-turn", startedAt: 1, items: [{ id: "huge-item", type: "commandExecution", aggregatedOutput: "x".repeat(9 * 1024 * 1024) }] }] } });
    const first = await fixture.call("thread/turns/list", { threadId: childId, limit: 1, itemsView: "summary" });
    assert.equal(first.result.data[0].id, "child-turn-2");
    const second = await fixture.call("thread/turns/list", { threadId: childId, limit: 1, itemsView: "summary", cursor: first.result.nextCursor });
    assert.equal(second.result.data[0].id, "child-turn-1");
    assert.equal((await fixture.call("thread/items/list", { threadId: childId, limit: 2 })).result.data.length, 2);
    assert.equal(fixture.records().filter(row => ["thread/turns/list", "thread/items/list"].includes(row.method)).length, 0);
    fixture.write({ threads: {}, turns: [], items: [] });
    const oversized = await fixture.call("thread/items/list", { threadId: "huge", limit: 30 });
    assert.match(oversized.error.message, /huge-item exceeds.*not truncated/);
    assert.equal((await fixture.call("thread/turns/list", { threadId: "huge", limit: 1, itemsView: "notLoaded" })).result.data.length, 1);
  });

  test("a delegated helper's start tells the engine the calling chat is its parent", async t => {
    const fixture = await setup(t, { threads: {}, pages: { first: { data: [], nextCursor: null } } }, {});
    await fixture.call("thread/start", { cwd: "/fixture/work", model: "gpt-5.5", sandbox: "read-only", elpisParentThreadId: "calling-chat" });
    const starts = fixture.records().filter(row => row.method === "thread/start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.parentThreadId, "calling-chat");
    assert.equal(starts[0].params.elpisParentThreadId, undefined);
    await fixture.call("thread/start", { cwd: "/fixture/work", model: "gpt-5.5" });
    assert.equal(fixture.records().filter(row => row.method === "thread/start")[1].params.parentThreadId, undefined, "a chat the person starts has no parent");
  });

  test("a chat's helpers list as its live descendants, never as archived ones", async t => {
    const helper = thread("helper", 2, { source: "vscode" });
    const store = { _delegations: { helper: { parentThreadId: "chat", model: "gpt-5.5" } },
      child: { parentThreadId: "chat", rootThreadId: "chat", thread: thread("child", 1, { parentThreadId: "chat" }), turns: [] } };
    const fixture = await setup(t, { threads: { helper: { thread: helper } }, pages: { first: { data: [], nextCursor: null } } }, store);
    const params = { ancestorThreadId: "chat", sourceKinds: ["subAgentThreadSpawn"], modelProviders: [], limit: 100, useStateDbOnly: true };
    const live = (await fixture.call("thread/list", { ...params, archived: false })).result.data;
    assert.deepEqual(live.map(row => [row.id, row.parentThreadId]).sort(), [["child", "chat"], ["helper", "chat"]]);
    assert.deepEqual((await fixture.call("thread/list", { ...params, archived: true })).result.data, []);
  });

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

  test("a provider chat reads its items before the engine has recorded its first message", async t => {
    // The engine's answers for a thread with no state row yet: items are "not supported", turns "not materialized".
    const unrecorded = { itemsError: { code: -32601, message: "thread/items/list is not supported yet" },
      turnsError: { code: -32600, message: "thread fresh is not materialized yet; thread/turns/list is unavailable before first user message" } };
    const stored = [{ id: "first", startedAt: 5, status: "interrupted", items: [{ id: "ask", type: "userMessage", content: [{ type: "text", text: "Hi" }] }, { id: "reply", type: "agentMessage", text: "Working" }] }];
    const state = { threads: { fresh: { thread: thread("fresh", 5) }, empty: { thread: thread("empty", 5) } }, pages: {}, ...unrecorded };
    const fixture = await setup(t, state, { fresh: { model: "agy/gemini", turns: stored }, empty: { model: "agy/gemini" } });
    const items = await fixture.call("thread/items/list", { threadId: "fresh", limit: 30, sortDirection: "desc" });
    assert.equal(items.error, undefined, JSON.stringify(items.error));
    assert.deepEqual(items.result.data.map(row => row.item.id), ["reply", "ask"]);
    const none = await fixture.call("thread/items/list", { threadId: "empty", limit: 30, sortDirection: "desc" });
    assert.equal(none.error, undefined, JSON.stringify(none.error));
    assert.deepEqual(none.result.data, []);
    // A recorded thread whose items the engine truly cannot list keeps the engine's own answer.
    fixture.write({ ...state, turnsError: undefined, turns: [] });
    const refused = await fixture.call("thread/items/list", { threadId: "fresh", limit: 30, sortDirection: "desc" });
    assert.equal(refused.error?.code, -32601);
    assert.match(refused.error.message, /thread\/items\/list is not supported yet/);
  });
}
