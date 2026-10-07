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
const AGENTS_MCP = new URL("./elpis-agents-mcp.mjs", import.meta.url).pathname;
const mcpServersFor = () => process.env.ACP_BRIDGE_NO_AGENTS ? [] : [{
  name: "elpis-agents", command: process.execPath, args: [AGENTS_MCP],
  env: [{ name: "ELPIS_ENGINE_BIN", value: process.env.ELPIS_ENGINE_BIN ?? `${HOME}/.local/bin/elpis` }],
}];
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
async function toAcpPrompt(input) {
  const { readFile } = await import("node:fs/promises");
  const out = [];
  for (const c of input) {
    if (c.type === "text") out.push({ type: "text", text: c.text });
    else if (c.type === "localImage" && c.path) {
      const mimeType = MIME[c.path.split(".").pop().toLowerCase()] ?? "image/png";
      try { out.push({ type: "image", data: (await readFile(c.path)).toString("base64"), mimeType }); }
      catch (e) { out.push({ type: "text", text: `[image ${c.path} could not be read: ${e.message}]` }); }
    } else if (c.type === "image" && typeof c.url === "string") {
      const m = c.url.match(/^data:([^;,]+);base64,(.*)$/s);
      if (m) out.push({ type: "image", data: m[2], mimeType: m[1] });
      else if (/^https?:/.test(c.url)) out.push({ type: "image", uri: c.url });
    } else if (c.type === "mention" && c.path) out.push({ type: "text", text: `[The user referenced ${c.name ?? "a file"}: ${c.path}]` });
    else if (c.type === "skill" && c.path) out.push({ type: "text", text: `[Use the skill "${c.name}" described in ${c.path}]` });
  }
  return out;
}
const inputSummary = (input) => input.map((c) => c.type === "text" ? c.text : c.type === "localImage" ? `[image: ${c.path}]` : c.type === "image" ? "[image]" : c.path ? `[${c.type}: ${c.path}]` : "").filter(Boolean).join("\n");
const STORE = process.env.ACP_BRIDGE_STORE ?? `${HOME}/.elpis-next/elpis-claude/sessions.json`;
async function loadStore() { try { const { readFile } = await import("node:fs/promises"); return JSON.parse(await readFile(STORE, "utf8")); } catch { return {}; } }
let storeChain = Promise.resolve();
function updateStore(fn) {
  storeChain = storeChain.then(async () => { const st = await loadStore(); fn(st); await saveStore(st); }).catch((e) => log(`store: ${e.message}`));
  return storeChain;
}
async function saveStore(store) {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  await mkdir(STORE.slice(0, STORE.lastIndexOf("/")), { recursive: true });
  await writeFile(`${STORE}.tmp`, JSON.stringify(store, null, 1)); await rename(`${STORE}.tmp`, STORE);
}

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
  const engine = spawn(process.env.ELPIS_ENGINE_BIN ?? `${HOME}/.local/bin/elpis`, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const threadCwd = new Map();
  const threadPolicy = new Map();
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
  const pendingResume = new Set();
  const pendingTurnsList = new Map();
  const pendingItemsList = new Map();
  const engineReqs = new Map();
  let engineSeq = 0;
  const engineCall = (method, params) => new Promise((resolve, reject) => {
    const id = `acp-bridge-engine-${++engineSeq}`;
    engineReqs.set(id, { resolve, reject });
    engine.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const textOf = (content) => (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  async function elpisInstructions(threadId) {
    try {
      const r = await engineCall("thread/elpisInstructions/read", { threadId });
      const parts = [];
      if (r.developerInstructions?.trim()) parts.push(r.developerInstructions.trim());
      if (r.agentsMd?.trim()) parts.push(`# Project and global instructions admitted by Elpis (AGENTS.md)\n\n${r.agentsMd.trim()}`);
      if (r.continuity?.trim()) parts.push(r.continuity.trim());
      return parts.join("\n\n");
    } catch (e) { log(`elpis instructions for ${threadId}: ${e.message ?? JSON.stringify(e)}`); return ""; }
  }
  async function priorTranscript(threadId) {
    try {
      const r = await engineCall("thread/turns/list", { threadId, limit: 30, sortDirection: "desc", itemsView: "full" }).catch(() => ({ data: [] }));
      await storeChain;
      const stored = (await loadStore())[threadId]?.turns ?? [];
      const have = new Set((r.data ?? []).map((t) => t.id));
      const all = [...(r.data ?? []), ...stored.filter((t) => !have.has(t.id))].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const lines = [];
      for (const turn of all) for (const it of turn.items ?? []) {
        if (it.type === "userMessage") lines.push(`User: ${textOf(it.content)}`);
        else if (it.type === "agentMessage" && it.text?.trim()) lines.push(`Assistant: ${it.text.trim()}`);
        else if (it.type === "commandExecution") lines.push(`(Assistant ran: ${it.command})`);
      }
      const t = lines.join("\n\n");
      return t.length > 12000 ? t.slice(-12000) : t;
    } catch (e) { log(`history read for ${threadId}: ${e.message ?? JSON.stringify(e)}`); return ""; }
  }
  let active = null;
  let reqSeq = 0;

  lineReader(engine.stdout, async (line) => {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    const th = parsed?.result?.thread ?? parsed?.params?.thread;
    if (th?.id && th?.cwd) threadCwd.set(th.id, th.cwd);
    if (th?.id && parsed?.result?.approvalPolicy) threadPolicy.set(th.id, parsed.result.approvalPolicy);
    if (parsed && engineReqs.has(parsed.id) && !parsed.method) {
      const p = engineReqs.get(parsed.id); engineReqs.delete(parsed.id);
      parsed.error ? p.reject(parsed.error) : p.resolve(parsed.result);
      return;
    }
    if (parsed && pendingTurnsList.has(parsed.id)) {
      const req = pendingTurnsList.get(parsed.id); pendingTurnsList.delete(parsed.id);
      await storeChain;
      const stored = (await loadStore())[req.threadId]?.turns ?? [];
      if (stored.length && !req.cursor) {
        const data = parsed.result?.data ?? [];
        const have = new Set(data.map((t) => t.id));
        const merged = [...data, ...stored.filter((t) => !have.has(t.id))]
          .map((t) => (req.itemsView === "notLoaded" ? { ...t, items: [], itemsView: "notLoaded" } : t));
        merged.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
        if (req.sortDirection === "desc") merged.reverse();
        parsed.result = { ...(parsed.result ?? {}), data: merged, nextCursor: parsed.result?.nextCursor ?? null, backwardsCursor: parsed.result?.backwardsCursor ?? null };
        delete parsed.error;
        log(`turns/list ${req.threadId}: +${merged.length - data.length} Claude turns`);
        ws.send(JSON.stringify(parsed));
        return;
      }
    }
    if (parsed && pendingItemsList.has(parsed.id)) {
      const req = pendingItemsList.get(parsed.id); pendingItemsList.delete(parsed.id);
      await storeChain;
      const stored = ((await loadStore())[req.threadId]?.turns ?? []).filter((t) => !req.turnId || t.id === req.turnId);
      if (stored.length && !req.cursor) {
        const data = parsed.result?.data ?? [];
        const have = new Set(data.map((e) => e.item?.id));
        const extra = stored.flatMap((t) => t.items.map((item, i) => ({ turnId: t.id, item, startedAtMs: (t.startedAt ?? 0) * 1000 + i, completedAtMs: (t.completedAt ?? t.startedAt ?? 0) * 1000 })))
          .filter((e) => !have.has(e.item.id));
        const merged = [...data, ...extra].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
        if (req.sortDirection === "desc") merged.reverse();
        parsed.result = { ...(parsed.result ?? {}), data: merged, nextCursor: parsed.result?.nextCursor ?? null, backwardsCursor: parsed.result?.backwardsCursor ?? null };
        delete parsed.error;
        log(`items/list ${req.threadId}: +${extra.length} Claude items`);
        ws.send(JSON.stringify(parsed));
        return;
      }
    }
    if (parsed && pendingResume.has(parsed.id) && parsed.result?.thread?.id) {
      pendingResume.delete(parsed.id);
      await storeChain;
      const saved = (await loadStore())[parsed.result.thread.id];
      if (saved?.model) {
        claudeModel.set(parsed.result.thread.id, saved.model);
        if (saved.effort) claudeEffort.set(parsed.result.thread.id, saved.effort);
        parsed.result.model = saved.model;
        if (saved.effort) parsed.result.reasoningEffort = saved.effort;
        log(`resume ${parsed.result.thread.id} -> ${saved.model}`);
        ws.send(JSON.stringify(parsed));
        return;
      }
    }
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
      const mode = ask ? "ask" : "full";
      let live = sessions.get(threadId);
      let sessionId = null;
      let freshSession = false;
      if (live && live.mode === mode) sessionId = live.id;
      else {
        const cwd = threadCwd.get(threadId) ?? process.cwd();
        const instructions = await elpisInstructions(threadId);
        let _meta = ask ? { claudeCode: { options: { settingSources: ["project", "local"] } } } : undefined;
        if (instructions) { _meta = { ...(_meta ?? {}), systemPrompt: { append: instructions } }; log(`Elpis instructions for Claude: ${instructions.length} chars`); }
        await storeChain;
        const store = await loadStore();
        const saved = live?.id ?? store[threadId]?.session ?? Object.values(store[threadId]?.sessions ?? {})[0];
        if (saved) {
          const prev = acp.onUpdate; acp.onUpdate = null;
          try { await acp.call("session/load", { sessionId: saved, cwd, mcpServers: mcpServersFor(), ...(_meta && { _meta }) }); sessionId = saved; log(`session ${saved} reloaded for thread ${threadId}`); }
          catch (e) { log(`session reload failed: ${e.message ?? JSON.stringify(e)}`); }
          acp.onUpdate = prev;
        }
        if (!sessionId) {
          sessionId = (await acp.call("session/new", { cwd, mcpServers: mcpServersFor(), ...(_meta && { _meta }) })).sessionId;
          freshSession = true;
          log(`session ${sessionId} for thread ${threadId} in ${cwd} (${ask ? "Elpis asks" : "full access"}, policy ${policy})`);
        }
        live = { id: sessionId, mode };
        sessions.set(threadId, live);
        const sid = sessionId;
        updateStore((st) => { st[threadId] = { ...st[threadId], session: sid, mode }; });
      }
      updateStore((st) => { st[threadId] = { ...st[threadId], model: claudeModel.get(threadId), effort: claudeEffort.get(threadId) ?? null }; });
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
      const userText = inputSummary(input);
      const prompt = await toAcpPrompt(input);
      if (freshSession) {
        const history = await priorTranscript(threadId);
        if (history) {
          prompt.unshift({ type: "text", text: `This conversation started earlier in Elpis, possibly with another model. Here is the conversation so far, for context:\n\n${history}\n\n--- The user's new message follows. ---` });
          log(`seeded Claude with ${history.length} chars of earlier history`);
        }
      }
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
      closeMessage();
      const reply = items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n\n").trim();
      const used = items.filter((i) => i.type === "commandExecution").map((i) => i.command);
      const record = [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }];
      if (used.length) record.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `[${claudeModel.get(threadId) ?? "Claude"} used tools: ${used.join("; ")}]` }] });
      if (reply) record.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] });
      await engineCall("thread/inject_items", { threadId, items: record })
        .then(() => log(`recorded Claude turn in thread ${threadId} (${record.length} items)`))
        .catch((e) => log(`record failed for ${threadId}: ${e.message ?? JSON.stringify(e)}`));
    } catch (e) {
      status = "failed";
      error = { message: `Claude (ACP) error: ${e?.message ?? JSON.stringify(e)}`, codexErrorInfo: null, additionalDetails: null };
      log(`turn error ${JSON.stringify(e)}`);
    }
    closeMessage();
    active = null;
    const completedAt = Math.floor(now() / 1000);
    {
      const clip = (it) => (it.aggregatedOutput && it.aggregatedOutput.length > 4000 ? { ...it, aggregatedOutput: it.aggregatedOutput.slice(0, 4000) + "\n…" } : it);
      const record = { id: turnId, items: [userItem, ...items.map(clip)], itemsView: "full", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 };
      await updateStore((st) => { st[threadId] = { ...st[threadId], turns: [...(st[threadId]?.turns ?? []), record].slice(-200) }; });
    }
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
    if (process.env.ACP_BRIDGE_DEBUG && msg.method && (process.env.ACP_BRIDGE_DEBUG === "all" || !/^thread\/(read|turns\/list|list|loaded)/.test(msg.method))) log(`tui-> ${line.slice(0, 600)}`);
    if (msg.method === "model/list") pendingModelList.add(msg.id);
    if (msg.method === "thread/resume") pendingResume.add(msg.id);
    if (msg.method === "thread/turns/list" && msg.params?.threadId) pendingTurnsList.set(msg.id, msg.params);
    if (msg.method === "thread/items/list" && msg.params?.threadId) pendingItemsList.set(msg.id, msg.params);
    if (msg.method === "thread/settings/update") {
      const p = msg.params ?? {};
      if (isClaude(p.model)) { claudeModel.set(p.threadId, p.model); p.model = null; log(`thread ${p.threadId} -> ${claudeModel.get(p.threadId)}`); }
      else if (typeof p.model === "string") claudeModel.delete(p.threadId);
      if (p.approvalPolicy) threadPolicy.set(p.threadId, p.approvalPolicy);
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
  ws.on("close", async () => { await storeChain; engine.kill(); acp?.kill(); log("tui disconnected"); });
});
