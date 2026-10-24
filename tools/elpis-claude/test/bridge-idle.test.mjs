import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';
// Real bridges and launcher, private homes/sockets, deterministic engine; no provider calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  if (process.env.IDLE_STDERR) {
    const text = process.env.IDLE_STDERR;
    process.stderr.write(text.slice(0, 12));
    setTimeout(() => process.stderr.write(text.slice(12) + "\n"), 20);
  }
  const trace = msg => fs.appendFileSync(process.env.IDLE_TRACE, JSON.stringify({ ...msg, engine: process.pid }) + "\n");
  // As the engine: a thread's turn events reach every connection subscribed to it.
  const subscribers = new Set();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", ws => ws.on("message", data => {
    const msg = JSON.parse(String(data));
    trace(msg);
    const send = message => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
    if (msg.id === undefined) return;
    if (msg.method === "fixture/turn" || msg.method === "thread/resume") subscribers.add(ws);
    if (msg.method === "fixture/turn") {
      send({ method: "turn/started", params: { threadId: "chat", turn: { id: "running" } } });
      if (msg.params.stream) { const timer = setInterval(() => { for (const peer of subscribers) if (peer.readyState === 1) peer.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "chat", turnId: "running", itemId: "answer", delta: "word " } })); }, 200); setTimeout(() => clearInterval(timer), msg.params.delay); }
      if (msg.params.stream) setTimeout(() => { for (const peer of subscribers) if (peer.readyState === 1) peer.send(JSON.stringify({ method: "turn/completed", params: { threadId: "chat", turn: { id: "running" } } })); }, msg.params.delay);
      else setTimeout(() => send(ws.unsubscribed
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
    const root = createTestTempDir(path.join(os.tmpdir(), "ebi-"));
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
      if (child.exitCode === 0 && !terminal) endpoint = child.output.split("\n")[0].trim().replace(/^unix:\/\//, "");
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
      removeTestTempDir(root);
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

  test("bridge request and daemon logs redact secrets while the engine sees real requests", async t => {
    const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/log-secrets.json", import.meta.url), "utf8"));
    const f = await setup(t, { IDLE_STDERR: fixtures.map(f => f.input).join("\n"), ACP_BRIDGE_DEBUG: "all" });
    assert.equal((await f.launch(f.first)).exitCode, 0);
    const c = await f.connect();
    for (const [index, fixture] of fixtures.entries()) {
      await c.call("fixture/secret", { text: fixture.input });
      const forwarded = f.records().filter(record => record.method === "fixture/secret").at(-1);
      assert.ok(forwarded.params.text === fixture.input, `engine gets real fixture ${index}`);
      const lines = fs.readFileSync(f.env.ACP_BRIDGE_LOG, "utf8").split("\n");
      const request = lines.filter(line => line.includes('"method":"fixture/secret"')).at(-1);
      assert.ok(JSON.parse(request.slice(request.indexOf("{"))).params.text === fixture.expected, `bridge stores safe fixture ${index}`);
    }
    const daemonFile = fs.readdirSync(path.join(f.root, "elpis-bridge"), { recursive: true }).find(file => file.endsWith("daemon.log"));
    const daemon = fs.readFileSync(path.join(f.root, "elpis-bridge", daemonFile), "utf8");
    for (const [index, fixture] of fixtures.entries()) {
      if (fixture.input !== fixture.expected) assert.ok(!daemon.includes(fixture.input), `daemon removes fixture ${index}`);
    }
    assert.ok(daemon.includes("[redacted:anthropic]"), "split stderr credential is redacted");
    assert.ok(daemon.includes("[redacted:env]"), "opaque stderr credentials are redacted before log prefixes");
  });

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

  test("a terminal from a different bundle joins the busy running one with that bundle's engine, which then hands over", async t => {
    const f = await setup(t, {}, process.env.ELPIS_IDLE_OLD_BUNDLE ?? source); const second = f.bundle("b");
    // As the desktop and the shell launcher both start it: with NODE_USE_ENV_PROXY=1.
    assert.equal((await f.launch(f.first, { NODE_USE_ENV_PROXY: "1" })).exitCode, 0); const c = await f.connect();
    await c.call("fixture/turn", { delay: 8000 });
    const stateFile = path.join(f.env.XDG_RUNTIME_DIR, "elpis-bridge", fs.readdirSync(path.join(f.env.XDG_RUNTIME_DIR, "elpis-bridge"))[0], "state.json");
    const running = JSON.parse(fs.readFileSync(stateFile));
    const result = await f.launch(second, { NODE_USE_ENV_PROXY: "1" });
    assert.equal(result.exitCode, 0, result.errors);
    assert.deepEqual(result.output.trim().split("\n").slice(1), [`engine ${running.engine}`], "the launcher names the running installation's engine");
    assert.match(result.errors, /using the Elpis already running/);
    // The shell launcher runs that engine, not this installation's (which would fail loudly here).
    const wrong = path.join(f.root, "wrong-engine"); fs.writeFileSync(wrong, "#!/bin/sh\necho WRONG_ENGINE; exit 3\n", { mode: 0o755 });
    const terminal = await f.launch(second, { ELPIS_ENGINE_BIN: wrong }, true);
    assert.equal(terminal.exitCode, 0, terminal.errors); assert.doesNotMatch(terminal.output, /WRONG_ENGINE/); assert.match(terminal.output, /preserve this answer/);
    assert.equal(startToken(running.pid), running.token, "the running bridge is kept while it works");
    assert.ok((await c.call("thread/list", {})).result.data.length);
    // It gives the newer bundle new connections at once and its clients reconnect to that one.
    const state = () => { try { return JSON.parse(fs.readFileSync(stateFile)); } catch { return {}; } };
    await until(() => state().pid && state().pid !== running.pid && fs.existsSync(path.join(path.dirname(stateFile), "bridge.sock")), "the newer bundle takes over", 25000);
    assert.equal(state().script, fs.realpathSync(path.join(second, "acp-bridge.mjs")));
    await until(() => c.ws.readyState !== WebSocket.OPEN, "the old bridge's clients were disconnected");
    assert.equal((await (await f.connect()).call("thread/read", { threadId: "chat", includeTurns: true })).result.thread.turns[0].items[0].text, "preserve this answer");
  });

  test("a newer bundle takes over within seconds while a turn streams; the turn finishes on the old bridge and reaches the client", { timeout: 60000 }, async t => {
    const f = await setup(t, {}, process.env.ELPIS_IDLE_OLD_BUNDLE ?? source); const second = f.bundle("b");
    assert.equal((await f.launch(f.first)).exitCode, 0);
    const c = await f.connect();
    await c.call("thread/resume", { threadId: "chat" });
    await c.call("fixture/turn", { delay: 12000, stream: true });
    const dir = path.join(f.env.XDG_RUNTIME_DIR, "elpis-bridge", fs.readdirSync(path.join(f.env.XDG_RUNTIME_DIR, "elpis-bridge"))[0]);
    const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "state.json"))); } catch { return {}; } };
    const running = state(), alive = () => startToken(running.pid) === running.token;
    const installedAt = Date.now();
    assert.equal((await f.launch(second)).exitCode, 0); // the install: a launcher of the newer bundle
    await until(() => state().pid && state().pid !== running.pid, "the newer bundle serves new connections while the turn runs", 10000);
    t.diagnostic(`hand-over took ${Date.now() - installedAt} ms`);
    assert.equal(state().script, fs.realpathSync(path.join(second, "acp-bridge.mjs")));
    assert.ok(alive(), "the old bridge keeps running its turn");
    await until(() => c.ws.readyState !== WebSocket.OPEN, "the old bridge's client is asked to reconnect");
    // The reconnecting client follows the running chat through the newer bridge and gets the turn's end.
    const d = await f.connect();
    await d.call("thread/resume", { threadId: "chat" });
    await until(() => d.frames.some(m => m.method === "item/agentMessage/delta"), "the turn keeps streaming to the reconnected client", 5000);
    await until(() => d.frames.some(m => m.method === "turn/completed" && m.params.turn.id === "running"), "the turn's end reaches the client", 15000);
    assert.equal(d.frames.filter(m => m.method === "turn/completed").length, 1, "its end arrives once");
    await until(() => !alive(), "the old bridge exits once its turn is done", 10000);
    // The chat now runs on the newer bridge's engine.
    const e = await f.connect();
    await e.call("thread/resume", { threadId: "chat" });
    await e.call("fixture/turn", { delay: 50 });
    const engines = new Set(f.records().filter(m => m.method === "fixture/turn").map(m => m.engine));
    assert.equal(engines.size, 2, "the next turn runs on the newer engine");
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
    assert.equal(result.exitCode, 0, result.errors); assert.match(result.errors, /using the Elpis already running/, "it joins instead of retiring");
    assert.ok((await (await f.connect()).call("thread/list", {})).result.data.length);
  });
}
