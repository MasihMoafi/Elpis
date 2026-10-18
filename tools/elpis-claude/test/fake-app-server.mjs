#!/usr/bin/env node
// A scripted stand-in for `elpis app-server` (stdio JSON-RPC), used as ELPIS_ENGINE_BIN in tests. No model calls.
// Every message it receives is appended to $FAKE_ENGINE_LOG. A turn answers `Answer from <model>: <input>` in two
// deltas; markers in the input change the turn:
//   [commentary]       a commentary message first
//   [command]          asks to run a command and reports the decision it got (approval request first)
//   [hang]             waits for turn/interrupt
//   [fail]             the turn fails
//   [crash]            the process exits with code 3 after accepting the turn
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mcp = process.argv[2] === "mcp";
const socketPath = process.env.FAKE_ENGINE_SOCKET || process.argv.find(arg => arg.startsWith("unix://"))?.slice(7);
if (!mcp && process.argv[2] !== "app-server") { process.stderr.write("fake engine: only app-server\n"); process.exit(2); }
const log = (entry) => { if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(entry) + "\n"); };
const send = (msg, socket) => socket ? socket.send(JSON.stringify(msg)) : process.stdout.write(JSON.stringify(mcp ? { jsonrpc: "2.0", ...msg } : msg) + "\n");
let wss;
const notify = (method, params) => wss ? [...wss.clients].forEach(socket => send({ method, params }, socket)) : send({ method, params });
const threads = new Map(); // id -> { model }
const waiting = new Map(); // our request id -> resolve
const turns = new Map(); // turn id -> { interrupt }
let seq = 0;
const ask = (method, params) => new Promise((resolve) => { const id = `engine-${++seq}`; waiting.set(id, resolve); send({ id, method, params }); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(threadId, turn, text) {
  const thread = threads.get(threadId);
  thread.status = { type: "active", activeFlags: [] };
  thread.turns = [turn];
  let interrupted = false;
  let releaseSteer;
  const steered = new Promise(resolve => { releaseSteer = resolve; });
  const stopped = new Promise((resolve) => turns.set(turn.id, { steer: releaseSteer, interrupt: () => { interrupted = true; resolve(); } }));
  const finish = (status, extra = {}) => {
    turns.delete(turn.id);
    turn.status = status;
    thread.status = { type: "idle" };
    notify("turn/completed", { threadId, turn: { ...turn, status, items: [], error: null, ...extra } });
  };
  notify("turn/started", { threadId, turn });
  notify("thread/status/changed", { threadId, status: thread.status });
  const message = async (id, body, phase) => {
    notify("item/started", { threadId, turnId: turn.id, item: { type: "agentMessage", id, text: "", phase } });
    const half = Math.ceil(body.length / 2);
    for (const delta of [body.slice(0, half), body.slice(half)]) { notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: id, delta }); await pause(5); }
    notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id, text: body, phase } });
  };
  if (text.includes("[crash]")) { await pause(20); process.exit(3); }
  if (text.includes("[fail]")) return finish("failed", { error: { message: "Fake engine failure" } });
  if (text.includes("[commentary]")) await message("note-1", "Looking around first.", "commentary");
  notify("item/reasoning/summaryTextDelta", { threadId, turnId: turn.id, itemId: "think-1", delta: "Thinking briefly.", summaryIndex: 0 });
  if (text.includes("[mcp]")) {
    const results = [];
    for (const [key, config] of Object.entries(thread.config ?? {})) {
      if (!key.startsWith("mcp_servers.")) continue;
      const client = new Client({ name: "mock-engine", version: "1" });
      const transport = config.command ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env } })
        : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        const result = await client.callTool({ name: tools.tools[0].name, arguments: {} });
        results.push(...result.content.filter(c => c.type === "text").map(c => c.text));
      } finally { await client.close(); }
    }
    await message("mcp-answer", results.join(" ") || "NO MCP TOOLS", "final_answer");
    return finish("completed");
  }
  if (text.includes("[steer]")) {
    await message("live-note", "LIVE planted update", "commentary");
    const instruction = await Promise.race([steered, stopped.then(() => null)]);
    if (interrupted) return finish("interrupted");
    await message("steered-answer", `STEERED: ${instruction}`, "final_answer");
    return finish("completed");
  }
  let decision = null;
  if (text.includes("[command]")) {
    const asked = ask("item/commandExecution/requestApproval", { threadId, turnId: turn.id, itemId: "cmd-1", startedAtMs: Date.now(), command: "touch approved.txt", cwd: "/work", reason: "Needs to write" })
      .then((r) => { const d = r?.decision ?? `error:${JSON.stringify(r)}`; log({ decision: d }); return d; });
    decision = await Promise.race([asked, stopped.then(() => null)]);
    if (interrupted || decision === "cancel") return finish("interrupted");
    const ran = decision === "accept" || decision === "acceptForSession";
    const item = { type: "commandExecution", id: "cmd-1", command: "touch approved.txt", cwd: "/work", processId: null, source: "agent", status: ran ? "inProgress" : "declined", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    if (ran) {
      notify("item/started", { threadId, turnId: turn.id, item });
      notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: "completed", aggregatedOutput: "done\n", exitCode: 0, durationMs: 3 } });
    } else notify("item/completed", { threadId, turnId: turn.id, item });
  }
  if (text.includes("[hang]")) { await stopped; return finish("interrupted"); }
  if (interrupted) return finish("interrupted");
  await message("answer-1", `Answer from ${thread.model}: ${decision ? `decision ${decision}. ` : ""}${text}`, "final_answer");
  finish(interrupted ? "interrupted" : "completed");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
