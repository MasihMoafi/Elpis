#!/usr/bin/env node
// Elpis as an ACP agent (Agent Client Protocol v1, https://agentclientprotocol.com) over stdio, for any ACP client:
// Elpis's own agent graphs (apps/elpis-desktop/bridge/acp-nodes.mjs), editors, or another agent.
//   elpis acp --model gpt-6-luna [--provider openai]          (elpis-wrapper)
//   node elpis-acp-agent.mjs --model gpt-6-luna [--provider openai]
// Each ACP session is one Elpis thread on the running shared bridge, or a private app-server when none exists,
// with the session id being
// the thread id, so it stays in Elpis history. Turns stream as session updates; the engine's approval requests become
// session/request_permission (allow once, allow for the session, reject, as `fx acp` offers); session/cancel
// interrupts the turn. Instructions come from session/new `_meta.systemPrompt.append`, the convention
// claude-agent-acp and agy-acp.mjs read. Client MCP servers are thread-local configuration overrides.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { redactSecrets } from "./log-redaction.mjs";
import { runtimeDir } from "./shared-runtime.mjs";
import WebSocket from "ws";

const VERSION = "0.1.0";
const USAGE = "usage: elpis acp [--model MODEL] [--provider PROVIDER]";
let options;
try { options = parseArgs({ options: { model: { type: "string" }, provider: { type: "string" } } }).values; }
catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); process.exit(2); }
const ENGINE = process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;
// GPT models run on the OpenAI sign-in unless a provider is named; otherwise the thread would inherit the
// configured default provider (e.g. Claude credits), which cannot serve them.
const provider = options.provider ?? (/^gpt-/.test(options.model ?? "") ? "openai" : undefined);

// The options every permission request offers, and the engine decision each one means. A cancelled request (the
// client cancelled the turn) is `cancel`, which also interrupts the turn; anything unknown is `decline`.
const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];
const DECISIONS = { allow_once: "accept", allow_always: "acceptForSession", reject_once: "decline" };
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
const cut = (s) => (s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s);

function bridgeEndpoint() {
  const explicit = process.env.ELPIS_APP_BRIDGE_SOCKET || process.env.ELPIS_BRIDGE_SOCKET;
  const url = process.env.ELPIS_BRIDGE_URL;
  if (!explicit && url && !url.startsWith("unix://")) return url;
  const socket = (explicit || url || runtimeDir().sock).replace(/^unix:\/\//, "");
  let stat;
  try { stat = fs.lstatSync(socket); }
  catch (error) { if (!explicit && !url && error.code === "ENOENT") return null; throw error; }
  if (!path.isAbsolute(socket) || !stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("The Elpis bridge socket must be private and owned by the current user");
  }
  return `ws+unix://${socket}:/`;
}

// The shared bridge's JSON-RPC connection, or one private stdio app-server.
class Engine {
  constructor(bin, endpoint) {
    this.pending = new Map();
    this.seq = 0;
    this.tail = "";
    this.dead = null;
    this.stopping = false;
    this.onMessage = () => {};
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    if (endpoint) {
      this.socket = new WebSocket(endpoint, { maxPayload: 8 * 1024 * 1024 });
      this.opened = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.socket.terminate(); reject(new Error("Elpis bridge connection timed out")); }, 10000);
        this.socket.once("open", () => { clearTimeout(timer); resolve(); });
        this.socket.once("error", error => { clearTimeout(timer); reject(error); });
        this.socket.once("close", () => { clearTimeout(timer); reject(new Error("Elpis bridge connection closed")); });
      });
      this.socket.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        this.receive(msg);
      });
      this.socket.on("close", () => this.end("connection closed"));
      return;
    }
    this.opened = Promise.resolve();
    this.child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (d) => { this.tail = (this.tail + d).slice(-2000); });
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.receive(msg);
      }
    });
    this.child.once("error", (e) => this.end(`could not start (${e.message}). Is Elpis installed at ${bin}?`));
    // 'close' comes after the last output was read, so an answer already written is not lost.
    this.child.once("close", (code, signal) => this.end(`exited (${signal ?? code})`));
  }
  receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) msg.error ? p.reject(new RequestError(-32603, msg.error.message ?? "The Elpis engine refused the request")) : p.resolve(msg.result);
    } else this.onMessage(msg);
  }
  end(why) {
    if (this.dead) return;
    const tail = redactSecrets(this.tail.trim()).slice(-500);
    this.dead = new RequestError(-32603, `The Elpis engine ${why}${tail ? `: ${tail}` : ""}`);
    for (const p of this.pending.values()) p.reject(this.dead);
    this.pending.clear();
    this.resolveExit(this.dead);
  }
  write(msg) {
    if (this.dead) return;
    if (this.socket) this.socket.send(JSON.stringify(msg));
    else this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  call(method, params) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = `acp-${++this.seq}`;
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method, params) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  refuse(id, message) { this.write({ id, error: { code: -32601, message } }); }
  async stop() {
    this.stopping = true;
    if (this.socket) { this.socket.close(); await this.exited; return; }
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1000);
    const hard = setTimeout(() => this.child.kill("SIGKILL"), 4000);
    await this.exited;
    clearTimeout(timer); clearTimeout(hard);
  }
}

