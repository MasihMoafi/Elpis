import { createTestTempDir, removeTestTempDir } from './temp-root.mts';
// Actual bridge, deterministic local engine, isolated state; no provider calls.
// Run: node --test tools/elpis-claude/test/resume-list.test.mts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

type TestError = { code: number; message: string; data?: unknown };
type Item = { id: string; type: string; aggregatedOutput?: string };
type Turn = { id: string; startedAt?: number; items: Item[] };
type ItemRow = { item: Item; startedAtMs: number };
type ListRow = { id: string; model?: string; preview?: string; parentThreadId?: string };
type Page<T> = { data: T[]; nextCursor: string | null; backwardsCursor?: string | null };
type ResumeResult = { thread: { turns: Turn[] }; initialTurnsPage: Page<Turn> | null };
type Results = { "initialize": object; "thread/start": object; "thread/resume": ResumeResult; "thread/list": Page<ListRow>; "thread/items/list": Page<ItemRow>; "thread/turns/list": Page<Turn>; "fixture/stats": { active: number; maxActive: number } };
type Reply<T> = { id?: number | string; result?: T; error?: TestError };
type Trace = { method?: string; start?: string; finish?: string; connection?: string; params?: { itemsView?: string; limit?: number; parentThreadId?: string; elpisParentThreadId?: string } };
type HistoryRow = { startedAt?: number; startedAtMs?: number; items?: { type: string }[]; [key: string]: unknown };
type SavedRow = { model?: string; turns?: { items: { type: string; content?: { type: string; text: string }[]; review?: string }[] }[]; parentThreadId?: string };
type Fixture = { approvalPolicy?: unknown; threads: Record<string, { thread?: object; hang?: boolean; delay?: number; error?: TestError }>; pages?: Record<string, unknown>; turns?: HistoryRow[]; items?: HistoryRow[]; delay?: number; historyError?: string; errorCursor?: string; turnsError?: TestError; itemsError?: TestError };
type Request = { id?: string | number; method?: string; params?: { threadId?: string; excludeTurns?: boolean; includeTurns?: boolean; cursor?: string; sortDirection?: string; limit?: number; itemsView?: string } };

const resultOf = <T,>(reply: Reply<T>): T => { assert.ok(reply.result !== undefined, JSON.stringify(reply.error)); return reply.result; };
const errorOf = <T,>(reply: Reply<T>): TestError => { assert.ok(reply.error); return reply.error; };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const self = fileURLToPath(import.meta.url);