if (!socketPath) process.stdin.on("end", () => process.exit(0));

if (!mcp && socketPath) {
  const { createServer } = await import("node:http");
  const server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", socket => socket.on("message", raw => handle(JSON.parse(raw), socket)));
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
}

function handle(msg, socket) {
  log(msg);
  const reply = result => send({ id: msg.id, result }, socket);
  const error = message => send({ id: msg.id, error: { code: -32601, message } }, socket);
  if (mcp) {
    if (msg.id === undefined) return;
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "planted-mcp", version: "1" } });
    if (msg.method === "tools/list") return reply({ tools: [{ name: "read_nonce", description: "Read the planted nonce", inputSchema: { type: "object" } }] });
    if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: fs.readFileSync(process.env.FAKE_MCP_NONCE_FILE, "utf8") }] });
    return error("unknown MCP method");
  }
  if (msg.id !== undefined && !msg.method) { const resolve = waiting.get(msg.id); waiting.delete(msg.id); resolve?.(msg.error ? { decision: `error:${msg.error.message}` } : msg.result); return; }
  if (msg.id === undefined) return;
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize": log({ engineHome: process.env.ELPIS_HOME ?? null }); return reply({ userAgent: "fake-engine/0" });
    case "thread/start": {
      const id = randomUUID();
      const thread = { id, cwd: p.cwd, source: "appServer", status: { type: "idle" }, model: p.model ?? "default-model", config: p.config, turns: [] };
      threads.set(id, thread);
      reply({ thread, model: thread.model, modelProvider: p.modelProvider ?? "openai" });
      return notify("thread/started", { thread });
    }
    case "thread/name/set": threads.get(p.threadId).name = p.name; return reply({});
    case "thread/list": return reply({ data: [...threads.values()], nextCursor: null });
    case "thread/resume":
    case "thread/read": return threads.has(p.threadId) ? reply({ thread: threads.get(p.threadId) }) : error("thread not found");
    case "thread/turns/list": return reply({ data: threads.get(p.threadId).turns, nextCursor: null });
    case "thread/unsubscribe": return reply({});
    case "turn/steer": {
      const turn = turns.get(p.expectedTurnId);
      if (!turn) return error("no running turn");
      reply({ turnId: p.expectedTurnId });
      return turn.steer(p.input.map(c => c.text).join("\n"));
    }
    case "turn/start": {
      if (!threads.has(p.threadId)) return send({ id: msg.id, error: { code: -32600, message: "no such thread" } });
      const turn = { id: `turn-${randomUUID()}`, status: "inProgress", items: [] };
      reply({ turn });
      const text = (p.input ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      runTurn(p.threadId, turn, text);
      return;
    }
    case "turn/interrupt": { turns.get(p.turnId)?.interrupt(); return reply({}); }
    default: return error(`fake engine: ${msg.method}`);
  }
}
