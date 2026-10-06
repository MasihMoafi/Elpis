// Elpis TUI <-ws-> bridge <-stdio-> real `elpis app-server` (everything else)
//                         \-stdio-> claude-agent-acp (chat turns -> Claude)
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const HOME = process.env.HOME;
const LOG = process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/bridge.log";
const log = (s) => { try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${s}\n`); } catch {} };
const ADAPTER = process.env.ACP_ADAPTER ?? new URL("./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url).pathname;
const CLAUDE = process.env.CLAUDE_CODE_EXECUTABLE ?? `${HOME}/.local/bin/claude`;
const now = () => Date.now();

function lineReader(stream, onLine) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}

class Acp {
  constructor() {
    this.proc = spawn("node", [ADAPTER], { env: { ...process.env, CLAUDE_CODE_EXECUTABLE: CLAUDE }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => log(`acp stderr: ${String(d).trim().slice(0, 300)}`));
    this.nextId = 1;
    this.pending = new Map();
    this.onUpdate = null;
    this.onPermission = null;
    lineReader(this.proc.stdout, (line) => this.#handle(JSON.parse(line)));
    this.proc.on("exit", (code) => {
      this.dead = `the Claude ACP adapter exited (code ${code}). Is it installed at ${ADAPTER}?`;
      for (const p of this.pending.values()) p.reject({ message: this.dead });
      this.pending.clear();
    });
    this.ready = this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  }
  send(msg) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); }
  call(method, params) {
    if (this.dead) return Promise.reject({ message: this.dead });
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  async #handle(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    } else if (msg.method === "session/update") {
      this.onUpdate?.(msg.params);
    } else if (msg.method === "session/request_permission") {
      const optionId = await (this.onPermission ? this.onPermission(msg.params) : null);
      this.send({ id: msg.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
    } else if (msg.id !== undefined) {
      this.send({ id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
    }
  }
  kill() { this.proc.kill(); }
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.PORT ?? 47820) });
wss.on("listening", () => log(`LISTENING ${wss.address().port}`));

wss.on("connection", (ws) => {
  const toTui = (msg) => ws.send(JSON.stringify(msg));
  const notify = (method, params) => toTui({ method, params, emittedAtMs: now() });
  const engine = spawn(`${HOME}/.local/bin/elpis`, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const threadCwd = new Map();
  const threadPolicy = new Map();
  const startPolicy = new Map();
  const sessions = new Map();
  const bridgeRequests = new Map();
  let acp = null;
  let active = null;
  let reqSeq = 0;

  lineReader(engine.stdout, (line) => {
    try {
      const msg = JSON.parse(line);
      const thread = msg.result?.thread ?? msg.params?.thread;
      if (thread?.id && thread?.cwd) threadCwd.set(thread.id, thread.cwd);
      if (thread?.id && startPolicy.has(msg.id)) { threadPolicy.set(thread.id, startPolicy.get(msg.id)); startPolicy.delete(msg.id); }
    } catch {}
    ws.send(line);
  });

  const askTui = (method, params) => new Promise((resolve) => {
    const id = `acp-bridge-${++reqSeq}`;
    bridgeRequests.set(id, resolve);
    toTui({ id, method, params });
  });

  async function claudeTurn(req) {
    const { threadId, input = [] } = req.params;
    const turnId = randomUUID();
    const turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    toTui({ id: req.id, result: { turn } });
    const startedAt = Math.floor(now() / 1000);
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId, turn: { ...turn, startedAt } });
    const userItem = { type: "userMessage", id: randomUUID(), clientId: null, content: input };
    notify("item/started", { item: userItem, threadId, turnId, startedAtMs: now() });
    notify("item/completed", { item: userItem, threadId, turnId, completedAtMs: now() });

    const items = [];
    let message = null;
    const tools = new Map();
    const closeMessage = () => {
      if (!message) return;
      notify("item/completed", { item: message, threadId, turnId, completedAtMs: now() });
      items.push(message);
      message = null;
    };
    let status = "completed";
    let error = null;
    try {
      if (!acp || acp.dead) { acp = new Acp(); await acp.ready; log("acp ready"); }
      const policy = req.params.approvalPolicy ?? threadPolicy.get(threadId) ?? "on-request";
      const ask = policy !== "never";
      const key = `${threadId}|${ask ? "ask" : "full"}`;
      let sessionId = sessions.get(key);
      if (!sessionId) {
        const cwd = threadCwd.get(threadId) ?? process.cwd();
        const _meta = ask ? { claudeCode: { options: { settingSources: ["project", "local"] } } } : undefined;
        sessionId = (await acp.call("session/new", { cwd, mcpServers: [], ...(_meta && { _meta }) })).sessionId;
        sessions.set(key, sessionId);
        log(`session ${sessionId} for thread ${threadId} in ${cwd} (${ask ? "Elpis asks" : "full access"}, policy ${policy})`);
      }
      active = { threadId, turnId, sessionId };
      acp.onUpdate = ({ update: u }) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          if (!message) {
            message = { type: "agentMessage", id: `msg_${randomUUID()}`, text: "", phase: null, memoryCitation: null, delivery: null, questions: null };
            notify("item/started", { item: message, threadId, turnId, startedAtMs: now() });
          }
          message.text += u.content.text;
          notify("item/agentMessage/delta", { threadId, turnId, itemId: message.id, delta: u.content.text });
        } else if (u.sessionUpdate === "tool_call") {
          closeMessage();
          const item = { type: "commandExecution", id: u.toolCallId, pluginId: null, scriptPath: null, command: u.title ?? u.kind ?? "tool", cwd: threadCwd.get(threadId) ?? process.cwd(), processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, started: now() };
          tools.set(u.toolCallId, item);
          const { started, ...shown } = item;
          notify("item/started", { item: shown, threadId, turnId, startedAtMs: started });
        } else if (u.sessionUpdate === "tool_call_update") {
          const item = tools.get(u.toolCallId);
          if (!item) return;
          if (u.title) item.command = u.title;
          const text = (u.content ?? []).map((c) => c.content?.text ?? (c.type === "diff" ? `edited ${c.path}` : "")).filter(Boolean).join("\n");
          if (text) item.aggregatedOutput = text;
          if (u.status === "completed" || u.status === "failed") {
            item.status = u.status === "completed" ? "completed" : "failed";
            item.exitCode = u.status === "completed" ? 0 : 1;
            item.durationMs = now() - item.started;
            const { started, ...shown } = item;
            notify("item/completed", { item: shown, threadId, turnId, completedAtMs: now() });
            items.push(shown);
          }
        }
      };
      acp.onPermission = async (p) => {
        const item = tools.get(p.toolCall?.toolCallId);
        const decision = await askTui("item/commandExecution/requestApproval", {
          kind: "command", threadId, turnId, itemId: p.toolCall?.toolCallId ?? randomUUID(), startedAtMs: now(),
          environmentId: null, reason: `Claude wants to run: ${p.toolCall?.title ?? item?.command ?? "a tool"}`,
          command: p.toolCall?.title ?? item?.command ?? null, cwd: threadCwd.get(threadId) ?? process.cwd(),
        });
        const d = decision?.decision;
        const pick = (kind) => p.options.find((o) => o.kind === kind)?.optionId;
        log(`approval ${p.toolCall?.title} -> ${JSON.stringify(d)}`);
        if (d === "acceptForSession") return pick("allow_always") ?? pick("allow_once");
        if (d === "accept") return pick("allow_once") ?? pick("allow_always");
        if (item) item.status = "declined";
        return pick("reject_once") ?? pick("reject_always") ?? null;
      };
      const prompt = input.filter((c) => c.type === "text").map((c) => ({ type: "text", text: c.text }));
      const result = await acp.call("session/prompt", { sessionId, prompt });
      if (result.stopReason === "cancelled") status = "interrupted";
    } catch (e) {
      status = "failed";
      error = { message: `Claude (ACP) error: ${e?.message ?? JSON.stringify(e)}`, codexErrorInfo: null, additionalDetails: null };
      log(`turn error ${JSON.stringify(e)}`);
    }
    closeMessage();
    active = null;
    const completedAt = Math.floor(now() / 1000);
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
  }

  ws.on("message", (data) => {
    const line = data.toString();
    let msg;
    try { msg = JSON.parse(line); } catch { engine.stdin.write(line + "\n"); return; }
    if (msg.id !== undefined && !msg.method && bridgeRequests.has(msg.id)) {
      bridgeRequests.get(msg.id)(msg.result);
      bridgeRequests.delete(msg.id);
      return;
    }
    if (msg.method === "thread/start") startPolicy.set(msg.id, msg.params?.approvalPolicy ?? null);
    if (msg.method === "turn/start" && !String(msg.id).startsWith("temporary-structured-turn")) {
      log(`claude turn for thread ${msg.params.threadId}`);
      claudeTurn(msg);
      return;
    }
    if (msg.method === "turn/interrupt" && active && msg.params?.threadId === active.threadId) {
      acp.send({ method: "session/cancel", params: { sessionId: active.sessionId } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    engine.stdin.write(line + "\n");
  });
  ws.on("close", () => { engine.kill(); acp?.kill(); log("tui disconnected"); });
});