if (process.argv.includes("app-server")) {
  const fixtureFile = process.env.RESUME_FIXTURE, traceFile = process.env.RESUME_TRACE;
  assert.ok(fixtureFile !== undefined && traceFile !== undefined);
  const fixture = (): Fixture => JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const record = (event: object) => fs.appendFileSync(traceFile, JSON.stringify(event) + "\n");
  let active = 0, maxActive = 0;
  const handle = async (msg: Request, send: (message: object) => void) => {
    if (msg.id === undefined) return;
    record({ method: msg.method, params: msg.params });
    const p = msg.params ?? {};
    let result: unknown = {};
    if (msg.method === "thread/resume") {
      assert.ok(p.threadId !== undefined);
      const row = fixture().threads[p.threadId]; assert.ok(row);
      result = { thread: { ...row.thread, turns: p.excludeTurns ? [] : (fixture().turns ?? []) }, approvalPolicy: fixture().approvalPolicy ?? "on-request", model: "gpt-5.5" };
    }
    if (["thread/turns/list", "thread/items/list"].includes(msg.method ?? "")) {
      // As the engine answers before a thread's first recorded message (no state row yet).
      const methodError = fixture()[msg.method === "thread/turns/list" ? "turnsError" : "itemsError"];
      if (methodError) return send({ id: msg.id, error: methodError });
      if (fixture().historyError && (!fixture().errorCursor || p.cursor === fixture().errorCursor)) return send({ id: msg.id, error: { code: -32600, message: fixture().historyError, data: { native: true } } });
      let data = fixture()[msg.method === "thread/turns/list" ? "turns" : "items"] ?? [];
      const field = msg.method === "thread/turns/list" ? "startedAt" : "startedAtMs";
      data = [...data].sort((a,b)=>(a[field]??0)-(b[field]??0));
      if ((p.sortDirection ?? "desc") === "desc") data.reverse();
      const offset = Number(p.cursor?.split(":")[1] ?? 0);
      const limit = p.limit ?? 25;
      const page = data.slice(offset,offset+limit).map(row=>{
        if (msg.method === "thread/items/list" || p.itemsView === "full") return row;
        return {...row,itemsView:p.itemsView ?? "summary",items:p.itemsView === "notLoaded" ? [] : (row.items??[]).filter(item=>["userMessage","agentMessage"].includes(item.type))};
      });
      result = {data:page,nextCursor:offset+limit<data.length ? `native:${offset+limit}` : null,backwardsCursor:null};
    }
    if (msg.method === "thread/list") { const pages = fixture().pages; assert.ok(pages); result = pages[p.cursor ?? "first"]; }
    if (msg.method === "thread/read") {
      assert.equal(p.includeTurns, false);
      const { threadId } = p; assert.ok(threadId !== undefined);
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
    const endpoint = process.argv[listenAt + 1]; assert.ok(endpoint !== undefined);
    server.listen(endpoint.replace(/^unix:\/\//, ""));
  } else {
    readline.createInterface({ input: process.stdin }).on("line", line => {
      handle(JSON.parse(line), msg => process.stdout.write(JSON.stringify(msg) + "\n"));
    });
  }
} else {
  async function setup(t: TestContext, fixture: object, store: object, shared = false, maxPayload = 8 * 1024 * 1024) {
    const root = createTestTempDir(path.join(os.tmpdir(), "elpis-resume-list-"));
    const config = path.join(root, "fixture.json"), trace = path.join(root, "trace.jsonl");
    fs.writeFileSync(config, JSON.stringify(fixture)); fs.writeFileSync(trace, "");
    fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify(store));
    const engine = path.join(root, "engine");
    fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(self)};\n`, { mode: 0o755 });
    const log = path.join(root, "bridge.log");
    const child = spawn(process.execPath, [process.env.ELPIS_RESUME_TEST_ADAPTER ?? fileURLToPath(new URL("../acp-bridge.mts", import.meta.url))], {
      cwd: root, stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root,
        XDG_RUNTIME_DIR: root, TMPDIR: root, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, "sessions.json"),
        ACP_BRIDGE_LOG: log, PORT: "0", ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
        RESUME_FIXTURE: config, RESUME_TRACE: trace,
        ...(shared ? { ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: path.join(root, "bridge.sock") } : {}) },
    });
    let stderr = "", socket: WebSocket | undefined;
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
    async function until(condition: () => unknown, label: string, ms = 5000) {
      const end = Date.now() + ms;
      while (!condition()) { assert(Date.now() < end, `${label}: ${stderr}`); await pause(10); }
    }
    await until(() => fs.existsSync(log) && /LISTENING/.test(fs.readFileSync(log, "utf8")), "bridge startup");
    const match = shared ? null : fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/);
    if (!shared) assert.ok(match?.[1]);
    const endpoint = shared ? `ws+unix://${path.join(root, "bridge.sock") }:/` : `ws://127.0.0.1:${match?.[1]}`;
    const connection = socket = new WebSocket(endpoint, { maxPayload });
    await once(connection, "open");
    const pending = new Map<number, { resolve: (reply: Reply<unknown>) => void; timer: NodeJS.Timeout }>(), stray: { id?: string | number }[] = []; let seq = 0;
    connection.on("message", data => {
      const msg: Reply<unknown> = JSON.parse(String(data));
      const waiter = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!waiter || typeof msg.id !== "number") { stray.push(msg); return; }
      pending.delete(msg.id); clearTimeout(waiter.timer);
      waiter.resolve(msg);
    });
    const call = <M extends keyof Results,>(method: M, params: object = {}, timeout = 7000): Promise<Reply<Results[M]>> => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} fixture deadline`)); }, timeout);
      pending.set(id, { resolve: reply => resolve(reply as Reply<Results[M]>), timer }); connection.send(JSON.stringify({ id, method, params }));
    });
    assert.ok(resultOf(await call("initialize", { clientInfo: { name: "resume_fixture", version: "1" }, capabilities: { experimentalApi: true } })));
    const records = (): Trace[] => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { call, records, stray, until, close: () => connection.close(),
      write: (value: object) => fs.writeFileSync(config, JSON.stringify(value)) };
  }
  const thread = (id: string, updatedAt: number, extra: object = {}) => ({ id, updatedAt, createdAt: updatedAt, recencyAt: updatedAt,
    cwd: "/fixture/work", source: "cli", modelProvider: "openai", preview: "", ...extra });
  const saved = (text: string, extra: object = {}) => ({ model: "claude/haiku", turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text }] }] }], ...extra });
  const list = { sortKey: "updated_at", sourceKinds: ["cli", "vscode"], limit: 25 };

  test("native granular approval policies retain provider routing and validate internal replies", async t => {
    const { readClientRequest } = await import('../bridge-client-protocol.mts');
    const { validEngineReply, isEngineMessage } = await import('../bridge-engine-protocol.mts');
    const policy = { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: false, mcp_elicitations: true } } satisfies import('../../../codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts').AskForApproval;
    for (const approvalPolicy of ['untrusted', 'on-request', 'never', policy]) {
      assert.ok(readClientRequest({ id: 1, method: 'thread/resume', params: { threadId: 'chat', approvalPolicy } }));
      assert.ok(validEngineReply('thread/resume', { thread: { id: 'chat' }, approvalPolicy }));
      assert.ok(isEngineMessage({ id: 1, result: { thread: { id: 'chat' }, approvalPolicy } }));
    }
    for (const approvalPolicy of [{ granular: {} }, { granular: { ...policy.granular, rules: 'yes' } }, 'unknown']) {
      assert.equal(readClientRequest({ id: 1, method: 'thread/resume', params: { threadId: 'chat', approvalPolicy } }), null);
      assert.equal(validEngineReply('thread/resume', { thread: { id: 'chat' }, approvalPolicy }), false);
    }
    const f = await setup(t, { approvalPolicy: policy, threads: { chat: { thread: thread('chat', 1) } } }, { chat: saved('Provider history') });
    const response = resultOf(await f.call('thread/resume', { threadId: 'chat', approvalPolicy: policy }));
    assert.ok(JSON.stringify(response.thread.turns).includes('Provider history'), 'the provider route must merge its durable chat history');
  });

  test("fallback history keeps delegated provider chats under their parent", async t => {
    const parent = thread("parent", 10, { preview: "Project owner" });
    const helper = thread("helper", 30);
    const ordinary = thread("ordinary", 20);
    const fixture = await setup(t, {
      threads: { parent: { thread: parent }, helper: { thread: helper }, ordinary: { thread: ordinary } },
      pages: { first: { data: [parent], nextCursor: null } },
    }, {
      helper: saved("Read the page", { model: "agy/gemini" }), ordinary: saved("My own chat"),
      _delegations: { helper: { parentThreadId: "parent", model: "agy/gemini" } },
    });
    const response = await fixture.call("thread/list", list);
    assert.ifError(response.error);
    assert.deepEqual(response.result.data.map(row => row.id), ["helper", "ordinary", "parent"]);
    assert.equal(response.result.data[0].parentThreadId, "parent", "fallback additions carry the recorded parent");
    assert.equal(response.result.data[0].model, "agy/gemini");
    assert.equal(response.result.data[1].parentThreadId, undefined, "a person's own chat remains independent");
  });

  test("lightweight provider resume excludes history and independently pages summary turns", async t => {
    const turns = Array.from({length:12},(_,i)=>({id:`stored-${i}`,startedAt:i+2,status:"completed",items:[{id:`u-${i}`,type:"userMessage",content:[{type:"text",text:`User ${i}`}]},{id:`tool-${i}`,type:"commandExecution",aggregatedOutput:"x".repeat(700000)},{id:`a-${i}`,type:"agentMessage",text:`Answer ${i}`}]}));
    const native={id:"native",startedAt:1,status:"completed",items:[{id:"native-answer",type:"agentMessage",text:"Native answer"}]};
    const fixture=await setup(t,{threads:{chat:{thread:thread("chat",20)}},turns:[native],pages:{}},{chat:{model:"claude/haiku",turns}});
    await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true});
    const responseWire=await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true,initialTurnsPage:{limit:1,sortDirection:"desc",itemsView:"summary"}});
    const response=resultOf(responseWire);
    assert.equal(response.thread.turns.length,0);
    assert.ok(response.initialTurnsPage);
    assert.equal(response.initialTurnsPage.data.length,1);
    const firstTurn = response.initialTurnsPage.data[0]; assert.ok(firstTurn);
    assert.equal(firstTurn.id,"stored-11");
    assert.deepEqual(firstTurn.items.map(row=>row.type),["userMessage","agentMessage"]);
    const summaryBytes = Buffer.byteLength(JSON.stringify(responseWire));
    assert.ok(summaryBytes < 10000);
    let cursor: string | null | undefined, total = 0, maxPageBytes = 0;
    const allItems: ItemRow[] = [];
    do {
      const page: Reply<Page<ItemRow>> = await fixture.call("thread/items/list", { threadId: "chat", limit: 30, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
      assert.ifError(page.error);
      const bytes = Buffer.byteLength(JSON.stringify(page));
      assert.ok(bytes < 8 * 1024 * 1024);
      maxPageBytes = Math.max(maxPageBytes, bytes);
      const result: Page<ItemRow> = resultOf(page);
      allItems.push(...result.data);
      total += result.data.length;
      cursor = result.nextCursor;
    } while(cursor);
    assert.equal(total, 36);
    assert.equal(new Set(allItems.map(row => row.item.id)).size, 36);
    assert.equal(allItems.filter(row => row.item.type === "commandExecution").reduce((sum,row)=>{ assert.ok(row.item.aggregatedOutput !== undefined); return sum+row.item.aggregatedOutput.length; },0),8400000);
    t.diagnostic(`stored tool bytes=8400000; summary resume bytes=${summaryBytes}; max full-items limit30 page bytes=${maxPageBytes}`);
    const reads=fixture.records().filter(row=>row.method==="thread/turns/list");
    assert(reads.every(row=>row.params && row.params.itemsView!=="full"));
    const noPage=resultOf(await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true}));
    assert.deepEqual(noPage.thread.turns,[]);
    assert.equal(noPage.initialTurnsPage,null);
  });

  test("provider turn and item pages honor bounds and continue stored/native records without duplicates",async t=>{
    const stored=Array.from({length:7},(_,i)=>({id:`stored-${i}`,startedAt:i*2+2,status:"completed",items:[{id:`item-${i}`,type:"agentMessage",text:`Answer ${i}`}]}));
    const native=Array.from({length:6},(_,i)=>({id:`native-${i}`,startedAt:i*2+1,status:"completed",items:[{id:`native-item-${i}`,type:"agentMessage",text:`Native ${i}`}]}));
    const items=native.map(row=>({turnId:row.id,item:row.items[0],startedAtMs:row.startedAt*1000,completedAtMs:row.startedAt*1000}));
    const fixture=await setup(t,{threads:{chat:{thread:thread("chat",20)}},turns:native,items,pages:{}},{chat:{model:"agy/gemini",turns:stored}});
    await fixture.call("thread/resume",{threadId:"chat",excludeTurns:true});
    for(const [method,view] of [["thread/turns/list",{itemsView:"summary"}],["thread/items/list",{}]] as const){
      const rows: (Turn | ItemRow)[]=[];let cursor: string | null=null;
      do {
        const reply: Reply<Page<Turn> | Page<ItemRow>>=await fixture.call(method,{threadId:"chat",limit:2,sortDirection:"desc",cursor,...view});
        assert.equal(reply.error,undefined);
        const page: Page<Turn> | Page<ItemRow> = resultOf(reply);
        assert(page.data.length<=2,"Stored history must honor page size");
        rows.push(...page.data);cursor=page.nextCursor;
      } while(cursor);
      const ids=rows.map(row=>"item" in row ? row.item.id : row.id);
      assert.equal(rows.length,13);assert.equal(new Set(ids).size,13);
      const times=rows.map(row=>{ const time = "item" in row ? row.startedAtMs : row.startedAt; assert.ok(time !== undefined); return time; });
      assert.deepEqual(times,[...times].sort((a,b)=>b-a));
    }
  });

  test("provider history preserves full TUI resume, cursor bindings and native failures", async t => {
    const tid = "options-root";
    const turns = Array.from({ length: 4 }, (_, i) => ({ id: `same-${i}`, status: "completed", startedAt: 10, items: [{ id: `tool-${i}`, type: "commandExecution", aggregatedOutput: "kept for full TUI" }] }));
    const state = { threads: { [tid]: { thread: thread(tid, 1) } }, turns: [{ id: "native", startedAt: 3, status: "completed", items: [] }] };
    const fixture = await setup(t, state, { [tid]: { model: "claude/haiku", turns }, other: { model: "claude/haiku", turns: [] } }, false, 100 * 1024 * 1024);
    const full = resultOf(await fixture.call("thread/resume", { threadId: tid }));
    assert.equal(full.thread.turns.length, 5);
    assert.equal(full.thread.turns.find(turn => turn.id === "same-0")?.items[0]?.aggregatedOutput, "kept for full TUI");
    const p = { threadId: tid, limit: 2, sortDirection: "desc", itemsView: "summary" };
    const first = resultOf(await fixture.call("thread/turns/list", p));
    assert.deepEqual(first.data.map(turn => turn.id), ["same-3", "same-2"]);
    const second = resultOf(await fixture.call("thread/turns/list", { ...p, cursor: first.nextCursor }));
    assert.deepEqual(second.data.map(turn => turn.id), ["same-1", "same-0"]);
    const backwards = resultOf(await fixture.call("thread/turns/list", { ...p, sortDirection: "asc", cursor: second.backwardsCursor }));
    assert.deepEqual(backwards.data.map(turn => turn.id), ["same-1", "same-2"]);
    for (const changes of [{ threadId: "other" }, { itemsView: "full" }, { sortDirection: "asc" }]) {
      const invalid = await fixture.call("thread/turns/list", { ...p, ...changes, cursor: first.nextCursor });
      assert.match(errorOf(invalid).message, /mismatched/);
    }
    assert.match(errorOf(await fixture.call("thread/items/list", { threadId: tid, cursor: first.nextCursor })).message, /mismatched/);
    assert.match(errorOf(await fixture.call("thread/turns/list", { ...p, cursor: "acp-page:broken" })).message, /mismatched/);
    fixture.write({ ...state, historyError: "permission denied reading native history" });
    for (const [method, params] of [["thread/turns/list", p], ["thread/items/list", { threadId: tid }], ["thread/resume", { threadId: tid, excludeTurns: true, initialTurnsPage: { limit: 1 } }]] as const) {
      const failed = await fixture.call(method, params);
      const error = errorOf(failed);
      assert.equal(error.code, -32600);
      assert.deepEqual(error.data, { native: true });
      assert.match(error.message, /permission denied/);
    }
    const metadata = resultOf(await fixture.call("thread/resume", { threadId: tid, excludeTurns: true }));
    assert.equal(metadata.thread.turns.length, 0);
    assert.equal(metadata.initialTurnsPage, null);
  });

  test("provider pages retain native wire ties, changed page sizes and continuation errors", async t => {
    const tid = "many-native";
    const ids = ["z", "a", "y", "b", "x", "c", "w"];
    const turns = ids.map(id => ({ id, startedAt: 5, status: "completed", items: [] }));
    const state = { threads: { [tid]: { thread: thread(tid, 1) } }, turns };
    const fixture = await setup(t, state, { [tid]: { model: "agy/gemini", turns: [{ id: "stored", startedAt: 5, status: "completed", items: [] }] } });
    const p = { threadId: tid, limit: 3, sortDirection: "desc", itemsView: "notLoaded" };
    let cursor: string | null | undefined, all: Turn[] = [], pages: Page<Turn>[] = [];
    do {
      const reply = await fixture.call("thread/turns/list", { ...p, limit: cursor ? 1 : 3, ...(cursor ? { cursor } : {}) });
      assert.ifError(reply.error); const result = resultOf(reply); assert.ok(result.data.length <= (cursor ? 1 : 3));
      pages.push(result); all.push(...result.data); cursor = result.nextCursor;
    } while(cursor);
    assert.deepEqual(all.map(turn => turn.id), ["stored", ...ids.toReversed()]);
    assert.equal(new Set(all.map(turn => turn.id)).size, 8);
    const third = pages[2]; assert.ok(third);
    const back = resultOf(await fixture.call("thread/turns/list", { ...p, sortDirection: "asc", cursor: third.backwardsCursor }));
    assert.deepEqual(back.data.map(turn => turn.id), ["b", "x", "c"]);
    assert.ok(fixture.records().filter(row=>row.method==="thread/turns/list").every(row=>row.params?.limit !== undefined && row.params.limit<=3));
    const first = resultOf(await fixture.call("thread/turns/list", p));
    fixture.write({ ...state, historyError: "native continuation failed", errorCursor: "native:3" });
    const continuation = errorOf(await fixture.call("thread/turns/list", { ...p, cursor: first.nextCursor }));
    assert.equal(continuation.code, -32600); assert.match(continuation.message, /native continuation failed/);
  });

  test("oversized individual items fail explicitly and bridge-only children page without native hydration", async t => {
    const childId = "stored-child";
    const childTurns = Array.from({ length: 3 }, (_, i) => ({ id: `child-turn-${i}`, startedAt: i, status: "completed", items: [{ id: `child-item-${i}`, type: "agentMessage", text: `Child answer ${i}` }] }));
    const fixture = await setup(t, { threads: {}, historyError: "native history must not be read for bridge-only child" }, { [childId]: { parentThreadId: "parent", rootThreadId: "parent", thread: thread(childId, 1, { parentThreadId: "parent" }), turns: childTurns }, huge: { model: "claude/haiku", turns: [{ id: "huge-turn", startedAt: 1, items: [{ id: "huge-item", type: "commandExecution", aggregatedOutput: "x".repeat(9 * 1024 * 1024) }] }] } });
    const first = resultOf(await fixture.call("thread/turns/list", { threadId: childId, limit: 1, itemsView: "summary" }));
    assert.equal(first.data[0]?.id, "child-turn-2");
    const second = resultOf(await fixture.call("thread/turns/list", { threadId: childId, limit: 1, itemsView: "summary", cursor: first.nextCursor }));
    assert.equal(second.data[0]?.id, "child-turn-1");
    assert.equal(resultOf(await fixture.call("thread/items/list", { threadId: childId, limit: 2 })).data.length, 2);
    assert.equal(fixture.records().filter(row => ["thread/turns/list", "thread/items/list"].includes(row.method ?? "")).length, 0);
    fixture.write({ threads: {}, turns: [], items: [] });
    const oversized = await fixture.call("thread/items/list", { threadId: "huge", limit: 30 });
    assert.match(errorOf(oversized).message, /huge-item exceeds.*not truncated/);
    assert.equal(resultOf(await fixture.call("thread/turns/list", { threadId: "huge", limit: 1, itemsView: "notLoaded" })).data.length, 1);
  });

  test("a delegated helper's start tells the engine the calling chat is its parent", async t => {
    const fixture = await setup(t, { threads: {}, pages: { first: { data: [], nextCursor: null } } }, {});
    await fixture.call("thread/start", { cwd: "/fixture/work", model: "gpt-5.5", sandbox: "read-only", elpisParentThreadId: "calling-chat" });
    const starts = fixture.records().filter(row => row.method === "thread/start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.params?.parentThreadId, "calling-chat");
    assert.equal(starts[0]?.params?.elpisParentThreadId, undefined);
    await fixture.call("thread/start", { cwd: "/fixture/work", model: "gpt-5.5" });
    const nextStart = fixture.records().filter(row => row.method === "thread/start")[1]; assert.ok(nextStart?.params);
    assert.equal(nextStart.params.parentThreadId, undefined, "a chat the person starts has no parent");
  });

  test("a chat's helpers list as its live descendants, never as archived ones", async t => {
    const helper = thread("helper", 2, { source: "vscode" });
    const store = { _delegations: { helper: { parentThreadId: "chat", model: "gpt-5.5" } },
      child: { parentThreadId: "chat", rootThreadId: "chat", thread: thread("child", 1, { parentThreadId: "chat" }), turns: [] } };
    const fixture = await setup(t, { threads: { helper: { thread: helper } }, pages: { first: { data: [], nextCursor: null } } }, store);
    const params = { ancestorThreadId: "chat", sourceKinds: ["subAgentThreadSpawn"], modelProviders: [], limit: 100, useStateDbOnly: true };
    const live = resultOf(await fixture.call("thread/list", { ...params, archived: false })).data;
    assert.deepEqual(live.map(row => [row.id, row.parentThreadId]).sort(), [["child", "chat"], ["helper", "chat"]]);
    assert.deepEqual(resultOf(await fixture.call("thread/list", { ...params, archived: true })).data, []);
  });

  test("81 saved roots are discovered concurrently with a bounded read window", async t => {
    const store: Record<string, SavedRow> = {}, threads: Record<string, { thread: ReturnType<typeof thread> }> = {};
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
    const result = resultOf(reply);
    assert.deepEqual(result.data.map(row => row.id), ["native", ...Array.from({ length: 81 }, (_, i) => `legacy-${80 - i}`)]);
    assert.ok(result.data.slice(1).every(row => row.model === "claude/haiku" && row.preview?.startsWith("Saved root")));
    const stats = resultOf(await fixture.call("fixture/stats"));
    assert.ok(stats.maxActive > 1, `serial discovery observed (${elapsed} ms)`);
    assert.ok(stats.maxActive <= 8, `unbounded discovery: ${stats.maxActive} reads`);
    assert.equal(fixture.records().filter(row => row.start).length, 81);
    t.diagnostic(`81 roots: ${elapsed} ms; peak ${stats.maxActive} concurrent reads`);
  });

  test("discovery preserves filters, stable ordering, pagination, and stale-record handling", async t => {
    const store: Record<string, SavedRow> = {}, threads: Record<string, { thread: ReturnType<typeof thread>; delay?: number }> = {};
    const add = (id: string, time: number, extra: object = {}, options: { delay?: number } = {}) => {
      store[id] = saved(id.includes("review") ? "" : `keep ${id}`);
      threads[id] = { thread: thread(id, time, extra), ...options };
    };
    add("newer", 110); add("tie-a", 80, {}, { delay: 30 }); add("tie-b", 80); add("boundary", 60); add("older", 40);
    add("elsewhere", 95, { cwd: "/other" }); add("other-provider", 94, { modelProvider: "other" });
    add("noninteractive", 93, { source: "exec" }); add("archived", 92, { path: "/fixture/archived_sessions/a.jsonl" });
    add("native-preview", 91, { preview: "Engine lists this independently" });
    add("review", 85); const review = store.review?.turns?.[0]; assert.ok(review); review.items = [{ type: "enteredReviewMode", review: "keep review" }];
    store.child = saved("keep child", { parentThreadId: "newer" }); store.empty = { turns: [] };
    store.stale = saved("keep deleted"); store._default = { model: "claude/opus" };
    const top = thread("native-top", 100, { preview: "Native" }), bottom = thread("native-bottom", 60, { preview: "Native" });
    const fixture = await setup(t, { threads, pages: {
      first: { data: [top, bottom], nextCursor: "second" }, second: { data: [], nextCursor: null }, unknown: { data: [], nextCursor: null },
    } }, store);
    const request = { ...list, cwd: ["/fixture/work"], modelProviders: ["openai"], searchTerm: "keep" };
    const first = await fixture.call("thread/list", request);
    const firstResult = resultOf(first);
    assert.deepEqual(firstResult.data.map(row => row.id), ["newer", "native-top", "review", "tie-a", "tie-b", "native-bottom", "boundary"]);
    assert.equal(firstResult.nextCursor, "second");
    const second = resultOf(await fixture.call("thread/list", { ...request, cursor: "second" }));
    assert.deepEqual(second.data.map(row => row.id), ["older"]);
    const before = fixture.records().filter(row => row.start).length;
    assert.deepEqual(resultOf(await fixture.call("thread/list", { ...request, cursor: "unknown" })).data, []);
    assert.equal(fixture.records().filter(row => row.start).length, before);
    assert.ok(!fixture.records().some(row => ["child", "empty", "_default"].includes(row.start ?? "")));
    const missingSearch = await fixture.call("thread/list", { ...request, searchTerm: "not-present" });
    assert.deepEqual(resultOf(missingSearch).data.map(row => row.id), ["native-top", "native-bottom"]);
  });

  test("a stalled read fails explicitly, ignores late replies, and releases a shared connection", async t => {
    const data: { threads: { stalled: { hang?: boolean; thread?: ReturnType<typeof thread> }; late: { delay: number; thread: ReturnType<typeof thread> }; healthy: { thread: ReturnType<typeof thread> } }; pages: object } = { threads: {
      stalled: { hang: true }, late: { delay: 5500, thread: thread("late", 2) }, healthy: { thread: thread("healthy", 3) },
    }, pages: { first: { data: [], nextCursor: null } } };
    const fixture = await setup(t, data, { stalled: saved("stalled"), late: saved("late"), healthy: saved("healthy") }, true);
    const before = Date.now(), reply = await fixture.call("thread/list", list);
    assert.ok(reply.error, "must not silently return an incomplete successful list");
    assert.match(errorOf(reply).message, /timed out.*retry/i);
    assert.ok(Date.now() - before < 6500);
    assert.ok(fixture.records().some(row => row.finish === "healthy"), "one stall must not prevent unrelated reads");
    await pause(700);
    assert.ok(!fixture.stray.some(msg => String(msg.id).startsWith("acp-bridge-engine-")), "late internal replies must not leak to the client");
    data.threads.stalled = { thread: thread("stalled", 1) }; data.threads.late.delay = 0;
    fixture.write(data);
    const retried = await fixture.call("thread/list", list);
    assert.deepEqual(resultOf(retried).data.map(row => row.id), ["healthy", "late", "stalled"]);
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
    assert.deepEqual(resultOf(items).data.map(row => row.item.id), ["reply", "ask"]);
    const none = await fixture.call("thread/items/list", { threadId: "empty", limit: 30, sortDirection: "desc" });
    assert.equal(none.error, undefined, JSON.stringify(none.error));
    assert.deepEqual(resultOf(none).data, []);
    // A recorded thread whose items the engine truly cannot list keeps the engine's own answer.
    fixture.write({ ...state, turnsError: undefined, turns: [] });
    const refused = await fixture.call("thread/items/list", { threadId: "fresh", limit: 30, sortDirection: "desc" });
    assert.equal(refused.error?.code, -32601);
    assert.match(errorOf(refused).message, /thread\/items\/list is not supported yet/);
  });
}
