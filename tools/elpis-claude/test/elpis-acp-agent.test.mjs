// The Elpis ACP agent (elpis-acp-agent.mjs) driven by the official ACP SDK client, on a scripted app-server
// (fake-app-server.mjs as ELPIS_ENGINE_BIN). No model calls.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { DesktopClient } from "../../../apps/elpis-desktop/bridge/client.mjs";
import { runtimeDir } from "../shared-runtime.mjs";

const AGENT = fileURLToPath(new URL("../elpis-acp-agent.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const BRIDGE = fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(10)) { const value = check(); if (value) return value; }
  throw new Error(`timed out waiting for ${what}`);
}

function start(t, { args = ["--model", "luna-test", "--provider", "openai"], answer, command, shared = false, env = {} } = {}) {
  const cache = path.join(os.homedir(), ".cache/elpis-tests");
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, "acp-"));
  const engineLog = path.join(dir, "engine.jsonl");
  const home = path.join(dir, "elpis");
  const runtimeRoot = path.join(dir, "r");
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const priorRuntime = process.env.XDG_RUNTIME_DIR;
  let socketPath;
  try { process.env.XDG_RUNTIME_DIR = runtimeRoot; socketPath = shared === "discover" ? runtimeDir(home).sock : path.join(dir, "bridge.sock"); }
  finally { if (priorRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = priorRuntime; }
  const isolated = { ELPIS_HOME: home, XDG_RUNTIME_DIR: runtimeRoot, ELPIS_APP_BRIDGE_SOCKET: "", ELPIS_BRIDGE_SOCKET: "", ELPIS_BRIDGE_URL: "" };
  const runtime = shared ? spawn(process.execPath, shared === "bridge" ? [BRIDGE] : [ENGINE, "app-server"], { env: { ...process.env, ...isolated, ELPIS_ENGINE_BIN: ENGINE, ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1", ACP_BRIDGE_LOG: path.join(dir, "bridge.log"), ...(shared === "bridge" ? { ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: socketPath } : { FAKE_ENGINE_SOCKET: socketPath }), FAKE_ENGINE_LOG: engineLog }, stdio: ["pipe", "ignore", "inherit"] }) : null;
  const launch = command ? command(dir) : { argv: [process.execPath, AGENT, ...args], env: { ELPIS_ENGINE_BIN: ENGINE } };
  const [program, ...argv] = launch.argv;
  const child = spawn(program, argv, { cwd: dir, env: { ...process.env, ...isolated, ...(shared && shared !== "discover" ? { ELPIS_APP_BRIDGE_SOCKET: socketPath } : {}), FAKE_ENGINE_LOG: engineLog, ...launch.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = once(child, "exit");
  const events = []; // session/update and permission requests, in arrival order
  const state = { answer: answer ?? (() => ({ outcome: { outcome: "selected", optionId: "allow_once" } })) };
  const conn = client({ name: "acp-agent-test" })
    .onNotification("session/update", ({ params }) => { events.push({ kind: "update", ...params }); })
    .onRequest("session/request_permission", async ({ params }) => { events.push({ kind: "permission", ...params }); return state.answer(params); })
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  t.after(async () => {
    conn.close(); child.kill("SIGKILL");
    if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
      const gone = once(runtime, "exit"); runtime.kill("SIGTERM");
      const timer = setTimeout(() => runtime.kill("SIGKILL"), 2000);
      await gone; clearTimeout(timer);
    }
    execFileSync("gio", ["trash", dir]);
  });
  const engine = () => (fs.existsSync(engineLog) ? fs.readFileSync(engineLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const updates = (kind) => events.filter((e) => e.kind === "update" && (!kind || e.update.sessionUpdate === kind)).map((e) => e.update);
  const text = (kind = "agent_message_chunk") => updates(kind).map((u) => u.content.text).join("");
  const open = async (meta, mcpServers = []) => {
    if (shared) await until(() => fs.existsSync(socketPath), "mock shared socket");
    const init = await conn.agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const session = await conn.agent.request("session/new", { cwd: dir, mcpServers, ...(meta ? { _meta: meta } : {}) });
    return { init, sessionId: session.sessionId };
  };
  const prompt = (sessionId, text) => conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { dir, socketPath, runtime, child, conn, events, state, engine, updates, text, open, prompt, exited, stderr: () => stderr };
}

test("workflow ACP keeps verification read-only and applies scoped writer permissions and effort", { timeout: 20000 }, async t => {
  const a = start(t);
  fs.mkdirSync(path.join(a.dir, 'src'));
  const { sessionId } = await a.open({ elpis: { workflow: { kind: 'implement', writeScopes: ['src'], reasoningEffort: 'high' } } });
  await a.prompt(sessionId, 'Write only src');
  const turn = a.engine().find(m => m.method === 'turn/start').params;
  assert.equal(turn.permissions, 'elpis-workflow');
  assert.equal(turn.sandboxPolicy, undefined);
  const profile = a.engine().find(m => m.method === 'thread/start').params.config['permissions.elpis-workflow'];
  assert.deepEqual(profile, { extends: ':read-only', filesystem: { '/': 'read', [path.join(a.dir, 'src')]: 'write' }, network: { enabled: false } });
  assert.equal(turn.effort, 'high');
  const check = await a.conn.agent.request('session/new', { cwd: a.dir, mcpServers: [], _meta: { elpis: { workflow: { kind: 'verify', writeScopes: [] } } } });
  await a.prompt(check.sessionId, 'Check only');
  assert.equal(a.engine().filter(m => m.method === 'turn/start').at(-1).params.permissions, 'elpis-workflow');
  assert.deepEqual(a.engine().filter(m => m.method === 'thread/start').at(-1).params.config['permissions.elpis-workflow'].filesystem, { '/': 'read' });
  await assert.rejects(a.conn.agent.request('session/new', { cwd: a.dir, mcpServers: [], _meta: { elpis: { workflow: { kind: 'implement', writeScopes: ['../escape'] } } } }), /scope/i);
});

test("initialize and session/new start an Elpis thread with the chosen model and instructions", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { init, sessionId } = await a.open({ systemPrompt: { append: "Be brief and exact." } });
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.name, "elpis");
  assert.equal(init.agentCapabilities.loadSession, false);
  const started = await until(() => a.engine().find((m) => m.method === "thread/start"), "thread/start");
  assert.deepEqual(
    { cwd: started.params.cwd, model: started.params.model, modelProvider: started.params.modelProvider, approvalPolicy: started.params.approvalPolicy, sandbox: started.params.sandbox, developerInstructions: started.params.developerInstructions },
    { cwd: a.dir, model: "luna-test", modelProvider: "openai", approvalPolicy: "on-request", sandbox: "workspace-write", developerInstructions: "Be brief and exact." },
  );
  assert.ok(a.engine().some((m) => m.method === "initialized"), "the engine connection completes its own handshake");
  assert.match(sessionId, /^[0-9a-f-]{36}$/, "the ACP session is the Elpis thread");
  await assert.rejects(a.conn.agent.request("session/prompt", { sessionId: "not-a-session", prompt: [{ type: "text", text: "x" }] }), /Unknown session/);
  // Closing stdin ends the agent and its engine cleanly.
  a.child.stdin.end();
  const [code] = await a.exited;
  assert.equal(code, 0);
});

test("a turn streams as session updates: reasoning, commentary marked, then the final answer", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  const result = await a.prompt(sessionId, "[commentary] Unique seed 7f3a");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(a.text("agent_thought_chunk"), "Thinking briefly.");
  const chunks = a.updates("agent_message_chunk");
  assert.ok(chunks.length >= 4, "deltas stream as separate chunks");
  const byMessage = (id) => chunks.filter((c) => c.messageId === id);
  assert.equal(byMessage("note-1").map((c) => c.content.text).join(""), "Looking around first.");
  assert.ok(byMessage("note-1").every((c) => c._meta?.elpis?.phase === "commentary"));
  assert.equal(byMessage("answer-1").map((c) => c.content.text).join(""), "Answer from luna-test: [commentary] Unique seed 7f3a");
  assert.ok(byMessage("answer-1").every((c) => c._meta?.elpis?.phase !== "commentary"));
  const turn = a.engine().find((m) => m.method === "turn/start");
  assert.equal(turn.params.threadId, sessionId);
  assert.deepEqual(turn.params.input, [{ type: "text", text: "[commentary] Unique seed 7f3a", text_elements: [] }]);
});

test("an engine approval becomes session/request_permission; the chosen option is the engine's decision", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  const allowed = await a.prompt(sessionId, "[command] allow it");
  assert.equal(allowed.stopReason, "end_turn");
  const permission = a.events.find((e) => e.kind === "permission");
  assert.equal(permission.sessionId, sessionId);
  assert.equal(permission.toolCall.toolCallId, "cmd-1");
  assert.equal(permission.toolCall.kind, "execute");
  assert.match(permission.toolCall.title, /touch approved\.txt/);
  assert.deepEqual(permission.options.map((o) => [o.optionId, o.kind]), [["allow_once", "allow_once"], ["allow_always", "allow_always"], ["reject_once", "reject_once"]]);
  const pending = a.events.findIndex((e) => e.kind === "update" && e.update.toolCallId === "cmd-1" && e.update.status === "pending");
  assert.ok(pending >= 0 && pending < a.events.indexOf(permission), "the tool call is announced before permission is asked");
  assert.ok(a.updates("tool_call_update").some((u) => u.toolCallId === "cmd-1" && u.status === "completed"));
  assert.deepEqual(a.engine().filter((m) => "decision" in m).map((m) => m.decision), ["accept"]);
  assert.match(a.text(), /decision accept/);

  a.state.answer = () => ({ outcome: { outcome: "selected", optionId: "reject_once" } });
  const before = a.events.length;
  const rejected = await a.prompt(sessionId, "[command] reject it");
  assert.equal(rejected.stopReason, "end_turn");
  assert.deepEqual(a.engine().filter((m) => "decision" in m).map((m) => m.decision), ["accept", "decline"]);
  assert.ok(a.events.slice(before).some((e) => e.kind === "update" && e.update.toolCallId === "cmd-1" && e.update.status === "failed"), "a rejected call is shown failed");
  assert.equal(a.events.slice(before).some((e) => e.kind === "update" && e.update.toolCallId === "cmd-1" && e.update.status === "completed"), false);

  a.state.answer = () => ({ outcome: { outcome: "selected", optionId: "made-up" } });
  await a.prompt(sessionId, "[command] unknown option");
  assert.equal(a.engine().filter((m) => "decision" in m).at(-1).decision, "decline", "an unknown option fails closed");
});

test("session/cancel interrupts the running turn and the prompt ends cancelled", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  const running = a.prompt(sessionId, "[hang] wait for me");
  await until(() => a.text("agent_thought_chunk"), "the turn to start");
  await a.conn.agent.notify("session/cancel", { sessionId });
  assert.equal((await running).stopReason, "cancelled");
  const turnId = a.engine().find((m) => m.method === "turn/start") && a.engine().find((m) => m.method === "turn/interrupt")?.params.turnId;
  assert.match(turnId ?? "", /^turn-/, "the engine was asked to interrupt the turn");
  // The session takes a new prompt afterwards.
  assert.equal((await a.prompt(sessionId, "again")).stopReason, "end_turn");
});

test("session/new forwards stdio MCP tools and keeps them local to that session", { timeout: 20000 }, async t => {
  const a = start(t);
  const nonce = `STDIO-${randomUUID()}`, file = path.join(a.dir, "nonce.txt");
  fs.writeFileSync(file, nonce);
  const servers = [{ name: "planted", command: process.execPath, args: [ENGINE, "mcp"], env: [{ name: "FAKE_MCP_NONCE_FILE", value: file }] }];
  const { sessionId } = await a.open(undefined, servers);
  await a.prompt(sessionId, "[mcp] read the tool");
  assert.ok(a.text().includes(nonce), "the engine must call the client-supplied MCP tool to obtain the planted nonce");
  const before = a.events.length;
  const other = await a.conn.agent.request("session/new", { cwd: a.dir, mcpServers: [] });
  await a.prompt(other.sessionId, "[mcp] read the tool");
  assert.equal(a.events.slice(before).some(e => e.update?.content?.text?.includes(nonce)), false);
  assert.ok(a.text().includes("NO MCP TOOLS"));
});

test("session/new forwards HTTP MCP URL and headers to the engine", { timeout: 20000 }, async t => {
  const a = start(t), nonce = `HTTP-${randomUUID()}`, requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer planted-test") { res.writeHead(403).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let raw = ""; for await (const part of req) raw += part;
    const msg = JSON.parse(raw); requests.push(msg.method);
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = msg.method === "initialize" ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-nonce", version: "1" } }
      : msg.method === "tools/list" ? { tools: [{ name: "nonce", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: nonce }] };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { init, sessionId } = await a.open(undefined, [{ type: "http", name: "remote", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: "Authorization", value: "Bearer planted-test" }] }]);
  assert.equal(init.agentCapabilities.mcpCapabilities.http, true);
  await a.prompt(sessionId, "[mcp]");
  assert.ok(a.text().includes(nonce));
  assert.ok(requests.includes("tools/call"));
});