const sessions = new Map(); // ACP session id = Elpis thread id -> session state
let engine = null;
let ready = null;

async function startEngine() {
  engine = new Engine(ENGINE, bridgeEndpoint());
  engine.onMessage = onEngineMessage;
  engine.exited.then((error) => {
    if (engine.stopping) return;
    // Nothing more can run: every running prompt fails, then the agent exits with an error.
    for (const s of sessions.values()) s.turn?.fail(error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200);
  });
  await engine.opened;
  return engine.call("initialize", { clientInfo: { name: "elpis-acp", title: "Elpis ACP agent", version: VERSION }, capabilities: { experimentalApi: true } })
    .then(() => engine.notify("initialized", {}));
}
async function engineReady() {
  if (!ready) throw RequestError.invalidRequest(undefined, "Call initialize first");
  await ready;
  if (engine.dead) throw engine.dead;
}

const update = (s, u) => connection.client.notify("session/update", { sessionId: s.id, update: u }).catch(() => {});

// The engine's tool items as ACP tool calls.
function toolOf(item) {
  switch (item.type) {
    case "commandExecution": return { title: item.command || "Run a command", kind: "execute", rawInput: { command: item.command, cwd: item.cwd } };
    case "fileChange": return { title: `Edit ${(item.changes ?? []).map((c) => c.path).join(", ") || "files"}`, kind: "edit", locations: (item.changes ?? []).map((c) => ({ path: c.path })) };
    case "mcpToolCall": return { title: `${item.server}: ${item.tool}`, kind: "other", rawInput: item.arguments };
    case "dynamicToolCall": return { title: item.tool, kind: "other", rawInput: item.arguments };
    case "webSearch": return { title: `Search: ${item.query ?? ""}`.trim(), kind: "fetch" };
    default: return null;
  }
}
function showTool(s, id, tool, status, extra = {}) {
  if (s.announced.has(id)) return update(s, { sessionUpdate: "tool_call_update", toolCallId: id, status, ...extra });
  s.announced.add(id);
  return update(s, { sessionUpdate: "tool_call", toolCallId: id, status, ...tool, ...extra });
}
function chunk(s, itemId, text) {
  if (!text) return;
  s.streamed.set(itemId, (s.streamed.get(itemId) ?? "") + text);
  const phase = s.phases.get(itemId);
  update(s, { sessionUpdate: "agent_message_chunk", messageId: itemId, content: { type: "text", text }, ...(phase ? { _meta: { elpis: { phase } } } : {}) });
}
function interrupt(s) {
  const turn = s.turn;
  if (!turn?.id || turn.interrupting) return;
  turn.interrupting = true;
  engine.call("turn/interrupt", { threadId: s.id, turnId: turn.id }).catch(() => {});
}

function onEngineMessage(msg) {
  const p = msg.params ?? {};
  const s = sessions.get(p.threadId);
  if (msg.id !== undefined) {
    if (s && APPROVALS.has(msg.method)) return void approve(s, msg);
    return engine.refuse(msg.id, `${msg.method} is not supported by the Elpis ACP agent`);
  }
  if (!s) return;
  switch (msg.method) {
    case "turn/started":
      if (s.turn) { s.turn.id ??= p.turn?.id; if (s.turn.cancelled) interrupt(s); }
      return;
    case "turn/completed": return s.turn?.finish(p.turn ?? {});
    case "item/agentMessage/delta": return chunk(s, p.itemId, p.delta);
    case "item/reasoning/summaryTextDelta":
      if (p.delta) update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: p.delta } });
      return;
    case "turn/plan/updated":
      update(s, { sessionUpdate: "plan", entries: (p.plan ?? []).map((e) => ({ content: e.step, priority: "medium", status: e.status === "inProgress" ? "in_progress" : e.status === "completed" ? "completed" : "pending" })) });
      return;
    case "item/started": {
      const item = p.item ?? {};
      if (item.type === "agentMessage") { s.phases.set(item.id, item.phase ?? null); return; }
      const tool = toolOf(item);
      if (tool) showTool(s, item.id, tool, "in_progress");
      return;
    }
    case "item/completed": {
      const item = p.item ?? {};
      if (item.type === "agentMessage") {
        if (item.phase && !s.phases.get(item.id)) s.phases.set(item.id, item.phase);
        // A message that did not stream (or not all of it) is sent whole.
        const sent = s.streamed.get(item.id) ?? "";
        if (typeof item.text === "string" && item.text.length > sent.length && item.text.startsWith(sent)) chunk(s, item.id, item.text.slice(sent.length));
        return;
      }
      const tool = toolOf(item);
      if (!tool) return;
      const output = item.type === "commandExecution" && item.aggregatedOutput ? [{ type: "content", content: { type: "text", text: cut(item.aggregatedOutput) } }] : undefined;
      showTool(s, item.id, tool, item.status === "completed" ? "completed" : "failed", {
        ...(output ? { content: output } : {}),
        ...(item.type === "commandExecution" ? { rawOutput: { exitCode: item.exitCode ?? null, status: item.status } } : {}),
      });
      return;
    }
  }
}

