import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';
// Actual bridge, scripted engine and ACP adapter, isolated state; no provider calls.
// A chat whose first turn is still running must list (and search) with its prompt, model, name and status.
// Run: node --test tools/elpis-claude/test/active-first-turn-list.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import WebSocket from "../node_modules/ws/wrapper.mjs";

const engineSource = `import readline from "node:readline";
const row = (id, extra = {}) => ({ id, name: "Launched chat", cwd: process.env.HOME, source: "cli", modelProvider: "openai", model: "gpt-engine", preview: "", path: "/x/sessions/" + id,
  createdAt: 100, updatedAt: 100, recencyAt: 100, status: { type: "idle" }, ...extra });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line); if (msg.id === undefined) return;
  let result = {};
  if (msg.method === "thread/resume") result = { thread: { ...row(msg.params.threadId), turns: [] }, model: "gpt-engine", approvalPolicy: "on-request" };
  if (msg.method === "thread/read") result = { thread: row(msg.params.threadId, process.env.ARCHIVED_IDS?.split(",").includes(msg.params.threadId) ? { path: "/x/archived_sessions/" + msg.params.threadId } : {}) };
  if (msg.method === "thread/turns/list") result = { data: [], nextCursor: null };
  if (msg.method === "thread/list") result = { data: [], nextCursor: msg.params?.cursor ? null : (process.env.PAGE_TWO ? "p2" : null) };
  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
});
`;
// Claude's adapter: answers the prompt only once the test releases it.
const adapterSource = `import readline from "node:readline"; import fs from "node:fs";
const send = msg => process.stdout.write(JSON.stringify(msg) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line); if (msg.id === undefined) return;
  if (msg.method === "session/prompt") { while (!fs.existsSync(process.env.RELEASE)) await new Promise(r => setTimeout(r, 20)); send({ id: msg.id, result: { stopReason: "end_turn" } }); return; }
  send({ id: msg.id, result: ["session/new", "session/load"].includes(msg.method) ? { sessionId: "session" } : {} });
});
`;

async function start(t, store, env = {}) {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-active-list-"));
  const log = path.join(root, "log"), release = path.join(root, "release");
  const script = (name, source) => { const file = path.join(root, name); fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 }); return file; };
  fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify(store));
  const child = spawn(process.execPath, [process.env.ACTIVE_LIST_BRIDGE ?? fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url))], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
      ELPIS_ENGINE_BIN: script("engine.mjs", engineSource.replace("import readline", "import readline")), ACP_ADAPTER: script("adapter.mjs", adapterSource),
      ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: log, ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1", PORT: "0", RELEASE: release, ...env },
  });
  let stderr = "", socket;
  child.stderr.on("data", data => { stderr += data; });
  t.after(async () => {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); }
    removeTestTempDir(root);
  });
  const until = async (predicate, label) => { const end = Date.now() + 8000; while (!await predicate()) { assert.ok(Date.now() < end, `${label}: ${stderr}`); await pause(20); } };
  await until(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, "utf8")), "startup");
  socket = new WebSocket(`ws://127.0.0.1:${fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/)[1]}`);
  await once(socket, "open");
  const pending = new Map(); let seq = 0;
  socket.on("message", data => { const msg = JSON.parse(String(data)); if (msg.method && msg.id !== undefined) socket.send(JSON.stringify({ id: msg.id, result: { decision: "accept" } })); else pending.get(msg.id)?.(msg); });
  const call = (method, params) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await call("initialize", { clientInfo: { name: "active_list_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  const listed = async (params = {}) => (await call("thread/list", { sortKey: "recency_at", sourceKinds: [], limit: 100, ...params })).result?.data ?? [];
  return { call, listed, until, release: () => fs.writeFileSync(release, ""), stored: () => JSON.parse(fs.readFileSync(path.join(root, "sessions.json"), "utf8")), root };
}

const prompt = [{ type: "text", text: "Fix the browser drawing toolbar" }];

test("a root chat whose first turn is running lists and searches with prompt, model, name and active status, and settles when the turn ends", { timeout: 20000 }, async t => {
  const f = await start(t, { chat: { model: "claude/haiku", turns: [] } });
  assert.equal((await f.listed()).length, 0, "nothing to show before the first prompt");
  assert.ifError((await f.call("thread/resume", { threadId: "chat", excludeTurns: true })).error);
  assert.ifError((await f.call("turn/start", { threadId: "chat", input: prompt })).error);
  await f.until(async () => (await f.listed()).length === 1, "running first turn is listed");
  const [row] = await f.listed();
  assert.deepEqual([row.id, row.preview, row.name, row.model, row.status.type], ["chat", "Fix the browser drawing toolbar", "Launched chat", "claude/haiku", "active"]);
  assert.equal((await f.listed({ searchTerm: "browser drawing" })).length, 1);
  assert.equal((await f.listed({ searchTerm: "not in this chat" })).length, 0);
  assert.equal((await f.listed({ sourceKinds: ["exec"] })).length, 0, "a source filter still excludes it");
  assert.equal((await f.listed({ cwd: "/elsewhere" })).length, 0, "a folder filter still excludes it");
  f.release();
  await f.until(async () => f.stored().chat.turns?.length === 1, "turn saved");
  assert.equal(f.stored().chat.active, undefined, "the running-turn record is cleared");
  const after = await f.listed();
  assert.deepEqual(after.map(r => [r.id, r.preview, r.status.type]), [["chat", "Fix the browser drawing toolbar", "idle"]], "listed once, idle");
});

test("an archived chat stays out of the list while its first turn runs", { timeout: 20000 }, async t => {
  const f = await start(t, { chat: { model: "claude/haiku", turns: [] } }, { ARCHIVED_IDS: "chat" });
  await f.call("thread/resume", { threadId: "chat", excludeTurns: true });
  await f.call("turn/start", { threadId: "chat", input: prompt });
  await f.until(() => f.stored().chat.active, "turn recorded");
  assert.equal((await f.listed()).length, 0);
});

test("a first-turn record left by a dead bridge lists the chat as idle, not running", { timeout: 20000 }, async t => {
  const f = await start(t, { chat: { model: "claude/haiku", active: { turnId: "t", startedAt: 1, pid: 2 ** 22 + 12345, preview: "Interrupted prompt" } } });
  const rows = await f.listed();
  assert.deepEqual(rows.map(r => [r.preview, r.status.type]), [["Interrupted prompt", "idle"]]);
});

test("first-turn chats take part in pagination once, in their sorted place", { timeout: 20000 }, async t => {
  const f = await start(t, { chat: { model: "claude/haiku", active: { turnId: "t", startedAt: 1, pid: process.pid, preview: "Paged prompt" } } }, { PAGE_TWO: "1" });
  const first = await f.listed();
  const second = await f.listed({ cursor: "p2" });
  assert.equal(first.length + second.length, 1, "exactly one page carries it");
});