for (const shared of [true, "bridge"]) test(`desktop lists and follows an ACP turn live, steers it, then cancels another turn (${shared === true ? "mock runtime" : "provider bridge"})`, { timeout: 20000 }, async t => {
  const a = start(t, { shared });
  const { sessionId } = await a.open({ elpis: { name: "ACP live test" } });
  const desktop = await DesktopClient.connect({ socketPath: a.socketPath, rewindHome: path.join(a.dir, "rewind") });
  t.after(() => desktop.close());
  const events = []; desktop.on("event", e => events.push(e));
  const listed = await desktop.listThreads();
  assert.ok(listed.data.some(row => row.id === sessionId), "the desktop must list the ACP thread before its turn ends");
  await desktop.resume(sessionId, {});
  let finished = false;
  const running = a.prompt(sessionId, "[steer] hold the turn").finally(() => { finished = true; });
  running.catch(() => {});
  await until(() => a.text().includes("LIVE planted update"), "ACP live output");
  await until(() => events.filter(e => e.data?.method === "item/agentMessage/delta").map(e => e.data.params.delta).join("").includes("LIVE planted update"), "desktop live output before completion");
  await desktop.listThreads();
  await until(() => a.engine().some(m => m.method === "thread/resume"), "desktop subscription");
  assert.equal(finished, false);
  // The running turn's id, as the desktop's composer learns it: from the live turn/started event.
  const id = events.find(e => e.data?.method === "turn/started" && e.data.params?.threadId === sessionId)?.data.params.turn.id;
  assert.ok(id, "the desktop saw the running turn start");
  await desktop.steer(sessionId, { text: "DESKTOP planted steer", expectedTurnId: id });
  assert.equal((await running).stopReason, "end_turn");
  assert.ok(a.text().includes("DESKTOP planted steer"));
  assert.ok(events.some(e => JSON.stringify(e).includes("DESKTOP planted steer")), "desktop receives the streamed steered answer");
  const waiting = a.prompt(sessionId, "[hang]"); waiting.catch(() => {});
  await until(() => a.engine().filter(m => m.method === "turn/start").length === 2, "second turn");
  await desktop.interrupt(sessionId, {});
  assert.equal((await waiting).stopReason, "cancelled");
  a.child.stdin.end(); await a.exited;
  assert.equal(a.runtime.exitCode, null, "ACP disconnect must leave the shared runtime alive");
  assert.ok((await desktop.listThreads()).data.some(row => row.id === sessionId));
});