// An engine approval request, asked of the ACP client. The tool call is announced (pending) first.
async function approve(s, msg) {
  const p = msg.params ?? {};
  const id = p.itemId;
  const tool = msg.method === "item/commandExecution/requestApproval"
    ? { title: p.command || "Run a command", kind: "execute", rawInput: { command: p.command, cwd: p.cwd, ...(p.reason ? { reason: p.reason } : {}) } }
    : { title: `Edit files${p.reason ? `: ${p.reason}` : ""}`, kind: "edit", rawInput: { reason: p.reason ?? null, grantRoot: p.grantRoot ?? null } };
  showTool(s, id, tool, "pending");
  let decision = "cancel";
  if (!s.turn?.cancelled) {
    try {
      const answer = await connection.client.request("session/request_permission", { sessionId: s.id, toolCall: { toolCallId: id, status: "pending", ...tool }, options: OPTIONS });
      decision = answer?.outcome?.outcome === "selected" ? DECISIONS[answer.outcome.optionId] ?? "decline" : "cancel";
    } catch { decision = "decline"; }
  }
  engine.respond(msg.id, { decision });
  if (!["accept", "acceptForSession"].includes(decision)) showTool(s, id, tool, "failed");
}

// ACP prompt content as the engine's text input. Images and audio are not offered (promptCapabilities).
function promptText(blocks) {
  return (blocks ?? []).map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "resource_link") return `[${b.name ?? b.uri}](${b.uri})`;
    if (b.type === "resource" && typeof b.resource?.text === "string") return `${b.resource.uri}:\n${b.resource.text}`;
    return "";
  }).filter(Boolean).join("\n\n");
}

/** Workflows supplies scoped execution policy through ACP metadata; Love Spot keeps its ordinary session policy. */
function workflowPolicy(value, cwd) {
  if (value === undefined) return null;
  if (!value || !['implement', 'fix', 'verify', 'explore'].includes(value.kind) || !Array.isArray(value.writeScopes)) throw RequestError.invalidParams(undefined, "Invalid workflow policy");
  const writes = ['implement', 'fix'].includes(value.kind), roots = [];
  // Writers need a folder; a check or an explorer may have one for its report.
  if (writes && !value.writeScopes.length) throw RequestError.invalidParams(undefined, "Invalid workflow write scopes");
  const base = fs.realpathSync(cwd);
  for (const scope of value.writeScopes) {
    if (typeof scope !== 'string' || path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw RequestError.invalidParams(undefined, "Invalid workflow write scope");
    const root = fs.realpathSync(path.join(base, scope));
    if (root !== base && !root.startsWith(`${base}${path.sep}`) || !fs.statSync(root).isDirectory()) throw RequestError.invalidParams(undefined, "Workflow write scope must be a project folder");
    roots.push(root);
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !/^[a-z]{2,16}$/.test(value.reasoningEffort))) throw RequestError.invalidParams(undefined, "Invalid workflow reasoning effort");
  return { profile: { extends: ':read-only', filesystem: { '/': 'read', ...Object.fromEntries(roots.map(root => [root, 'write'])) }, network: { enabled: false } },
    turn: { permissions: 'elpis-workflow', ...(value.reasoningEffort ? { effort: value.reasoningEffort } : {}) } };
}

function mcpConfig(servers = []) {
  const config = Object.create(null);
  for (const server of servers) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(server.name) || Object.hasOwn(config, `mcp_servers.${server.name}`)) {
      throw RequestError.invalidParams(undefined, "MCP server names must be unique and contain only letters, numbers, underscores or hyphens");
    }
    let value;
    if (!server.type || server.type === "stdio") value = { command: server.command, args: server.args ?? [], env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) };
    else if (server.type === "http") value = { url: server.url, http_headers: Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value])) };
    else throw RequestError.invalidParams(undefined, `Unsupported MCP transport: ${server.type}`);
    config[`mcp_servers.${server.name}`] = value;
  }
  return config;
}

