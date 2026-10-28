// A workflow agent's chat and the person's own MCP servers (mem/threads): its chat starts, and reopens, with each
// configured server off unless its definition names it (ELPIS_WORKFLOW_USER_MCP=1 keeps them all), and its engine,
// with that chat and its servers, ends when the agent is done, while a chat's engine stays.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { bridgeExecutor } from "../workflow-agents.mjs";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mjs";

const BRIDGE = fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const SERVERS = { shadcn: { command: "shadcn-mcp" }, blender: { command: "blender-mcp" }, whispertype: { command: "whispertype-mcp" } };
const ALL_OFF = { "mcp_servers.shadcn.enabled": false, "mcp_servers.blender.enabled": false, "mcp_servers.whispertype.enabled": false };
const NODE = { runId: "wf_1", agentId: "a1", label: "Inspect", model: "gpt-test", effort: "high", cwd: os.tmpdir() };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, check, ms = 10_000) => {
  for (const end = Date.now() + ms; ; await pause(20)) { const value = check(); if (value) return value; assert.ok(Date.now() < end, what); }
};

// The bridge as the executor sees it: every request recorded, a configuration with three MCP servers.
async function fakeElpis(t) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const requests = [];
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id === undefined) return;
    requests.push(m);
    const reply = (result) => ws.send(JSON.stringify({ id: m.id, result }));
    if (m.method === "config/read") return reply({ config: { model: "gpt-test", mcp_servers: SERVERS } });
    if (m.method === "thread/start" || m.method === "thread/resume") return reply({ thread: { id: m.params.threadId ?? "node-1" }, model: "gpt-test" });
    if (m.method !== "turn/start") return reply({});
    reply({ turn: { id: "turn-1" } });
    ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: "turn-1", status: "completed" } } }));
  }));
  t.after(() => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(resolve); }));
  return { url: `ws://127.0.0.1:${wss.address().port}`, sent: (method) => requests.filter((m) => m.method === method).map((m) => m.params) };
}

test("a workflow agent's chat starts and reopens with the person's MCP servers off, except one its definition names", async (t) => {
  const elpis = await fakeElpis(t);
  const executor = bridgeExecutor({ url: elpis.url });
  await executor.open(NODE);
  await executor.open({ ...NODE, agentId: "a2", mcpServers: ["blender"] });
  const [every, named] = elpis.sent("thread/start").map((p) => p.config);
  assert.deepEqual(every, { model_reasoning_effort: "high", ...ALL_OFF });
  const { "mcp_servers.blender.enabled": _kept, ...others } = ALL_OFF;
  assert.deepEqual(named, { model_reasoning_effort: "high", ...others }, "the server the agent's definition names stays on");
  assert.deepEqual(elpis.sent("config/read")[0], { includeLayers: false, cwd: NODE.cwd }, "the project's own servers count too");

  // After a restart the runner reopens the agent's chat in a new engine: alike.
  await bridgeExecutor({ url: elpis.url }).turn({ threadId: "node-1", text: "again" });
  assert.deepEqual(elpis.sent("thread/resume").at(-1), { threadId: "node-1", config: ALL_OFF });
});

test("with ELPIS_WORKFLOW_USER_MCP=1 a workflow agent's chat starts and reopens as before", async (t) => {
  process.env.ELPIS_WORKFLOW_USER_MCP = "1";
  t.after(() => { delete process.env.ELPIS_WORKFLOW_USER_MCP; });
  const elpis = await fakeElpis(t);
  const executor = bridgeExecutor({ url: elpis.url });
  await executor.open(NODE);
  await executor.open({ ...NODE, agentId: "a2", effort: null });
  await bridgeExecutor({ url: elpis.url }).turn({ threadId: "node-1", text: "again" });
  assert.deepEqual(elpis.sent("thread/start").map((p) => p.config), [{ model_reasoning_effort: "high" }, undefined]);
  assert.deepEqual(elpis.sent("thread/resume"), [{ threadId: "node-1" }]);
  assert.equal(elpis.sent("config/read").length, 0);
});

// Through the real shared bridge: an agent's connection gets a private engine (shared-runtime.mjs, EngineProxy), so
// its chat and that chat's MCP servers end with that engine, without waiting for the engine's idle unload.
test("a workflow agent's engine ends when the agent is done; a chat's engine and chat stay", { timeout: 30_000 }, async (t) => {
  const root = createTestTempDir(path.join(os.tmpdir(), "wf-agents-"));
  const socketPath = path.join(root, "bridge.sock");
  const engineLog = path.join(root, "engine.jsonl");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ config: { features: { multi_agent: false }, mcp_servers: SERVERS } }));
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
    ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: ENGINE, ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
    ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: path.join(root, "bridge.log"),
    FAKE_ENGINE_LOG: engineLog, FAKE_ENGINE_CONFIG: path.join(root, "config.json") };
  const bridge = spawn(process.execPath, [BRIDGE], { env, cwd: root, detached: true, stdio: "ignore" });
  let chat;
  t.after(() => { chat?.close(); try { process.kill(-bridge.pid, "SIGKILL"); } catch {} removeTestTempDir(root); });
  const engines = () => fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).flatMap((pid) => {
    try {
      const ppid = Number(/PPid:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return ppid === bridge.pid && argv.includes(ENGINE) ? [{ pid: Number(pid), shared: argv.includes("--listen") }] : [];
    } catch { return []; }
  });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const engineSaw = (method) => (fs.existsSync(engineLog) ? fs.readFileSync(engineLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((m) => m.method === method);
  await until("the bridge listens", () => fs.existsSync(socketPath));

  // A chat the person talks to, on the shared engine.
  chat = new WebSocket(`ws+unix://${socketPath}:/`);
  await once(chat, "open");
  const replies = new Map();
  chat.on("message", (d) => { const m = JSON.parse(String(d)); replies.get(m.id)?.(m); });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; replies.set(id, resolve); chat.send(JSON.stringify({ id, method, params })); });
  await rpc("initialize", { clientInfo: { name: "wf-desktop", version: "1" }, capabilities: { experimentalApi: true } });
  const parent = (await rpc("thread/start", { cwd: root })).result.thread.id;

  const executor = bridgeExecutor({ url: `ws+unix://${socketPath}:/` });
  const { threadId } = await executor.open({ ...NODE, cwd: root, parentThreadId: parent });
  assert.deepEqual(engineSaw("thread/start").at(-1).params.config, { model_reasoning_effort: "high", ...ALL_OFF }, "the bridge passes the servers' switches on");
  const node = await until("the agent's private engine", () => engines().find((e) => !e.shared));
  const shared = engines().find((e) => e.shared);
  assert.ok(shared, "the chat's shared engine");
  assert.match((await executor.turn({ threadId, text: "inspect" })).text, /inspect/);

  executor.close(threadId); // what the runner does once the agent succeeded, failed or was stopped
  await until("the agent's engine ends with the agent", () => !alive(node.pid));
  await pause(300);
  assert.ok(alive(shared.pid), "the chat's engine stays");
  assert.equal((await rpc("thread/read", { threadId: parent, includeTurns: false })).result?.thread?.id, parent, "the chat stays open");
  assert.deepEqual(engineSaw("thread/unsubscribe"), [], "nothing is unsubscribed: the agent's engine ended, the chat stays followed");
});
