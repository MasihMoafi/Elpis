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
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Turn = { id: string; status: string; items: object[] };
type McpConfig = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; http_headers?: Record<string, string> };
type Thread = {
  id: string; cwd?: string | undefined; source: string; status: { type: string; activeFlags?: string[] };
  model: string; modelProvider: string; config?: Record<string, McpConfig> | undefined;
  historyMode: string; turns: Turn[]; name?: string | undefined; archived?: boolean;
};
type Params = {
  protocolVersion?: string | number; threadId?: string; cwd?: string; model?: string; modelProvider?: string;
  config?: Record<string, McpConfig>; edits?: { keyPath: string; value: unknown }[]; lastTurnId?: string;
  name?: string; archived?: boolean; includeTurns?: boolean; expectedTurnId?: string; turnId?: string;
  input?: { type: string; text: string }[];
};
type Wire = { id?: string | number; method?: string; params?: Params; result?: { decision?: string }; error?: { message?: string } };
type EngineConfig = { features: { multi_agent: boolean }; model_providers?: Record<string, Record<string, unknown>>; model_catalog_json?: string; model_provider?: string; [key: string]: unknown };

const mcp = process.argv[2] === "mcp";
const socketPath = process.env.FAKE_ENGINE_SOCKET || process.argv.find(arg => arg.startsWith("unix://"))?.slice(7);
if (!mcp && process.argv[2] !== "app-server") { process.stderr.write("fake engine: only app-server\n"); process.exit(2); }
const log = (entry: object) => { if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(entry) + "\n"); };
const send = (msg: object, socket?: WebSocket) => socket ? socket.send(JSON.stringify(msg)) : process.stdout.write(JSON.stringify(mcp ? { jsonrpc: "2.0", ...msg } : msg) + "\n");
let wss: WebSocketServer | undefined;
const notify = (method: string, params: object) => wss ? [...wss.clients].forEach(socket => send({ method, params }, socket)) : send({ method, params });
const threads = new Map<string, Thread>(process.env.FAKE_ENGINE_STATE && fs.existsSync(process.env.FAKE_ENGINE_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_STATE, "utf8")) : []); // id -> { model }
if (process.env.FAKE_ENGINE_LAZY_PERSIST) for (const thread of threads.values()) thread.status = { type: "notLoaded" };
// The native engine stages a new carrier in memory. A full paginated read materializes it;
// injected provider history alone only flushes an existing rollout (ThreadPreparation).
const persist = () => { if (process.env.FAKE_ENGINE_STATE) fs.writeFileSync(process.env.FAKE_ENGINE_STATE, JSON.stringify([...threads])); };
const waiting = new Map<string | number, (response: { decision?: string } | undefined) => void>(); // our request id -> resolve
const turns = new Map<string, { steer: (text: string) => void; interrupt: () => void }>(); // turn id -> { interrupt }
// The connections following each thread, as the engine keeps them (it unloads a thread nobody follows); each change is
// logged as { subscribers: { threadId, count } }.
const followers = new Map<string, Set<WebSocket | string>>(); // thread id -> Set of connections
const follow = (threadId: string, connection: WebSocket | string = "stdio", on = true) => {
  const set = followers.get(threadId) ?? new Set<WebSocket | string>();
  followers.set(threadId, set);
  if (on) set.add(connection); else set.delete(connection);
  log({ subscribers: { threadId, count: set.size } });
};
// FAKE_ENGINE_LOCKS=<dir> models the real engine's per-thread writer lock: loading a thread that another live engine
// holds fails with the real error text, and the lock is dropped when this process exits.
const locksDir = process.env.FAKE_ENGINE_LOCKS;
const heldLocks = new Set<string>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const takeWriter = (threadId: string) => {
  if (!locksDir || heldLocks.has(threadId)) return null;
  fs.mkdirSync(locksDir, { recursive: true });
  const file = `${locksDir}/${threadId}`;
  try { const holder = Number(fs.readFileSync(file, "utf8")); if (holder !== process.pid && alive(holder)) return `thread-store conflict: thread ${threadId} already has an active writer`; } catch {}
  fs.writeFileSync(file, String(process.pid)); heldLocks.add(threadId);
  return null;
};
process.on("exit", () => { for (const id of heldLocks) { try { fs.rmSync(`${locksDir}/${id}`); } catch {} } });
let seq = 0;
const ask = (method: string, params: object) => new Promise<{ decision?: string } | undefined>((resolve) => { const id = `engine-${++seq}`; waiting.set(id, resolve); send({ id, method, params }); });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runTurn(threadId: string, turn: Turn, text: string) {
  const thread = threads.get(threadId);
  assert.ok(thread);
  thread.status = { type: "active", activeFlags: [] };
  thread.turns = [turn];
  let interrupted = false;
  const followups: string[] = [];
  const { promise: steered, resolve: releaseSteer } = Promise.withResolvers<string>();
  const stopped = new Promise<void>((resolve) => turns.set(turn.id, { steer: text => { followups.push(text); releaseSteer(text); }, interrupt: () => { interrupted = true; resolve(); } }));
  const finish = (status: string, extra: object = {}) => {
    turns.delete(turn.id);
    turn.status = status;
    thread.status = { type: "idle" };
    notify("turn/completed", { threadId, turn: { ...turn, status, items: [], error: null, ...extra } });
  };
  notify("turn/started", { threadId, turn });
  notify("thread/status/changed", { threadId, status: thread.status });
  const message = async (id: string, body: string, phase: string) => {
    notify("item/started", { threadId, turnId: turn.id, item: { type: "agentMessage", id, text: "", phase } });
    const half = Math.ceil(body.length / 2);
    for (const delta of [body.slice(0, half), body.slice(half)]) { notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: id, delta }); await pause(5); }
    notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id, text: body, phase } });
  };
  if (text.includes("[crash]")) { await pause(20); process.exit(3); }
  if (text.includes("[fail]")) return finish("failed", { error: { message: "Fake engine failure" } });
  if (text.includes("[commentary]")) await message("note-1", "Looking around first.", "commentary");
  notify("item/reasoning/summaryTextDelta", { threadId, turnId: turn.id, itemId: "think-1", delta: "Thinking briefly.", summaryIndex: 0 });
  if (text.includes("[native-tool]")) {
    const item = { type: "commandExecution", id: "native-slow-tool", command: "native-slow-tool", cwd: thread.cwd, status: "inProgress", commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null };
    notify("item/started", { threadId, turnId: turn.id, item });
    while (!interrupted && !fs.existsSync(process.env.FAKE_ENGINE_TOOL_RELEASE ?? "")) await pause(10);
    notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: interrupted ? "failed" : "completed", aggregatedOutput: "GPT_TOOL_DONE", exitCode: interrupted ? 1 : 0 } });
    if (interrupted) return finish("interrupted");
  }
  if (text.includes("[mcp]")) {
    const results: string[] = [];
    for (const [key, config] of Object.entries(thread.config ?? {})) {
      if (!key.startsWith("mcp_servers.")) continue;
      const client = new Client({ name: "mock-engine", version: "1" });
      const env = Object.fromEntries(Object.entries({ ...process.env, ...config.env }).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const transport = config.command ? new StdioClientTransport({ command: config.command, ...(config.args && { args: config.args }), env })
        : new StreamableHTTPClientTransport(new URL(config.url ?? ""), { requestInit: { ...(config.http_headers && { headers: config.http_headers }) } });
      try {
        await (client.connect as (value: typeof transport) => Promise<void>)(transport);
        const tools = await client.listTools();
        const tool = tools.tools[0]; assert.ok(tool);
        const result = await client.callTool({ name: tool.name, arguments: {} });
        assert.ok(Array.isArray(result.content));
        results.push(...result.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text));
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
  await message("answer-1", `Answer from ${thread.model}: ${decision ? `decision ${decision}. ` : ""}${[text, ...followups].join("\n")}`, "final_answer");
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
  wss.on("connection", socket => {
    socket.on("message", raw => handle(JSON.parse(String(raw)), socket));
    socket.on("close", () => { for (const [id, set] of followers) if (set.has(socket)) follow(id, socket, false); });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
}

// The settings the test wrote to the engine home's config.toml (top-level strings and [model_providers.*] tables), reported
// as the engine does: the effective config and the user's layer, whose version makes it writable.
function homeConfig() {
  const config: EngineConfig = { features: { multi_agent: false } }, file = path.join(process.env.ELPIS_HOME ?? "", "config.toml");
  let toml;
  try { toml = fs.readFileSync(file, "utf8"); } catch { return { config }; }
  let table: Record<string, unknown> | null = config;
  for (const line of toml.split("\n")) {
    const header = line.match(/^\[model_providers\.([^\]\s]+)\]\s*$/);
    if (header) { const name = header[1]; assert.ok(name !== undefined); config.model_providers ??= {}; table = config.model_providers[name] = {}; continue; }
    if (/^\[/.test(line)) { table = null; continue; }
    const entry = line.match(/^(\w+)\s*=\s*(".*"|true|false|\d+)\s*$/);
    if (entry && table) { const key = entry[1], value = entry[2]; assert.ok(key !== undefined && value !== undefined); table[key] = JSON.parse(value); }
  }
  return { config, layers: [{ name: { type: "user", file }, version: "fake-user-1", config }] };
}

function handle(msg: Wire, socket?: WebSocket) {
  log(msg);
  const reply = (result: object) => send({ id: msg.id, result }, socket);
  const error = (message: string) => send({ id: msg.id, error: { code: -32601, message } }, socket);
  if (mcp) {
    if (msg.id === undefined) return;
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "planted-mcp", version: "1" } });
    if (msg.method === "tools/list") return reply({ tools: [{ name: "read_nonce", description: "Read the planted nonce", inputSchema: { type: "object" } }] });
    if (msg.method === "tools/call") { const file = process.env.FAKE_MCP_NONCE_FILE; assert.ok(file !== undefined); return reply({ content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] }); }
    return error("unknown MCP method");
  }
  if (msg.id !== undefined && !msg.method) { const resolve = waiting.get(msg.id); waiting.delete(msg.id); resolve?.(msg.error ? { decision: `error:${msg.error.message}` } : msg.result); return; }
  if (msg.id === undefined) return;
  const p = msg.params ?? {};
  const threadId = () => { assert.ok(p.threadId !== undefined); return p.threadId; };
  const currentThread = () => { const thread = threads.get(threadId()); assert.ok(thread); return thread; };
  switch (msg.method) {
    case "initialize": log({ engineHome: process.env.ELPIS_HOME ?? null }); return reply({ userAgent: "fake-engine/0" });
    case "model/list": {
      // The catalogue the test's config names, as the engine lists it; otherwise one test model.
      const catalog = homeConfig().config.model_catalog_json;
      const listed = catalog ? JSON.parse(fs.readFileSync(catalog, "utf8")).models.map((model: { slug: string; display_name?: string }) => ({ id: model.slug, model: model.slug, displayName: model.display_name ?? model.slug, supportedReasoningEfforts: [] })) : [];
      return reply({ data: [{ id: "luna-test", model: "luna-test", displayName: "Test GPT", supportedReasoningEfforts: [] }, ...listed], nextCursor: null });
    }
    case "config/read": return reply(process.env.FAKE_ENGINE_CONFIG ? JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_CONFIG, "utf8")) : homeConfig());
    case 'configRequirements/read': return reply({ requirements: null });
    case 'thread/loaded/list': return reply({ data: [...threads].filter(([, thread]) => thread.status?.type !== 'notLoaded').map(([id]) => id) });
    case "config/batchWrite": {
      if (!process.env.FAKE_ENGINE_CONFIG) return reply({});
      const read = JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_CONFIG, "utf8"));
      assert.ok(p.edits);
      for (const edit of p.edits) {
        if (edit.keyPath === "features.multi_agent") read.config.features.multi_agent = edit.value;
      }
      read.layers[0].version += "-saved";
      fs.writeFileSync(process.env.FAKE_ENGINE_CONFIG, JSON.stringify(read));
      return reply({});
    }
    case "thread/elpisInstructions/read": return reply(process.env.FAKE_ENGINE_INSTRUCTIONS
      ? JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_INSTRUCTIONS, "utf8"))
      : { developerInstructions: null, agentsMd: null, continuity: null });
    case "thread/inject_items": if (process.env.FAKE_ENGINE_HOLD_INJECT) return; return reply({});
    case "thread/start": {
      const id = randomUUID();
      const thread = { id, cwd: p.cwd, source: "appServer", status: { type: "idle" }, model: p.model ?? "default-model", modelProvider: p.modelProvider ?? homeConfig().config.model_provider ?? "openai", config: p.config, historyMode: "paginated", turns: [] };
      threads.set(id, thread);
      takeWriter(id);
      follow(id, socket);
      if (!process.env.FAKE_ENGINE_LAZY_PERSIST) persist();
      reply({ thread, model: thread.model, modelProvider: thread.modelProvider, approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
      return notify("thread/started", { thread });
    }
    // A copy of the chat (up to `lastTurnId` when given), as the engine makes for a fork or a kept earlier version.
    case "thread/fork": {
      const source = threads.get(threadId());
      if (!source) return send({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } }, socket);
      const cut = p.lastTurnId ? source.turns.findIndex(turn => turn.id === p.lastTurnId) : -1;
      if (p.lastTurnId && cut < 0) return send({ id: msg.id, error: { code: -32600, message: `lastTurnId ${p.lastTurnId} was not found` } }, socket);
      const id = randomUUID();
      const thread = { ...structuredClone(source), id, name: undefined, status: { type: "idle" }, model: p.model ?? source.model, turns: structuredClone(cut < 0 ? source.turns : source.turns.slice(0, cut + 1)) };
      threads.set(id, thread);
      takeWriter(id);
      follow(id, socket);
      persist();
      reply({ thread, model: thread.model, modelProvider: thread.modelProvider, approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
      return notify("thread/started", { thread });
    }
    case "thread/archive": { const thread = p.threadId === undefined ? undefined : threads.get(p.threadId); if (thread) thread.archived = true; persist(); return reply({}); }
    case "thread/delete": if (p.threadId !== undefined) threads.delete(p.threadId); persist(); return reply({});
    case "thread/name/set": currentThread().name = p.name; return reply({});
    case "thread/list": return reply({ data: [...threads.values()].filter(thread => !thread.archived === !p.archived), nextCursor: null });
    case "thread/resume": {
      const id = threadId();
      if (!threads.has(id)) return send({ id: msg.id, error: { code: -32600, message: `thread not loaded: ${p.threadId}` } }, socket);
      const conflict = takeWriter(id);
      if (conflict) return send({ id: msg.id, error: { code: -32600, message: conflict } }, socket);
      currentThread().status = { type: "idle" };
      follow(id, socket);
      return reply({ thread: threads.get(id) });
    }
    case "thread/read": {
      if (!threads.has(threadId())) return send({ id: msg.id, error: { code: -32600, message: `thread not loaded: ${p.threadId}` } }, socket);
      if (p.includeTurns && process.env.FAKE_ENGINE_FAIL_MATERIALIZE) return error("persistence refused");
      if (p.includeTurns) persist();
      return reply({ thread: threads.get(threadId()) });
    }
    case "thread/turns/list": return reply({ data: currentThread().turns, nextCursor: null });
    case "thread/items/list": return reply({ data: [], nextCursor: null });
    case "thread/unsubscribe": follow(threadId(), socket, false); return reply({});
    // A provider chat's effort stays with the bridge; the engine only acknowledges the request.
    case "thread/settings/update": return reply({});
    case "turn/steer": {
      const turn = p.expectedTurnId === undefined ? undefined : turns.get(p.expectedTurnId);
      if (!turn) return error("no running turn");
      reply({ turnId: p.expectedTurnId });
      assert.ok(p.input);
      return turn.steer(p.input.map(c => c.text).join("\n"));
    }
    case "turn/start": {
      if (!threads.has(threadId())) return send({ id: msg.id, error: { code: -32600, message: "no such thread" } });
      const turn = { id: `turn-${randomUUID()}`, status: "inProgress", items: [] };
      reply({ turn });
      const text = (p.input ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      runTurn(threadId(), turn, text);
      return;
    }
    case "turn/interrupt": { if (p.turnId !== undefined) turns.get(p.turnId)?.interrupt(); return reply({}); }
    default: return error(`fake engine: ${msg.method}`);
  }
}