async function steer(s, prompt) {
  const turn = s.turn;
  if (!turn) return { outcome: "promptRequired", reason: "noRunningTurn" };
  const started = await turn.started;
  turn.id ??= started?.turn?.id ?? null;
  if (s.turn !== turn || turn.cancelled) return { outcome: "promptRequired", reason: "noRunningTurn" };
  await engine.call("turn/steer", { threadId: s.id, expectedTurnId: turn.id, input: [{ type: "text", text: promptText(prompt), text_elements: [] }] });
  return { outcome: "queued", _meta: { delivery: "currentTurn" } };
}

const app = agent({ name: "elpis" })
  .onRequest("initialize", async () => {
    ready ??= startEngine().catch(error => { throw new RequestError(-32603, `Could not connect to the Elpis engine: ${redactSecrets(error.message)}`); });
    await engineReady();
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false }, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
      agentInfo: { name: "elpis", title: "Elpis", version: VERSION },
      authMethods: [],
    };
  })
  .onRequest("session/new", async ({ params }) => {
    await engineReady();
    if (!path.isAbsolute(params.cwd)) throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    const append = params._meta?.systemPrompt?.append;
    const ephemeral = params._meta?.elpis?.ephemeral === true;
    const policy = workflowPolicy(params._meta?.elpis?.workflow, params.cwd);
    const config = mcpConfig(params.mcpServers);
    const started = await engine.call("thread/start", {
      cwd: params.cwd,
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(provider ? { modelProvider: provider } : {}),
      approvalPolicy: "on-request", ...(policy ? { permissions: "elpis-workflow" } : { sandbox: "workspace-write" }),
      ...(policy || Object.keys(config).length ? { config: { ...config, ...(policy ? { "permissions.elpis-workflow": policy.profile } : {}) } } : {}),
      ...(typeof append === "string" && append.trim() ? { developerInstructions: append } : {}),
    });
    const id = started?.thread?.id;
    if (typeof id !== "string") throw new RequestError(-32603, "The Elpis engine did not start a thread");
    sessions.set(id, { id, policy, turn: null, announced: new Set(), phases: new Map(), streamed: new Map() });
    const name = params._meta?.elpis?.name;
    if (!ephemeral && typeof name === "string" && name.trim()) await engine.call("thread/name/set", { threadId: id, name: name.trim().slice(0, 120) }).catch(() => {});
    return { sessionId: id };
  })
  .onRequest("session/prompt", async ({ params }) => {
    await engineReady();
    const s = sessions.get(params.sessionId);
    if (!s) throw RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    if (s.turn) {
      const turn = s.turn;
      const delivered = await steer(s, params.prompt);
      if (delivered.outcome !== "queued") throw RequestError.invalidRequest(undefined, "The turn ended before the steer arrived; send a new prompt");
      return turn.result;
    }
    const turn = s.turn = { id: null, cancelled: false, interrupting: false };
    const done = new Promise((resolve, reject) => { turn.finish = resolve; turn.fail = reject; });
    done.catch(() => {});
    const result = ended => {
      if (ended.status === "failed") throw new RequestError(-32603, ended.error?.message ?? "The Elpis turn failed");
      return { stopReason: turn.cancelled || ended.status === "interrupted" ? "cancelled" : "end_turn" };
    };
    turn.result = done.then(result);
    turn.result.catch(() => {});
    try {
      turn.started = engine.call("turn/start", { threadId: s.id, ...(s.policy?.turn ?? {}), input: [{ type: "text", text: promptText(params.prompt), text_elements: [] }] });
      const started = await turn.started;
      turn.id ??= started?.turn?.id ?? null;
      if (turn.cancelled) interrupt(s);
      return await turn.result;
    } catch (error) { turn.fail(error); throw error; }
    finally { if (s.turn === turn) s.turn = null; }
  })
  .onRequest("_session/steering", params => params, async ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    return steer(s, params.prompt);
  })
  .onNotification("session/cancel", ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s?.turn) return;
    s.turn.cancelled = true;
    interrupt(s);
  });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
// The client closed the connection (stdin ended): stop the engine and leave.
connection.closed.then(async () => {
  if (engine?.socket && !engine.dead) {
    for (const s of sessions.values()) {
      if (s.turn) { s.turn.cancelled = true; interrupt(s); }
      await engine.call("thread/unsubscribe", { threadId: s.id }).catch(() => {});
    }
  }
  if (engine && !engine.dead) await engine.stop();
  process.exit(process.exitCode ?? 0);
});