test("a mid-turn ACP prompt steers the existing turn without starting another", { timeout: 20000 }, async t => {
  const a = start(t);
  const { sessionId } = await a.open();
  const running = a.prompt(sessionId, "[steer]"); running.catch(() => {});
  await until(() => a.text().includes("LIVE planted update"), "running turn");
  const steered = await a.prompt(sessionId, "ACP planted steer");
  assert.equal(steered.stopReason, "end_turn");
  assert.equal((await running).stopReason, "end_turn");
  assert.ok(a.text().includes("ACP planted steer"));
  assert.equal(a.engine().filter(m => m.method === "turn/start").length, 1);
});

test("an explicitly unavailable bridge fails without starting a private engine", { timeout: 20000 }, async t => {
  const a = start(t, { env: { ELPIS_APP_BRIDGE_SOCKET: "/nonexistent/elpis-acp-test.sock" } });
  await assert.rejects(a.open(), /ENOENT|socket/);
  assert.equal(a.engine().some(m => m.method === "thread/start"), false);
});

test("ACP discovers the desktop bridge for its ELPIS_HOME and supports the steering extension", { timeout: 20000 }, async t => {
  const a = start(t, { shared: "discover" });
  const { sessionId } = await a.open();
  const steer = prompt => a.conn.agent.request("_session/steering", { sessionId, prompt: [{ type: "text", text: prompt }] });
  assert.deepEqual(await steer("idle"), { outcome: "promptRequired", reason: "noRunningTurn" });
  const running = a.prompt(sessionId, "[steer]"); running.catch(() => {});
  await until(() => a.text().includes("LIVE planted update"), "shared turn");
  assert.equal((await steer("EXTENSION planted steer")).outcome, "queued");
  assert.equal((await running).stopReason, "end_turn");
  assert.ok(a.text().includes("EXTENSION planted steer"));
  assert.equal(a.engine().filter(m => m.method === "initialize").length, 1, "ACP initializes the existing runtime, not a second private engine");
});

