// Elpis TUI <-ws-> bridge <-stdio-> real `elpis app-server` (everything else)
//                         \-stdio-> claude-agent-acp (chat turns -> Claude)
import { WebSocketServer } from "ws";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const HOME = process.env.HOME;
const LOG = process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/bridge.log";
const log = (s) => { try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${s}\n`); } catch {} };
const ADAPTER = process.env.ACP_ADAPTER ?? new URL("./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url).pathname;
const CLAUDE = process.env.ELPIS_CLAUDE_PRUNE
  ? new URL("./claude-via-elpis", import.meta.url).pathname
  : process.env.CLAUDE_CODE_EXECUTABLE ?? `${HOME}/.local/bin/claude`;
const now = () => Date.now();
// Elpis's own review rules (codex-rs/prompts), minus its JSON output format, which only the
// engine parses; Claude answers in readable Markdown instead.
const REVIEW_RULES = (() => {
  try {
    const t = readFileSync(new URL("../../codex-rs/prompts/templates/review/rubric.md", import.meta.url), "utf8");
    return t.slice(0, t.indexOf("OUTPUT FORMAT:")).split("\n").filter((l) => !/JSON/.test(l)).join("\n").trim();
  } catch { return "# Review guidelines:\nYou are reviewing a proposed code change. Flag only real, actionable bugs the author would want fixed."; }
})();
const REVIEW_FORMAT = "Report in Markdown. For each finding write its priority as [P0] to [P3], a short title and `path:line`, then one or two sentences on why it is wrong. End with `Overall: correct` or `Overall: incorrect` and one sentence. If nothing is wrong, say so. Do not change any files.";
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

// Claude's tool calls drawn as Elpis's own items: the real command, clean output,
// reads as reads, edits as diffs.
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const unfence = (s) => /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(s)?.[1] ?? s;
const hunks = (patch) => patch.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`).join("");
const wholeDiff = (a, b) => { const o = a.split("\n"), n = b.split("\n"); return `@@ -1,${o.length} +1,${n.length} @@\n${[...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`)].join("\n")}\n`; };
function toolItem(id, t, cwd) {
  const r = t.raw, resp = t.response ?? {};
  const status = t.declined ? "declined" : t.status;
  const path = EDIT_TOOLS.has(t.name) && (resp.filePath ?? r.file_path ?? r.notebook_path ?? t.diffs.at(-1)?.path);
  if (path) {
    const d = t.diffs.at(-1);
    const change = resp.type === "create" || (!resp.structuredPatch && d && !d.oldText)
      ? { path, kind: { type: "add" }, diff: resp.content ?? r.content ?? d?.newText ?? "" }
      : { path, kind: { type: "update", move_path: null }, diff: resp.structuredPatch?.length ? hunks(resp.structuredPatch) : d ? wholeDiff(d.oldText ?? "", d.newText ?? "") : "" };
    return { type: "fileChange", id, changes: [change], status };
  }
  const command = (t.name === "Bash" && r.command) || t.title || t.name || "tool";
  const commandActions = t.name === "Read" && r.file_path ? [{ type: "read", command, name: r.file_path.split("/").pop(), path: r.file_path }]
    : t.name === "Grep" || t.name === "Glob" ? [{ type: "search", command, query: r.pattern ?? null, path: r.path ?? null }]
      : t.name === "LS" ? [{ type: "listFiles", command, path: r.path ?? null }] : [];
  const output = t.name === "Bash" && typeof resp.stdout === "string" ? [resp.stdout, resp.stderr].filter(Boolean).join("\n") : t.text ? unfence(t.text) : null;
  return { type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd, processId: null, source: "agent", status, commandActions, aggregatedOutput: output, exitCode: status === "completed" ? 0 : status === "inProgress" ? null : 1, durationMs: t.end ? t.end - t.start : null };
}
const STORE = process.env.ACP_BRIDGE_STORE ?? `${HOME}/.elpis-next/elpis-claude/sessions.json`;
async function loadStore() { return (await readJson(STORE)) ?? {}; }
let storeChain = Promise.resolve();
function updateStore(fn) {
  storeChain = storeChain.then(async () => { const st = await loadStore(); fn(st); await saveStore(st); }).catch((e) => log(`store: ${e.message}`));
  return storeChain;
}
const CATALOG = `${STORE.slice(0, STORE.lastIndexOf("/"))}/catalog.json`;
async function readJson(path) { try { const { readFile } = await import("node:fs/promises"); return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function writeJson(path, value) {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1)); await rename(`${path}.tmp`, path);
}
async function saveStore(store) { await writeJson(STORE, store); }

async function claudeLimits() {
  const { readFile } = await import("node:fs/promises");
  const creds = JSON.parse(await readFile(`${HOME}/.claude/.credentials.json`, "utf8")).claudeAiOauth;
  const r = await fetch(process.env.ELPIS_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Claude usage request failed (HTTP ${r.status})`);
  const u = await r.json();
  const win = (w, mins) => w ? { usedPercent: Math.round(w.utilization ?? 0), windowDurationMins: mins, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null } : null;
  return { limitId: "codex", limitName: "Claude", normalModelSlug: null, primary: win(u.five_hour, 300), secondary: win(u.seven_day, 10080), credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null };
}

