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

async function claudeLimits() {
  const { readFile } = await import("node:fs/promises");
  const creds = JSON.parse(await readFile(`${HOME}/.claude/.credentials.json`, "utf8")).claudeAiOauth;
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Claude usage request failed (HTTP ${r.status})`);
  const u = await r.json();
  const win = (w, mins) => w ? { usedPercent: Math.round(w.utilization ?? 0), windowDurationMins: mins, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null } : null;
  return { limitId: "codex", limitName: "Claude", normalModelSlug: null, primary: win(u.five_hour, 300), secondary: win(u.seven_day, 10080), credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null };
}

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
  const claudeModel = new Map();
  const claudeEffort = new Map();
  const sessionModel = new Map();
  const tokenSums = new Map();
  const lastContext = new Map();
  const usageBreakdown = (u) => ({ totalTokens: u.total ?? 0, inputTokens: u.input ?? 0, cachedInputTokens: u.cachedRead ?? 0, cacheWriteInputTokens: u.cachedWrite ?? 0, outputTokens: u.output ?? 0, reasoningOutputTokens: 0 });
  const sendUsage = (threadId, turnId, last) => {
    const sum = tokenSums.get(threadId) ?? {};
    const ctx = lastContext.get(threadId) ?? {};
    const lastB = usageBreakdown(last ?? {});
    if (typeof ctx.used === "number") lastB.totalTokens = ctx.used;
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usageBreakdown(sum), last: lastB, modelContextWindow: ctx.size ?? null } });
  };
  const isClaude = (m) => typeof m === "string" && m.startsWith("claude/");
  const ensureAcp = async () => { if (!acp || acp.dead) { acp = new Acp(); await acp.ready; log("acp ready"); } return acp; };
  const catalog = (async () => {
    try {
      const a = await ensureAcp();
      const s = await a.call("session/new", { cwd: process.cwd(), mcpServers: [] });
      const opt = (id) => (s.configOptions ?? []).find((o) => o.id === id);
      a.call("session/delete", { sessionId: s.sessionId }).catch(() => {});
      return { models: opt("model")?.options ?? [], efforts: opt("effort")?.options ?? [] };
    } catch (e) { log(`claude catalog: ${e.message}`); return { models: [], efforts: [] }; }
  })();
  const pendingModelList = new Set();
  let active = null;
  let reqSeq = 0;

  lineReader(engine.stdout, async (line) => {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed?.method === "thread/settings/updated" && claudeModel.has(parsed.params?.threadId)) {
      const tid = parsed.params.threadId;
      parsed.params.threadSettings = { ...parsed.params.threadSettings, model: claudeModel.get(tid), effort: claudeEffort.get(tid) ?? parsed.params.threadSettings?.effort ?? null };
      ws.send(JSON.stringify(parsed));
      return;
    }
    if (parsed && pendingModelList.has(parsed.id) && Array.isArray(parsed.result?.data)) {
      pendingModelList.delete(parsed.id);
      const { models, efforts } = await Promise.race([catalog, new Promise((r) => setTimeout(() => r({ models: [], efforts: [] }), 15000))]);
      const tpl = parsed.result.data[0] ?? {};
      const added = [];
      const levels = efforts.length ? efforts.map((e) => ({ reasoningEffort: e.value, description: e.name })) : tpl.supportedReasoningEfforts;
      for (const m of models.filter((m) => m.value !== "default")) {
        const id = `claude/${m.value}`;
        added.push({ ...tpl, id, model: id, displayName: `${m.name} (Claude subscription)`, description: m.description ?? "Claude Code on your Pro/Max plan", hidden: false, isDefault: false, upgrade: null, upgradeInfo: null, supportedReasoningEfforts: levels, defaultReasoningEffort: levels?.[levels.length - 1]?.reasoningEffort ?? tpl.defaultReasoningEffort });
      }
      parsed.result.data.unshift(...added);
      log(`model/list: added ${added.length} Claude models`);
      ws.send(JSON.stringify(parsed));
      return;
    }
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
    notify("turn/costUpdated", { threadId, turnId, cost: { type: "unavailable", reason: "subscriptionAuthentication" } });
    const t0 = now();
    let firstTokenAt = null;
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
      await ensureAcp();
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
      const want = claudeModel.get(threadId)?.slice("claude/".length);
      if (want && sessionModel.get(sessionId) !== want) {
        await acp.call("session/set_config_option", { sessionId, configId: "model", value: want });
        sessionModel.set(sessionId, want);
        log(`session ${sessionId} model -> ${want}`);
      }
      const effort = claudeEffort.get(threadId);
      if (effort) await acp.call("session/set_config_option", { sessionId, configId: "effort", value: effort }).catch((e) => log(`effort ${effort}: ${e.message}`));
      active = { threadId, turnId, sessionId };
      acp.onUpdate = ({ update: u }) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          if (!message) {
            message = { type: "agentMessage", id: `msg_${randomUUID()}`, text: "", phase: null, memoryCitation: null, delivery: null, questions: null };
            notify("item/started", { item: message, threadId, turnId, startedAtMs: now() });
          }
          message.text += u.content.text;
          firstTokenAt ??= now();
          notify("item/agentMessage/delta", { threadId, turnId, itemId: message.id, delta: u.content.text });
        } else if (u.sessionUpdate === "usage_update" && typeof u.used === "number") {
          lastContext.set(threadId, { used: u.used, size: u.size ?? null });
          sendUsage(threadId, turnId, null);
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
      const tu = result.usage;
      if (tu) {
        const turnUsage = { input: tu.inputTokens ?? 0, output: tu.outputTokens ?? 0, cachedRead: tu.cachedReadTokens ?? 0, cachedWrite: tu.cachedWriteTokens ?? 0, total: tu.totalTokens ?? 0 };
        const sum = tokenSums.get(threadId) ?? { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, total: 0 };
        for (const k of Object.keys(sum)) sum[k] += turnUsage[k];
        tokenSums.set(threadId, sum);
        sendUsage(threadId, turnId, turnUsage);
      }
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
    notify("turn/activityUpdated", { threadId, turnId, status: status === "inProgress" ? "completed" : status, durationMs: now() - t0, timeToFirstTokenMs: firstTokenAt ? firstTokenAt - t0 : null });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    claudeLimits().then((rateLimits) => { log(`claude limits: 5h ${rateLimits.primary?.usedPercent}% week ${rateLimits.secondary?.usedPercent}%`); notify("account/rateLimits/updated", { rateLimits }); })
      .catch((e) => log(`claude limits: ${e.message}`));
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
    if (process.env.ACP_BRIDGE_DEBUG && msg.method && !/^thread\/(read|turns\/list|list|loaded)/.test(msg.method)) log(`tui-> ${line.slice(0, 600)}`);
    if (msg.method === "thread/start") startPolicy.set(msg.id, msg.params?.approvalPolicy ?? null);
    if (msg.method === "model/list") pendingModelList.add(msg.id);
    if (msg.method === "thread/settings/update") {
      const p = msg.params ?? {};
      if (isClaude(p.model)) { claudeModel.set(p.threadId, p.model); p.model = null; log(`thread ${p.threadId} -> ${claudeModel.get(p.threadId)}`); }
      else if (typeof p.model === "string") claudeModel.delete(p.threadId);
      if (p.effort && claudeModel.has(p.threadId)) { claudeEffort.set(p.threadId, p.effort); p.effort = null; }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "config/batchWrite" && Array.isArray(msg.params?.edits)) {
      const claudePick = msg.params.edits.some((e) => e.keyPath === "model" && isClaude(e.value));
      if (claudePick) msg.params.edits = msg.params.edits.filter((e) => e.keyPath !== "model" && e.keyPath !== "model_reasoning_effort");
      if (claudePick && msg.params.edits.length === 0) { toTui({ id: msg.id, result: { status: "ok", version: "elpis-claude", filePath: `${HOME}/.elpis-next/config.toml`, overriddenMetadata: null } }); return; }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "turn/start") {
      const tid = msg.params?.threadId;
      if (isClaude(msg.params?.model)) claudeModel.set(tid, msg.params.model);
      if (claudeModel.has(tid) && !String(msg.id).startsWith("temporary-structured-turn")) {
        log(`claude turn for thread ${tid} (${claudeModel.get(tid)})`);
        claudeTurn(msg);
        return;
      }
      if (isClaude(msg.params?.model)) msg.params.model = null;
      engine.stdin.write(JSON.stringify(msg) + "\n");
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