test("MCP names and unsupported transports fail before a thread starts", { timeout: 20000 }, async t => {
  const a = start(t);
  await a.open();
  const before = a.engine().filter(m => m.method === "thread/start").length;
  const server = { name: "same", command: "unused", args: [], env: [] };
  for (const mcpServers of [[server, server], [{ ...server, name: "nested.name" }], [{ type: "sse", name: "legacy", url: "http://127.0.0.1/unused", headers: [] }]]) {
    await assert.rejects(a.conn.agent.request("session/new", { cwd: a.dir, mcpServers }), /MCP|transport/);
  }
  assert.equal(a.engine().filter(m => m.method === "thread/start").length, before);
});

test("cancelling while permission is pending answers the engine with cancel", { timeout: 20000 }, async (t) => {
  let release;
  const a = start(t, { answer: () => new Promise((resolve) => { release = resolve; }) });
  const { sessionId } = await a.open();
  const running = a.prompt(sessionId, "[command] then wait");
  await until(() => a.events.some((e) => e.kind === "permission"), "the permission request");
  await a.conn.agent.notify("session/cancel", { sessionId });
  // ACP: after session/cancel the client answers pending permission requests with `cancelled`.
  release({ outcome: { outcome: "cancelled" } });
  assert.equal((await running).stopReason, "cancelled");
  await until(() => a.engine().some((m) => m.decision === "cancel"), "the engine to receive cancel");
  assert.equal(a.engine().some((m) => m.decision === "accept"), false);
});