// Anthropic refuses (HTTP 429) when asked after every turn, so ask at most once a minute and
// keep showing the last answer when a request fails.
const limits = { at: 0, value: null, inFlight: null };
function claudeLimitsCached() {
  if (Date.now() - limits.at < 60_000) return limits.value ? Promise.resolve(limits.value) : Promise.reject(new Error("Claude usage unavailable (retrying in a minute)"));
  limits.inFlight ??= claudeLimits()
    .then((v) => { limits.value = v; return v; })
    .catch((e) => { if (limits.value) return limits.value; throw e; })
    .finally(() => { limits.at = Date.now(); limits.inFlight = null; });
  return limits.inFlight;
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
  const threadCollab = new Map();
  const sessionMode = new Map();
  const tokenSums = new Map();
  const ctxChars = new Map();
  const devChars = new Map();
  const addChars = (threadId, part, n) => { const c = ctxChars.get(threadId) ?? { user: 0, agent: 0, reasoning: 0, toolCalls: 0, toolResults: 0 }; c[part] += n ?? 0; ctxChars.set(threadId, c); };
  const attribution = (threadId, used) => {
    const tok = (n) => Math.round((n ?? 0) / 4);
    const c = ctxChars.get(threadId) ?? {};
    const parts = { developerMessages: tok(devChars.get(threadId)), userMessages: tok(c.user), agentMessages: tok(c.agent), reasoning: tok(c.reasoning), toolCalls: tok(c.toolCalls), toolResults: tok(c.toolResults) };
    const known = Object.values(parts).reduce((a, b) => a + b, 0);
    return { systemInstructions: Math.max(0, used - known), ...parts, toolDefinitions: 0, outputSchema: 0, unrecognizedItems: 0, estimatedTotal: used };
  };
  const lastContext = new Map();
  // Anthropic reports cache reads and writes apart from input; Elpis (like OpenAI) counts them as input.
  const usageBreakdown = (u) => {
    const input = (u.input ?? 0) + (u.cachedRead ?? 0) + (u.cachedWrite ?? 0);
    return { totalTokens: input + (u.output ?? 0), inputTokens: input, cachedInputTokens: u.cachedRead ?? 0, cacheWriteInputTokens: u.cachedWrite ?? 0, outputTokens: u.output ?? 0, reasoningOutputTokens: 0 };
  };
  const sendUsage = (threadId, turnId, last) => {
    const sum = tokenSums.get(threadId) ?? {};
    const ctx = lastContext.get(threadId) ?? {};
    const lastB = usageBreakdown(last ?? {});
    if (typeof ctx.used === "number") lastB.totalTokens = ctx.used;
    const contextAttribution = typeof ctx.used === "number" ? attribution(threadId, ctx.used) : undefined;
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usageBreakdown(sum), last: lastB, modelContextWindow: ctx.size ?? null, ...(contextAttribution && { contextAttribution }) } });
  };
  const isClaude = (m) => typeof m === "string" && m.startsWith("claude/");
  const ensureAcp = async () => { if (!acp || acp.dead) { acp = new Acp(); await acp.ready; log("acp ready"); } return acp; };
  // Claude's models and each model's effort levels (Haiku has none). Reading one model's levels
  // means switching a scratch session to it (~4 s each, without touching Claude Code's saved
  // settings), so startup reads only the current model; the rest come from catalog.json and are
  // refreshed in the background at most once a day.
  const catalog = (async () => {
    try {
      const a = await ensureAcp();
      const s = await a.call("session/new", { cwd: process.cwd(), mcpServers: [] });
      const opt = (opts, id) => (opts ?? []).find((o) => o.id === id);
      const levelsOf = (opts) => { const e = opt(opts, "effort"); return e ? { levels: e.options.map((o) => ({ reasoningEffort: o.value, description: o.name })), current: e.currentValue } : { levels: [], current: null }; };
      const models = (opt(s.configOptions, "model")?.options ?? []).filter((m) => m.value !== "default");
      const saved = await readJson(CATALOG);
      const efforts = { ...(saved?.efforts ?? {}) };
      const first = opt(s.configOptions, "model")?.currentValue;
      if (first) efforts[first] = levelsOf(s.configOptions);
      const stale = !saved?.at || now() - saved.at > 86_400_000 || models.some((m) => !efforts[m.value]);
      (async () => {
        if (stale) {
          for (const m of models.filter((m) => m.value !== first)) {
            const r = await a.call("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: m.value }).catch(() => null);
            if (r) efforts[m.value] = levelsOf(r.configOptions);
          }
          await writeJson(CATALOG, { at: now(), efforts });
          log(`claude catalog: effort levels of ${models.length} models saved`);
        }
        await a.call("session/delete", { sessionId: s.sessionId }).catch(() => {});
      })().catch((e) => log(`claude catalog refresh: ${e.message ?? JSON.stringify(e)}`));
      return { models, efforts, fallback: first ? efforts[first] : { levels: [], current: null } };
    } catch (e) { log(`claude catalog: ${e.message}`); return { models: [], efforts: {}, fallback: { levels: [], current: null } }; }
  })();
  const pendingModelList = new Set();
  const pendingResume = new Set();
  // A Claude model picked as the default ("enter default") lives in the bridge's store, not in
  // config.toml, which plain Elpis also reads. New chats, rewinds and the next start follow it.
  const pendingConfigRead = new Set();
  const pendingStart = new Map();
  let engineDefault = null; // asked once, after the TUI has initialized the engine
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
        else if (it.type === "fileChange") lines.push(`(Assistant edited: ${(it.changes ?? []).map((c) => c.path).join(", ")})`);
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
    if (parsed && pendingConfigRead.has(parsed.id)) {
      pendingConfigRead.delete(parsed.id);
      const def = (await loadStore())._default;
      if (def?.model && parsed.result?.config) {
        parsed.result.config = { ...parsed.result.config, model: def.model, model_reasoning_effort: def.effort ?? null };
        ws.send(JSON.stringify(parsed));
        return;
      }
    }
    if (parsed && pendingStart.has(parsed.id)) {
      const pick = pendingStart.get(parsed.id); pendingStart.delete(parsed.id);
      const tid = parsed.result?.thread?.id;
      if (tid && pick?.model) {
        claudeModel.set(tid, pick.model);
        if (pick.effort) claudeEffort.set(tid, pick.effort);
        parsed.result.model = pick.model;
        parsed.result.reasoningEffort = pick.effort ?? null;
        log(`new thread ${tid} -> ${pick.model}`);
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
      const { models, efforts, fallback } = await Promise.race([catalog, new Promise((r) => setTimeout(() => r({ models: [], efforts: {}, fallback: null }), 30000))]);
      const tpl = parsed.result.data[0] ?? {};
      const added = [];
      for (const m of models) {
        const id = `claude/${m.value}`;
        const e = efforts[m.value] ?? { levels: fallback?.levels ?? [], current: "default" };
        added.push({ ...tpl, id, model: id, inputModalities: ["text", "image"], displayName: `${m.name} (Claude subscription)`, description: m.description ?? "Claude Code on your Pro/Max plan", hidden: false, isDefault: false, upgrade: null, upgradeInfo: null, supportedReasoningEfforts: e.levels, defaultReasoningEffort: e.current ?? "default" });
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
    if (req.id !== undefined) toTui({ id: req.id, result: req.kind === "review" ? { turn, reviewThreadId: threadId } : { turn } });
    const compacting = req.kind === "compact";
    const startedAt = Math.floor(now() / 1000);
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId, turn: { ...turn, startedAt } });
    notify("turn/costUpdated", { threadId, turnId, cost: { type: "unavailable", reason: "subscriptionAuthentication" } });
    const t0 = now();
    let firstTokenAt = null;
    const userItem = req.kind === "review"
      ? { type: "enteredReviewMode", id: randomUUID(), review: req.reviewHint }
      : { type: "userMessage", id: randomUUID(), clientId: null, content: input };
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
    // The running turn, from its first moment, so a steer or a stop during setup finds it.
    let sessionReady;
    const turnState = { threadId, turnId, sessionId: null, items, closeMessage, cancelled: false, ready: new Promise((r) => { sessionReady = r; }), toolsIdle: [] };
    // Claude Code takes a steer at once and drops a tool that is still running, so a steer
    // waits for the running tools, as Claude Code's own queue does.
    turnState.whenToolsIdle = () => ([...tools.values()].every((t) => t.end) ? Promise.resolve() : new Promise((r) => turnState.toolsIdle.push(r)));
    active = turnState;
    let status = "completed";
    let error = null;
    const cwd = threadCwd.get(threadId) ?? process.cwd();
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
        devChars.set(threadId, instructions.length);
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
      const wantMode = threadCollab.get(threadId) === "plan" ? "plan" : ask ? "default" : "bypassPermissions";
      if (sessionMode.get(sessionId) !== wantMode) {
        await acp.call("session/set_mode", { sessionId, modeId: wantMode })
          .then(() => { sessionMode.set(sessionId, wantMode); log(`session ${sessionId} mode -> ${wantMode}`); })
          .catch((e) => log(`mode ${wantMode}: ${e.message ?? JSON.stringify(e)}`));
      }
      const effort = claudeEffort.get(threadId);
      const known = (await catalog).efforts[want];
      if (effort && (!known || known.levels.some((l) => l.reasoningEffort === effort))) await acp.call("session/set_config_option", { sessionId, configId: "effort", value: effort }).catch((e) => log(`effort ${effort}: ${e.message}`));
      turnState.sessionId = sessionId;
      sessionReady(sessionId);
      acp.onUpdate = ({ update: u }) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          if (!message) {
            message = { type: "agentMessage", id: `msg_${randomUUID()}`, text: "", phase: null, memoryCitation: null, delivery: null, questions: null };
            notify("item/started", { item: message, threadId, turnId, startedAtMs: now() });
          }
          message.text += u.content.text;
          addChars(threadId, "agent", u.content.text.length);
          firstTokenAt ??= now();
          notify("item/agentMessage/delta", { threadId, turnId, itemId: message.id, delta: u.content.text });
        } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
          addChars(threadId, "reasoning", u.content.text.length);
        } else if (u.sessionUpdate === "usage_update" && typeof u.used === "number") {
          lastContext.set(threadId, { used: u.used, size: u.size ?? null });
          sendUsage(threadId, turnId, null);
        } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
          const step = { pending: "pending", in_progress: "inProgress", completed: "completed" };
          notify("turn/plan/updated", { threadId, turnId, explanation: null, plan: u.entries.map((e) => ({ step: e.content, status: step[e.status] ?? "pending" })) });
        } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
          let t = tools.get(u.toolCallId);
          if (!t) {
            if (u.sessionUpdate !== "tool_call") return;
            closeMessage();
            t = { name: u.kind, title: null, raw: {}, response: null, text: null, diffs: [], status: "inProgress", declined: false, shown: false, start: now(), end: null };
            tools.set(u.toolCallId, t);
          }
          const cc = u._meta?.claudeCode;
          if (cc?.toolName) t.name = cc.toolName;
          if (u.title) t.title = u.title;
          if (u.rawInput && Object.keys(u.rawInput).length) t.raw = u.rawInput;
          if (cc?.toolResponse) t.response = cc.toolResponse;
          for (const c of u.content ?? []) { if (c.type === "diff") t.diffs.push(c); else if (c.content?.type === "text") t.text = c.content.text; }
          const finished = u.status === "completed" || u.status === "failed";
          if (finished) { t.status = u.status; t.end = now(); }
          if (finished && [...tools.values()].every((x) => x.end)) turnState.toolsIdle.splice(0).forEach((r) => r());
          if (/^(TodoWrite|Task(Create|Update|List|Get))$/.test(t.name)) return; // drawn as the plan
          // Draw the row once the real command is known; edits wait for their diff.
          if (!t.shown && Object.keys(t.raw).length && !EDIT_TOOLS.has(t.name)) {
            t.shown = true;
            notify("item/started", { item: toolItem(u.toolCallId, t, cwd), threadId, turnId, startedAtMs: t.start });
          }
          if (finished) {
            const item = toolItem(u.toolCallId, t, cwd);
            if (!t.shown) { t.shown = true; notify("item/started", { item: { ...item, status: "inProgress" }, threadId, turnId, startedAtMs: t.start }); }
            notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
            items.push(item);
            addChars(threadId, "toolCalls", JSON.stringify(t.raw).length);
            addChars(threadId, "toolResults", (item.aggregatedOutput ?? item.changes?.map((c) => c.diff).join("") ?? "").length);
          }
        }
      };
      acp.onPermission = async (p) => {
        const t = tools.get(p.toolCall?.toolCallId);
        const what = (t && t.name === "Bash" && t.raw.command) || p.toolCall?.title || t?.title || "a tool";
        const decision = await askTui("item/commandExecution/requestApproval", {
          kind: "command", threadId, turnId, itemId: p.toolCall?.toolCallId ?? randomUUID(), startedAtMs: now(),
          environmentId: null, reason: `Claude wants to run: ${what}`, command: what, cwd,
          // No "don't ask again": Claude Code would save that rule to the project for good,
          // while Elpis's label promises only this session.
          availableDecisions: ["accept", "decline", "cancel"],
        });
        const d = decision?.decision;
        const pick = (kind) => p.options.find((o) => o.kind === kind)?.optionId;
        log(`approval ${what} -> ${JSON.stringify(d)}`);
        if (d === "accept") return pick("allow_once") ?? pick("allow_always");
        if (t) t.declined = true;
        if (d === "cancel") {
          // "No, and tell Elpis what to do differently": stop the reply so the user can answer.
          turnState.cancelled = true;
          setImmediate(() => acp.send({ method: "session/cancel", params: { sessionId } }));
        }
        return pick("reject_once") ?? pick("reject_always") ?? null;
      };
      const userText = req.kind === "review" ? `[Code review requested: ${req.reviewHint}]` : inputSummary(input);
      const prompt = await toAcpPrompt(input);
      if (freshSession) {
        const history = await priorTranscript(threadId);
        if (history) {
          prompt.unshift({ type: "text", text: `This conversation started earlier in Elpis, possibly with another model. Here is the conversation so far, for context:\n\n${history}\n\n--- The user's new message follows. ---` });
          log(`seeded Claude with ${history.length} chars of earlier history`);
        }
      }
      if (compacting) ctxChars.delete(threadId);
      else addChars(threadId, "user", prompt.filter((c) => c.type === "text").reduce((n, c) => n + c.text.length, 0));
      const result = turnState.cancelled ? { stopReason: "cancelled" } : await acp.call("session/prompt", { sessionId, prompt });
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
      // The engine's copy of this turn, in order, so other models and resume see it.
      const record = [];
      const say = (role, text) => record.push({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
      let used = [];
      const flush = () => { if (used.length) say("assistant", `[${claudeModel.get(threadId) ?? "Claude"} used tools: ${used.join("; ")}]`); used = []; };
      say("user", userText);
      for (const it of items) {
        if (it.type === "userMessage") { flush(); say("user", inputSummary(it.content)); }
        else if (it.type === "commandExecution") used.push(it.command);
        else if (it.type === "fileChange") used.push(`edited ${it.changes.map((c) => c.path).join(", ")}`);
        else if (it.type === "agentMessage" && it.text.trim()) { flush(); say("assistant", it.text.trim()); }
      }
      flush();
      if (!compacting) await engineCall("thread/inject_items", { threadId, items: record })
        .then(() => log(`recorded Claude turn in thread ${threadId} (${record.length} items)`))
        .catch((e) => log(`record failed for ${threadId}: ${e.message ?? JSON.stringify(e)}`));
    } catch (e) {
      status = "failed";
      error = { message: `Claude (ACP) error: ${e?.message ?? JSON.stringify(e)}`, codexErrorInfo: null, additionalDetails: null };
      log(`turn error ${JSON.stringify(e)}`);
    }
    closeMessage();
    sessionReady(null);
    // A row still running when the turn ends (stop, error) must not spin forever.
    for (const [id, t] of tools) {
      if (!t.shown || t.end) continue;
      t.status = "failed"; t.end = now();
      notify("item/completed", { item: toolItem(id, t, cwd), threadId, turnId, completedAtMs: now() });
    }
    if (req.kind === "review") {
      const exit = { type: "exitedReviewMode", id: randomUUID(), review: items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n\n").trim() };
      notify("item/started", { item: exit, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item: exit, threadId, turnId, completedAtMs: now() });
      items.push(exit);
    }
    if (active === turnState) active = null;
    turnState.toolsIdle.splice(0).forEach((r) => r());
    const completedAt = Math.floor(now() / 1000);
    {
      const cut = (s) => (s.length > 4000 ? s.slice(0, 4000) + "\n…" : s);
      const clip = (it) => it.type === "fileChange" ? { ...it, changes: it.changes.map((c) => ({ ...c, diff: cut(c.diff) })) }
        : it.aggregatedOutput ? { ...it, aggregatedOutput: cut(it.aggregatedOutput) } : it;
      const record = { id: turnId, items: [userItem, ...items.map(clip)], itemsView: "full", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 };
      await updateStore((st) => { st[threadId] = { ...st[threadId], turns: [...(st[threadId]?.turns ?? []), record].slice(-200) }; });
    }
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
    notify("turn/activityUpdated", { threadId, turnId, status: status === "inProgress" ? "completed" : status, durationMs: now() - t0, timeToFirstTokenMs: firstTokenAt ? firstTokenAt - t0 : null });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    claudeLimitsCached().then((rateLimits) => { log(`claude limits: 5h ${rateLimits.primary?.usedPercent}% week ${rateLimits.secondary?.usedPercent}%`); notify("account/rateLimits/updated", { rateLimits }); })
      .catch((e) => log(`claude limits: ${e.message}`));
  }

  // A new chat on a Claude model: the engine keeps its own model, the TUI is told Claude.
  async function startThread(msg) {
    const p = msg.params ?? {};
    let pick = null;
    if (isClaude(p.model)) pick = { model: p.model, effort: p.config?.model_reasoning_effort ?? null };
    else {
      await storeChain;
      const def = (await loadStore())._default;
      engineDefault ??= engineCall("config/read", { includeLayers: false }).then((r) => r?.config?.model ?? null, () => null);
      if (def?.model && (p.model == null || p.model === await engineDefault)) pick = def;
    }
    if (pick) {
      pendingStart.set(msg.id, pick);
      p.model = null;
      if (p.config) delete p.config.model_reasoning_effort;
    }
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }

  // Esc-Esc "edit a previous message": revert drops a turn and every later one. Claude's turns
  // live in the bridge's store and Claude's own session, which the engine cannot see, so the
  // bridge drops them, gives Claude a fresh session seeded from the kept history, and has the
  // engine revert its own turns from the same point.
  async function revertThread(msg) {
    const { threadId, beforeTurnId } = msg.params ?? {};
    await storeChain;
    const stored = (await loadStore())[threadId]?.turns ?? [];
    if (!stored.length) { engine.stdin.write(JSON.stringify(msg) + "\n"); return; }
    try {
      const engineTurns = (await engineCall("thread/turns/list", { threadId, limit: 200, sortDirection: "asc", itemsView: "notLoaded" }).catch(() => ({ data: [] }))).data ?? [];
      const cutAt = (stored.find((t) => t.id === beforeTurnId) ?? engineTurns.find((t) => t.id === beforeTurnId))?.startedAt;
      if (cutAt == null) { engine.stdin.write(JSON.stringify(msg) + "\n"); return; }
      await updateStore((st) => { const e = st[threadId] ?? {}; e.turns = (e.turns ?? []).filter((t) => (t.startedAt ?? 0) < cutAt); delete e.session; delete e.sessions; st[threadId] = e; });
      sessions.delete(threadId);
      const engineCut = engineTurns.find((t) => (t.startedAt ?? 0) >= cutAt);
      const result = engineCut
        ? await engineCall("thread/revert", { threadId, beforeTurnId: engineCut.id })
        : { thread: (await engineCall("thread/read", { threadId })).thread, turnsBackwardsCursor: null };
      log(`reverted thread ${threadId} before ${beforeTurnId} (${stored.filter((t) => (t.startedAt ?? 0) >= cutAt).length} Claude turns dropped${engineCut ? ", engine reverted too" : ""})`);
      toTui({ id: msg.id, result });
    } catch (e) {
      toTui({ id: msg.id, error: { code: -32603, message: `revert failed: ${e?.message ?? JSON.stringify(e)}` } });
    }
  }

  // /review on a Claude chat: Elpis's review rules, answered by Claude, inline.
  async function reviewClaude(msg) {
    const { threadId, target = {} } = msg.params;
    const cwd = threadCwd.get(threadId) ?? process.cwd();
    let ask, hint;
    if (target.type === "baseBranch") {
      const base = await new Promise((r) => execFile("git", ["merge-base", "HEAD", target.branch], { cwd }, (e, out) => r(e ? null : out.trim())));
      ask = base
        ? `Review the code changes against the base branch '${target.branch}'. The merge base commit for this comparison is ${base}. Run \`git diff ${base}\` to inspect the changes relative to ${target.branch}. Provide prioritized, actionable findings.`
        : `Review the code changes against the base branch '${target.branch}'. Find the merge base with \`git merge-base HEAD ${target.branch}\`, then run \`git diff\` against it. Provide prioritized, actionable findings.`;
      hint = `changes against '${target.branch}'`;
    } else if (target.type === "commit") {
      ask = `Review the code changes introduced by commit ${target.sha}${target.title ? ` ("${target.title}")` : ""}. Provide prioritized, actionable findings.`;
      hint = `commit ${String(target.sha).slice(0, 7)}${target.title ? `: ${target.title}` : ""}`;
    } else if (target.type === "custom") {
      ask = target.instructions; hint = String(target.instructions ?? "").trim();
    } else {
      ask = "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings."; hint = "current changes";
    }
    log(`claude review for thread ${threadId}: ${hint}`);
    claudeTurn({ id: msg.id, kind: "review", reviewHint: hint, params: { threadId, input: [{ type: "text", text: `${REVIEW_RULES}\n\n${REVIEW_FORMAT}\n\n${ask}`, text_elements: [] }] } });
  }

  // A message sent while Claude works joins that reply instead of stopping it. With no
  // running Claude turn, the TUI's "no active turn to steer" fallback starts a new turn.
  async function steerClaude(msg) {
    const { threadId, input = [], clientUserMessageId = null } = msg.params;
    const refuse = () => toTui({ id: msg.id, error: { code: -32600, message: "no active turn to steer" } });
    const turn = active;
    if (!turn || turn.threadId !== threadId) return refuse();
    const sessionId = await turn.ready;
    await turn.whenToolsIdle();
    if (!sessionId || active !== turn || turn.cancelled) return refuse();
    try {
      const r = await acp.call("_session/steering", { sessionId, prompt: await toAcpPrompt(input), _meta: { steering: { idleBehavior: "promptRequired" } } });
      if (r?.outcome === "promptRequired") return refuse();
      toTui({ id: msg.id, result: { turnId: turn.turnId } });
      turn.closeMessage();
      const item = { type: "userMessage", id: randomUUID(), clientId: clientUserMessageId, content: input };
      notify("item/started", { item, threadId, turnId: turn.turnId, startedAtMs: now() });
      notify("item/completed", { item, threadId, turnId: turn.turnId, completedAtMs: now() });
      turn.items.push(item);
      addChars(threadId, "user", inputSummary(input).length);
      log(`steered Claude turn ${turn.turnId} (${r?.outcome ?? "ok"})`);
    } catch (e) {
      toTui({ id: msg.id, error: { code: -32603, message: `Claude could not take the message: ${e?.message ?? JSON.stringify(e)}` } });
    }
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
    if (msg.method === "config/read") pendingConfigRead.add(msg.id);
    if (msg.method === "thread/fork" && claudeModel.has(msg.params?.threadId)) {
      const src = msg.params.threadId;
      pendingStart.set(msg.id, { model: claudeModel.get(src), effort: claudeEffort.get(src) ?? null });
    }
    if (msg.method === "thread/start") { startThread(msg); return; }
    if (msg.method === "thread/revert") { revertThread(msg); return; }
    if (msg.method === "review/start" && claudeModel.has(msg.params?.threadId) && !active) { reviewClaude(msg); return; }
    if (msg.method === "thread/turns/list" && msg.params?.threadId) pendingTurnsList.set(msg.id, msg.params);
    if (msg.method === "thread/items/list" && msg.params?.threadId) pendingItemsList.set(msg.id, msg.params);
    if (msg.method === "thread/settings/update") {
      const p = msg.params ?? {};
      if (isClaude(p.model)) { claudeModel.set(p.threadId, p.model); p.model = null; log(`thread ${p.threadId} -> ${claudeModel.get(p.threadId)}`); }
      else if (typeof p.model === "string") claudeModel.delete(p.threadId);
      if (p.approvalPolicy) threadPolicy.set(p.threadId, p.approvalPolicy);
      if (p.collaborationMode?.mode) {
        threadCollab.set(p.threadId, p.collaborationMode.mode);
        if (claudeModel.has(p.threadId) && p.collaborationMode.settings && !isClaude(p.collaborationMode.settings.model)) p.collaborationMode.settings.model = null;
      }
      if (p.effort && claudeModel.has(p.threadId)) { claudeEffort.set(p.threadId, p.effort); p.effort = null; }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "config/batchWrite" && Array.isArray(msg.params?.edits)) {
      const modelEdit = msg.params.edits.find((e) => e.keyPath === "model");
      const claudePick = isClaude(modelEdit?.value);
      if (modelEdit) {
        const effort = msg.params.edits.find((e) => e.keyPath === "model_reasoning_effort")?.value;
        updateStore((st) => { if (claudePick) st._default = { model: modelEdit.value, effort: effort && effort !== "default" ? effort : null }; else delete st._default; });
      }
      if (claudePick) msg.params.edits = msg.params.edits.filter((e) => e.keyPath !== "model" && e.keyPath !== "model_reasoning_effort");
      if (claudePick && msg.params.edits.length === 0) { toTui({ id: msg.id, result: { status: "ok", version: "elpis-claude", filePath: `${HOME}/.elpis-next/config.toml`, overriddenMetadata: null } }); return; }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "turn/start") {
      const tid = msg.params?.threadId;
      if (msg.params?.collaborationMode?.mode) threadCollab.set(tid, msg.params.collaborationMode.mode);
      if (isClaude(msg.params?.model)) {
        claudeModel.set(tid, msg.params.model);
        if (msg.params.effort) claudeEffort.set(tid, msg.params.effort);
      }
      if (claudeModel.has(tid) && !String(msg.id).startsWith("temporary-structured-turn")) {
        log(`claude turn for thread ${tid} (${claudeModel.get(tid)})`);
        claudeTurn(msg);
        return;
      }
      if (isClaude(msg.params?.model)) msg.params.model = null;
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "thread/compact/start" && claudeModel.has(msg.params?.threadId) && !active) {
      toTui({ id: msg.id, result: {} });
      const extra = msg.params.instructions ? ` ${msg.params.instructions}` : "";
      log(`claude compact for thread ${msg.params.threadId}`);
      claudeTurn({ kind: "compact", params: { threadId: msg.params.threadId, input: [{ type: "text", text: `/compact${extra}`, text_elements: [] }] } });
      return;
    }
    if (msg.method === "turn/interrupt" && active && msg.params?.threadId === active.threadId) {
      active.cancelled = true;
      if (active.sessionId) acp.send({ method: "session/cancel", params: { sessionId: active.sessionId } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === "turn/steer" && claudeModel.has(msg.params?.threadId)) {
      steerClaude(msg);
      return;
    }
    engine.stdin.write(line + "\n");
  });
  ws.on("close", async () => { await storeChain; engine.kill(); acp?.kill(); log("tui disconnected"); });
});
