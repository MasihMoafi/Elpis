// Real bridges and launcher, private homes/sockets, deterministic engine; no provider calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { startToken } from "../shared-runtime.mjs";

const self = fileURLToPath(import.meta.url);
const source = fileURLToPath(new URL("..", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes("--elpis-local-bridge")) {
  // The shell wrapper's terminal executable, using the real bridge endpoint it selected.
  const endpoint = process.argv[process.argv.indexOf("--remote") + 1].replace(/^unix:\/\//, "");
  const ws = new WebSocket(`ws+unix://${endpoint}:/`);
  ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "idle-terminal" }, capabilities: {} } })));
  ws.on("message", data => {
    const msg = JSON.parse(String(data));
    if (msg.id === 1) ws.send(JSON.stringify({ id: 2, method: "thread/read", params: { threadId: "chat", includeTurns: true } }));
    if (msg.id === 2) { process.stdout.write(JSON.stringify(msg) + "\n"); ws.close(); }
  });
  ws.on("close", () => process.exit(0));
} else if (process.argv.includes("app-server")) {
  const trace = msg => fs.appendFileSync(process.env.IDLE_TRACE, JSON.stringify(msg) + "\n");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", ws => ws.on("message", data => {
    const msg = JSON.parse(String(data));
    trace(msg);
    const send = message => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
    if (msg.id === undefined) return;
    if (msg.method === "fixture/turn") {
      send({ method: "turn/started", params: { threadId: "chat", turn: { id: "running" } } });
      setTimeout(() => send(ws.unsubscribed
        ? { method: "thread/closed", params: { threadId: "chat" } }
        : msg.params.statusOnly
        ? { method: "thread/status/changed", params: { threadId: "chat", status: { type: "idle" } } }
        : { method: "turn/completed", params: { threadId: "chat", turn: { id: "running" } } }), msg.params.delay);
    }
    if (msg.method === "thread/unsubscribe") ws.unsubscribed = true;
    if (msg.method === "fixture/plan") send({ method: "turn/plan/updated", params: { threadId: "chat", turnId: "saved-turn", plan: [{ step: "preserved plan", status: "completed" }] } });
    if (process.env.IDLE_HOLD === msg.method) return;
    let result = {};
    if (msg.method === "thread/read" || msg.method === "thread/resume") result = { thread: { id: "chat", cwd: process.env.HOME, turns: [], status: { type: "idle" } } };
    if (msg.method === "thread/list") result = { data: [{ id: "chat", cwd: process.env.HOME, preview: "saved native chat" }], nextCursor: null };
    if (msg.method === "thread/turns/list") result = { data: [], nextCursor: null };
    const answer = () => send({ id: msg.id, result });
    if (process.env.IDLE_DELAY === msg.method) setTimeout(answer, 600);
    else answer();
  }));
  server.listen(process.argv[process.argv.indexOf("--listen") + 1].replace(/^unix:\/\//, ""));
  process.on("SIGTERM", () => process.exit(0));
} else {
  async function until(predicate, label, ms = 5000) {
    const deadline = Date.now() + ms;
    while (!predicate()) { assert(Date.now() < deadline, label); await pause(20); }
  }

  async function setup(t, extra = {}, bundleSource = process.env.ELPIS_IDLE_TEST_BUNDLE ?? source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ebi-"));
    const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root,
      XDG_RUNTIME_DIR: root, TMPDIR: root, ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
      ACP_BRIDGE_STORE: path.join(root, "chats.json"), ACP_BRIDGE_LOG: path.join(root, "bridge.log"),
      IDLE_TRACE: path.join(root, "trace"), ELPIS_ENGINE_BIN: path.join(root, "engine"), ...extra };
    fs.writeFileSync(env.IDLE_TRACE, "");
    fs.writeFileSync(env.ELPIS_ENGINE_BIN, `#!${process.execPath}\nimport ${JSON.stringify(self)};\n`, { mode: 0o755 });
    const saved = { chat: { providerHistory: true, turns: [{ id: "saved-turn", startedAt: 1, items: [{ type: "agentMessage", text: "preserve this answer" }] }] } };
    fs.writeFileSync(env.ACP_BRIDGE_STORE, JSON.stringify(saved));
    const bundle = (name, from = source) => {
      const dir = path.join(root, name); fs.mkdirSync(dir);
      for (const file of fs.readdirSync(from).filter(file => file.endsWith(".mjs") || ["elpis-claude", "package.json", "package-lock.json"].includes(file))) fs.copyFileSync(path.join(from, file), path.join(dir, file));
      fs.symlinkSync(path.join(source, "node_modules"), path.join(dir, "node_modules"));
      return dir;
    };
    const first = bundle("a", bundleSource);
    const children = [], sockets = [];
    let endpoint;
    const run = (file, args = [], overrides = {}, executable = process.execPath) => {
      const child = spawn(executable, [file, ...args], { env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
      child.output = ""; child.errors = "";
      child.stdout.on("data", data => { child.output += data; }); child.stderr.on("data", data => { child.errors += data; });
      children.push(child); return child;
    };
    const launch = async (dir, overrides = {}, terminal = false) => {
      const child = terminal ? run(path.join(dir, "elpis-claude"), [], overrides, "/bin/bash")
        : run(path.join(dir, "shared-runtime.mjs"), [path.join(dir, "acp-bridge.mjs")], overrides);
      await once(child, "exit");
      if (child.exitCode === 0 && !terminal) endpoint = child.output.trim().replace(/^unix:\/\//, "");
      return child;
    };
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      // Only children/state of this test's private home are ever signalled.
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const states = fs.readdirSync(path.join(root, "elpis-bridge"), { recursive: true });
      for (const file of states.filter(file => file.endsWith("state.json"))) {
        const stateFile = path.join(root, "elpis-bridge", file);
        if (!fs.existsSync(stateFile)) continue;
        const state = JSON.parse(fs.readFileSync(stateFile));
        if (startToken(state.pid) === state.token) { try { process.kill(state.pid, "SIGTERM"); } catch {} }
      }
      await pause(250);
      spawnSync("gio", ["trash", root]);
    });
    const connect = async () => {
      const ws = new WebSocket(`ws+unix://${endpoint}:/`); sockets.push(ws); await once(ws, "open");
      let seq = 0; const frames = [];
      ws.on("message", data => frames.push(JSON.parse(String(data))));
      const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return id; };
      const call = async (method, params) => { const id = send(method, params); await until(() => frames.some(msg => msg.id === id), `${method} reply`); return frames.find(msg => msg.id === id); };
      await call("initialize", { clientInfo: { name: "idle-fixture" }, capabilities: {} });
      return { ws, send, call, frames };
    };
    const records = () => fs.readFileSync(env.IDLE_TRACE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const start = async () => {
      // Accelerate only the existing idle grace timer, without a production test setting.
      const preload = path.join(root, "timer.mjs");
      fs.writeFileSync(preload, "const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 30_000 ? 200 : ms, ...args);\n");
      endpoint = path.join(root, "elpis-bridge", "direct.sock"); fs.mkdirSync(path.dirname(endpoint), { mode: 0o700 });
      const child = run(path.join(first, "acp-bridge.mjs"), [], { ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: endpoint, NODE_OPTIONS: `--import=${preload}` });
      await until(() => fs.existsSync(endpoint), "private bridge starts");
      return child;
    };
    return { root, env, saved, first, bundle, run, launch, connect, records, start };
  }

  for (const method of ["thread/start", "thread/resume", "thread/read"]) test(`detached unanswered ${method} bookkeeping cannot hold the bridge forever`, async t => {
    const f = await setup(t, { IDLE_HOLD: method }); const child = await f.start(); const c = await f.connect();
    c.send(method, { threadId: "chat", includeTurns: true, cwd: f.root, ...(method === "thread/start" ? { model: "claude/sonnet" } : {}) });
    await until(() => f.records().some(msg => msg.method === method), "engine received pending request");
    c.ws.close(); await once(c.ws, "close");
    await until(() => child.exitCode === 0, "unattached bookkeeping releases idle bridge", 1800);
  });

  test("idle is checked again after an internal read finishes after turn completion", async t => {
    const f = await setup(t, { IDLE_DELAY: "thread/read" }); const child = await f.start(); const c = await f.connect();
    await c.call("fixture/turn", { delay: 400 });
    c.send("thread/read", { threadId: "chat", includeTurns: true });
    await until(() => f.records().some(msg => msg.method === "thread/read"), "read started");
    c.ws.close(); await once(c.ws, "close");
    await until(() => child.exitCode === 0, "finished read triggers idle check", 1800);
  });

  for (const statusOnly of [false, true]) test(`detached native/background work survives until ${statusOnly ? "idle status" : "completion"}`, async t => {
    const f = await setup(t); const child = await f.start(); const c = await f.connect();
    await c.call("fixture/turn", { delay: 900, statusOnly });
    c.ws.close(); await once(c.ws, "close"); await pause(450);
    assert.equal(child.exitCode, null, "running work keeps bridge alive after idle grace");
    await until(() => child.exitCode === 0, "work completion releases idle bridge", 1800);
  });

  test("an unsubscribed native turn releases engineTurns on the engine's thread/closed broadcast", async t => {
    const f = await setup(t); const child = await f.start(); const c = await f.connect();
    await c.call("fixture/turn", { delay: 900 });
    await c.call("thread/unsubscribe", { threadId: "chat" });
    c.ws.close(); await once(c.ws, "close"); await pause(450);
    assert.equal(child.exitCode, null, "unsubscribed background work still runs");
    await until(() => child.exitCode === 0, "thread/closed clears the otherwise stranded engineTurns entry", 1800);
  });

  test("two private bundles hand over gracefully and reopen saved chats", async t => {
    const f = await setup(t, {}, process.env.ELPIS_IDLE_OLD_BUNDLE ?? source);
    const second = f.bundle("b");
    assert.equal((await f.launch(f.first)).exitCode, 0);
    const c = await f.connect();
    assert.equal((await c.call("thread/read", { threadId: "chat", includeTurns: true })).result.thread.turns[0].items[0].text, "preserve this answer");
    // A bridge-owned write, beyond the already saved transcript, must survive stopBridge.
    await c.call("fixture/plan");
    await until(() => JSON.parse(fs.readFileSync(f.env.ACP_BRIDGE_STORE)).chat.plan?.plan?.[0]?.step === "preserved plan", "bridge saves its plan");
    c.ws.close(); await once(c.ws, "close");
    const result = await f.launch(second, {}, true);
    assert.equal(result.exitCode, 0, result.errors);
    assert.match(result.output, /preserve this answer/, "shell launcher started a terminal on the replacement bridge");
    const reopened = await f.connect();
    assert.equal((await reopened.call("thread/list", {})).result.data[0].id, "chat");
    assert.equal((await reopened.call("thread/read", { threadId: "chat", includeTurns: true })).result.thread.turns[0].items[0].text, "preserve this answer");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.env.ACP_BRIDGE_STORE)).chat.turns, f.saved.chat.turns);
    assert.equal(JSON.parse(fs.readFileSync(f.env.ACP_BRIDGE_STORE)).chat.plan.plan[0].step, "preserved plan");
  });

  test("a different bundle leaves an attached terminal working and keeps the existing message", async t => {
    const f = await setup(t, {}, process.env.ELPIS_IDLE_OLD_BUNDLE ?? source); const second = f.bundle("b");
    assert.equal((await f.launch(f.first)).exitCode, 0); const c = await f.connect();
    const result = await f.launch(second);
    assert.equal(result.exitCode, 1); assert.match(result.errors, /different installation/); assert.match(result.errors, /Close the Elpis terminals/);
    assert.ok((await c.call("thread/list", {})).result.data.length);
  });

  test("configuration differences alone keep the existing refusal", async t => {
    const f = await setup(t);
    assert.equal((await f.launch(f.first)).exitCode, 0);
    const result = await f.launch(f.first, { NO_PROXY: "different.example" });
    assert.equal(result.exitCode, 1); assert.match(result.errors, /different configuration/);
    assert.ok((await (await f.connect()).call("thread/list", {})).result.data.length);
  });

  test("unavailable socket inspection cannot retire a bridge", async t => {
    const f = await setup(t); const second = f.bundle("b");
    assert.equal((await f.launch(f.first)).exitCode, 0);
    const result = await f.launch(second, { PATH: f.root });
    assert.equal(result.exitCode, 1); assert.match(result.errors, /different installation/);
    assert.ok((await (await f.connect()).call("thread/list", {})).result.data.length);
  });
}