test("a crashed engine fails the prompt and ends the agent with an error", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  await assert.rejects(a.prompt(sessionId, "[crash]"), /Elpis engine exited/);
  const [code] = await a.exited;
  assert.notEqual(code, 0);
});

test("a failed engine turn is a JSON-RPC error with the engine's reason", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  await assert.rejects(a.prompt(sessionId, "[fail]"), /Fake engine failure/);
});

test("`elpis acp` through the installed wrapper is the Elpis ACP agent on the real engine path", { timeout: 20000 }, async (t) => {
  // The wrapper's layout: ~/.local/lib/elpis-next/elpis-next (the engine) and its bridge folder under ~/Desktop/p.
  const a = start(t, {
    command: (dir) => {
      const home = path.join(dir, "home");
      fs.mkdirSync(path.join(home, ".local/lib/elpis-next"), { recursive: true });
      fs.symlinkSync(ENGINE, path.join(home, ".local/lib/elpis-next/elpis-next"));
      fs.mkdirSync(path.join(home, "Desktop/p/Elpis-wt-acp/tools"), { recursive: true });
      fs.symlinkSync(path.dirname(AGENT), path.join(home, "Desktop/p/Elpis-wt-acp/tools/elpis-claude"));
      // ELPIS_ENGINE_BIN is the wrapper's to set, from HOME; an inherited one must not decide the engine.
      return { argv: ["bash", path.join(path.dirname(AGENT), "elpis-wrapper"), "acp", "--model", "wrapped-model"], env: { HOME: home, ELPIS_ENGINE_BIN: "/nonexistent/elpis" } };
    },
  });
  const { sessionId } = await a.open();
  assert.equal((await a.prompt(sessionId, "through the wrapper")).stopReason, "end_turn");
  assert.equal(a.text(), "Answer from wrapped-model: through the wrapper");
});
