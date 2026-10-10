// Elpis TUI <-ws-> bridge <-stdio-> real `elpis app-server` (everything else)
//                         \-stdio-> claude-agent-acp (chat turns -> Claude)
import { splitContext, splitTokens, transcriptTokens } from "./context-split.mjs";
import { createBridgeServer, bridgeUrl, createEngine, stopBridgeListener, shutdownRuntime } from "./shared-runtime.mjs";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// Hidden structured requests (chat titles, /recap) are short; Haiku answers them.
const STRUCTURED_MODEL = "haiku";
const STRUCTURED_SYSTEM = "You fulfil one request and answer with exactly one JSON object that matches the JSON Schema given with it. No prose, no Markdown, no code fences.";
// The JSON object in a reply, re-serialized; null when there is none.
function jsonIn(text) {
  const t = unfence(text.trim());
  for (const s of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) { try { const v = JSON.parse(s); if (v && typeof v === "object") return JSON.stringify(v); } catch {} }
  return null;
}
const AGENTS_MCP = new URL("./elpis-agents-mcp.mjs", import.meta.url).pathname;
// The Context Ledger's Subagents switch off: Claude Code's tools that start or drive other
// agents (the subagent tool is "Agent", listed as "Task"; Workflow runs agent scripts;
// RemoteTrigger runs cloud agents) are disallowed, and the elpis-agents server is left out.
const SUBAGENT_TOOLS = ["Agent", "Task", "ListAgents", "SendMessage", "Workflow", "RemoteTrigger"];
// The delegate tool reaches back into this bridge, so a helper can be any model it serves
// (engine models, Claude, Antigravity), and it names the chat that started it.
// Elpis's own tools for a Claude or Antigravity session: helpers on other models (when it may
// delegate) and durable memory (a chat the user started, not a helper; the tool itself checks
// the workspace opted in).
const mcpServersFor = (subagents, parentThreadId, memoryCwd) => {
  const agents = subagents && !process.env.ACP_BRIDGE_NO_AGENTS;
  if (!agents && !memoryCwd) return [];
  return [{
    name: "elpis-agents", command: process.execPath, args: [AGENTS_MCP],
    env: [
      { name: "ELPIS_ENGINE_BIN", value: process.env.ELPIS_ENGINE_BIN ?? `${HOME}/.local/bin/elpis` },
      { name: "ELPIS_BRIDGE_URL", value: bridgeUrl(wss) },
      { name: "ELPIS_AGENT_TOOLS", value: agents ? "1" : "0" },
      ...(parentThreadId ? [{ name: "ELPIS_PARENT_THREAD", value: parentThreadId }] : []),
      ...(memoryCwd ? [{ name: "ELPIS_MEMORY_CWD", value: memoryCwd }] : []),
      ...(process.env.ELPIS_HOME ? [{ name: "ELPIS_HOME", value: process.env.ELPIS_HOME }] : []),
    ],
  }];
};
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
// The TUI splits a command into words and quotes each again, so `a && b` showed as `a '&&' b`.
// Anything but plain words goes as `bash -lc '<script>'`, which the TUI shows as the script,
// as it does Elpis's own commands.
const PLAIN_WORDS = /^[\w@%+=:,./-]+( [\w@%+=:,./-]+)*$/;
const shownCommand = (s) => (PLAIN_WORDS.test(s) ? s : `bash -lc '${s.replaceAll("'", "'\\''")}'`);
const plainCommand = (c) => (c.startsWith("bash -lc '") && c.endsWith("'") ? c.slice(10, -1).replaceAll("'\\''", "'") : c);
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
  const command = shownCommand((t.name === "Bash" && r.command) || t.title || t.name || "tool");
  const commandActions = t.name === "Read" && r.file_path ? [{ type: "read", command, name: r.file_path.split("/").pop(), path: r.file_path }]
    : t.name === "Grep" || t.name === "Glob" ? [{ type: "search", command, query: r.pattern ?? null, path: r.path ?? null }]
      : t.name === "LS" ? [{ type: "listFiles", command, path: r.path ?? null }] : [];
  const output = t.name === "Bash" && typeof resp.stdout === "string" ? [resp.stdout, resp.stderr].filter(Boolean).join("\n") : t.text ? unfence(t.text) : null;
  return { type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd, processId: null, source: "agent", status, commandActions, aggregatedOutput: output, exitCode: status === "completed" ? 0 : status === "inProgress" ? null : 1, durationMs: t.end ? t.end - t.start : null };
}
// A finished turn as the store keeps it: long outputs and diffs cut.
const cut = (s) => (s.length > 4000 ? s.slice(0, 4000) + "\n…" : s);
const clipItem = (it) => it.type === "fileChange" ? { ...it, changes: it.changes.map((c) => ({ ...c, diff: cut(c.diff) })) }
  : it.aggregatedOutput ? { ...it, aggregatedOutput: cut(it.aggregatedOutput) } : it;
const clipTurn = (turn) => ({ ...turn, items: turn.items.map(clipItem) });
const ELPIS_HOME = process.env.ELPIS_HOME || `${HOME}/.elpis-next`;
const STORE = process.env.ACP_BRIDGE_STORE ?? `${ELPIS_HOME}/elpis-claude/sessions.json`;
async function loadStore() { return (await readJson(STORE)) ?? {}; }
let storeChain = Promise.resolve();
// Resolves true once saved, false if saving failed.
function updateStore(fn) {
  storeChain = storeChain.then(async () => { const st = await loadStore(); fn(st); await saveStore(st); return true; }).catch((e) => { log(`store: ${e.message}`); return false; });
  return storeChain;
}
const CATALOG = `${STORE.slice(0, STORE.lastIndexOf("/"))}/catalog.json`;
// The subscriptions Elpis reaches through ACP, each by a model-id prefix. Antigravity (Gemini on
// the Google sign-in) runs through agy-acp.mjs and is offered only when `agy` is installed.
const AGY_BIN = process.env.AGY_BIN ?? `${HOME}/.local/bin/agy`;
const AGENTS = [
  { key: "claude", speaker: "Claude", prefix: "claude/", label: "Claude subscription", description: "Claude Code on your Pro/Max plan", adapter: ADAPTER, env: { CLAUDE_CODE_EXECUTABLE: CLAUDE }, catalogFile: CATALOG, limits: () => claudeLimitsCached().then((one) => [one]) },
  ...(!process.env.ELPIS_NO_AGY && existsSync(AGY_BIN)
    ? [{ key: "agy", speaker: "Gemini", prefix: "agy/", label: "Antigravity", description: "Antigravity, your Google sign-in", adapter: new URL("./agy-acp.mjs", import.meta.url).pathname, env: { AGY_BIN }, catalogFile: CATALOG.replace(/catalog\.json$/, "catalog-agy.json"), limits: () => agyLimitsCached() }]
    : []),
];
const agentOf = (model) => (typeof model === "string" ? AGENTS.find((a) => model.startsWith(a.prefix)) : undefined);
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
  return { limitId: "claude", limitName: "Claude", normalModelSlug: null, primary: win(u.five_hour, 300), secondary: win(u.seven_day, 10080), credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null };
}

// Antigravity's own /usage answer: each model group has a 5-hour and a weekly limit.
async function agyLimits() {
  const out = await new Promise((resolve, reject) => execFile(AGY_BIN, ["--print", "/usage", "--output-format", "json"], { cwd: HOME, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  const groups = JSON.parse(out).command?.data?.groups ?? [];
  const win = (b, mins) => b ? { usedPercent: Math.round((1 - (b.remaining_fraction ?? 1)) * 100), windowDurationMins: mins, resetsAt: b.reset_time ? Math.floor(Date.parse(b.reset_time) / 1000) : null } : null;
  return groups.map((g) => ({
    limitId: `antigravity-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, limitName: `Antigravity ${g.name}`, normalModelSlug: null,
    primary: win(g.buckets?.find((b) => b.window === "5h"), 300), secondary: win(g.buckets?.find((b) => b.window === "weekly"), 10080),
    credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
  }));
}

// Anthropic refuses (HTTP 429) when asked after every turn, so each subscription is asked at
// most once a minute, and its last answer stays when a request fails.
function everyMinute(fetchLimits, what) {
  const c = { at: 0, value: null, inFlight: null };
  return () => {
    if (Date.now() - c.at < 60_000) return c.value ? Promise.resolve(c.value) : Promise.reject(new Error(`${what} unavailable (retrying in a minute)`));
    c.inFlight ??= fetchLimits()
      .then((v) => { c.value = v; return v; })
      .catch((e) => { if (c.value) return c.value; throw e; })
      .finally(() => { c.at = Date.now(); c.inFlight = null; });
    return c.inFlight;
  };
}
const claudeLimitsCached = everyMinute(claudeLimits, "Claude usage");
const agyLimitsCached = everyMinute(agyLimits, "Antigravity usage");

// Smart Prune for Claude chats: the proxy `elpis claude` runs (`elpis claude --serve`), started
// once and shared. It shrinks large tool results before Anthropic sees them; a Claude chat's
// requests go through it while that chat's Smart Prune switch is on.
let pruneProxy = null;
function smartPruneProxy() {
  pruneProxy ??= new Promise((resolve) => {
    const proxy = spawn(process.env.ELPIS_ENGINE_BIN ?? `${HOME}/.local/bin/elpis`, ["claude", "--serve", "--no-browser"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    proxy.stdout.on("data", (d) => {
      out += d;
      const i = out.indexOf("\n");
      if (i >= 0) { const origin = out.slice(0, i).trim(); log(`smart prune proxy at ${origin}`); resolve(origin); }
    });
    proxy.on("error", (e) => { log(`smart prune proxy: ${e.message}`); resolve(null); });
    proxy.on("exit", (code) => { log(`smart prune proxy exited (${code})`); pruneProxy = null; resolve(null); });
    setTimeout(() => resolve(null), 30_000);
  });
  return pruneProxy;
}

// The account each subscription is signed in with; Elpis's /status reads this file.
const ACCOUNTS = `${STORE.slice(0, STORE.lastIndexOf("/"))}/accounts.json`;
async function recordAccounts() {
  const { readFile } = await import("node:fs/promises");
  const json = (path) => readFile(path, "utf8").then(JSON.parse).catch(() => null);
  const out = {};
  const claude = (await json(`${HOME}/.claude.json`))?.oauthAccount;
  const plan = (await json(`${HOME}/.claude/.credentials.json`))?.claudeAiOauth?.subscriptionType;
  if (claude?.emailAddress) out.claude = { email: claude.emailAddress, plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
  const agyLog = await readFile(`${HOME}/.gemini/antigravity-cli/cli.log`, "utf8").catch(() => "");
  const agyEmail = [...agyLog.matchAll(/authenticated successfully as (\S+)/g)].at(-1)?.[1];
  if (agyEmail) out.agy = { email: agyEmail };
  await writeJson(ACCOUNTS, out);
}
recordAccounts().catch((e) => log(`accounts: ${e.message}`));

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
  constructor(agent) {
    this.proc = spawn("node", [agent.adapter], { env: { ...process.env, ...agent.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => log(`${agent.key} acp stderr: ${String(d).trim().slice(0, 300)}`));
    this.nextId = 1;
    this.pending = new Map();
    // Each session's own handlers: a chat's running turn (also under its Claude subagents'
    // sessions) or a hidden structured request. Chats run at once, so updates and approvals go
    // only to their session's turn; an approval asked by any other session is refused.
    this.bySession = new Map();
    this.loading = new Set(); // sessions being reloaded: their replayed history draws nowhere
    lineReader(this.proc.stdout, (line) => this.#handle(JSON.parse(line)));
    this.proc.on("exit", (code) => {
      this.dead = `the ${agent.label} ACP adapter exited (code ${code}). Is it installed at ${agent.adapter}?`;
      for (const p of this.pending.values()) p.reject({ message: this.dead });
      this.pending.clear();
    });
    // `subagents`: each subagent Claude starts gets its own ACP session (subagent_spawned, its
    // updates under that session, subagent_state_update), which the bridge draws as an Elpis
    // child thread.
    this.ready = this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {} } });
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
      if (!this.loading.has(msg.params?.sessionId)) this.bySession.get(msg.params?.sessionId)?.onUpdate?.(msg.params);
    } else if (msg.method === "_claude/sdkMessage" && msg.params?.message?.subtype === "init") {
      // Claude Code's own list of the tools it has this turn.
      log(`claude tools (session ${msg.params.sessionId}): ${(msg.params.message.tools ?? []).join(", ")}`);
    } else if (msg.method === "session/request_permission") {
      const own = this.bySession.get(msg.params?.sessionId);
      if (!own) log(`approval asked by unknown session ${msg.params?.sessionId} -> refused`);
      const optionId = own?.onPermission ? await own.onPermission(msg.params) : null;
      this.send({ id: msg.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
    } else if (msg.id !== undefined) {
      this.send({ id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
    }
  }
  kill() { this.proc.kill(); }
}

const wss = createBridgeServer();
wss.on("listening", () => { log(`LISTENING ${wss.address().port ?? wss.address()}`); checkIdle(); });

// A helper runs on its delegate tool's own connection, so the TUIs hear of it only through the
// bridge: its start (with its parent) and its status changes go to every other connection.
const clients = new Set();
const helperThreads = new Set();
// A helper asks the user like its chat: its approval requests go from the delegate tool's
// connection to a TUI's, and the answer comes back. The delegate tool names itself
// "elpis-agents" in initialize; every other connection is a TUI.
const helperConns = new WeakSet();
const relayed = new Map(); // id sent to the TUI -> answers the helper's request
const chatAccess = new Map(); // a chat's confirmed approval policy and profile, for the helpers it starts
// A helper's ceiling is the sandbox it may have: what it asked for (read-only unless it asked to
// write), never more than its chat allowed at its start, and only ever lowered after that, as
// the engine's own subagents inherit a reduction; its chat's later grants never raise it. Every
// helper this bridge has seen stays here, with the `restrict` of each connection that has it
// open (a delegate server, a second one, or a TUI); the store keeps the ceiling in
// `_delegations`, for a helper reopened after a restart.
const helperScope = new Map(); // helper thread id -> { parentThreadId, requested, ceiling, owners }
// Helpers the engine is still starting or reopening, not yet in helperScope; a reduction
// meanwhile lowers them too.
const pendingHelpers = new Set(); // { parentThreadId, requested, ceiling }
const AUTHORITY = { plan: 0, default: 0, acceptEdits: 1, auto: 2, bypassPermissions: 3 };
// Only the built-in Workspace and Full Access profiles let a chat's helpers write; a custom or
// unknown profile does not.
const WRITABLE = [":workspace", ":danger-full-access"];
const writableFor = (threadId) => WRITABLE.includes(chatAccess.get(threadId)?.profile) && helperScope.get(threadId)?.ceiling !== "read-only";
// A reopened helper's ceiling: the lower of the stored one and this bridge's, lowered to what
// its chat allows now. A record from before ceilings were kept is read-only.
const ceilingOf = (threadId, d) => d.requested === "workspace-write" && d.ceiling === "workspace-write"
  && helperScope.get(threadId)?.ceiling !== "read-only" && writableFor(d.parentThreadId) ? "workspace-write" : "read-only";
// Lowers the ceiling of every helper below a chat that may still write. Resolves once each open
// copy has applied it or been stopped; null when there was nothing to lower.
function reduceHelpers(threadId) {
  const work = [];
  for (const d of pendingHelpers) if (d.parentThreadId === threadId) d.ceiling = "read-only";
  for (const [id, h] of helperScope) {
    if (h.parentThreadId !== threadId) continue;
    if (h.ceiling === "workspace-write") { h.ceiling = "read-only"; for (const restrict of h.owners) work.push(restrict(id)); }
    const nested = reduceHelpers(id);
    if (nested) work.push(nested);
  }
  return work.length ? Promise.all(work) : null;
}
// The same reduction in the store, for a helper reopened after a restart. False if it was not saved.
async function persistReduction(threadId) {
  await storeChain;
  const below = (dels) => {
    const ids = new Set([threadId]);
    for (let grew = true; grew;) { grew = false; for (const [id, d] of Object.entries(dels)) if (ids.has(d.parentThreadId) && !ids.has(id)) { ids.add(id); grew = true; } }
    ids.delete(threadId);
    return [...ids].filter((id) => dels[id].ceiling !== "read-only");
  };
  if (!below((await loadStore())._delegations ?? {}).length) return true;
  return updateStore((st) => { for (const id of below(st._delegations ?? {})) st._delegations[id].ceiling = "read-only"; });
}
// Provider turns live in this bridge, while native turns live in the shared engine.
// A provider thread has one runtime owner. Other terminals subscribe to that runtime;
// their requests and replies keep their own ids, including when both clients use id 1.
const providerOwners = new Map();
const subscriptions = new Map(); // physical client -> threads it opened
const forwarded = new Map(); // bridge id -> original client and request id
const startingProviders = new Map(); // start response must name the model before its notification
const contexts = new Set();
const sendClient = (client, msg) => { if (client.readyState === 1) client.sendWire(JSON.stringify(msg)); };
const viewers = (threadId) => [...clients].filter((c) => c.readyState === 1 && !helperConns.has(c) && subscriptions.get(c)?.has(threadId));
function relayToTui(msg, answer, origin) {
  let threadId = msg.params?.threadId;
  while (helperScope.get(threadId)?.parentThreadId) threadId = helperScope.get(threadId).parentThreadId;
  if (!threadId) return false;
  const watching = new Set(viewers(threadId));
  const id = `relay-${randomUUID()}`;
  relayed.set(id, { answer, origin, clients: watching, message: { ...msg, id }, threadId });
  for (const client of watching) sendClient(client, { ...msg, id });
  return true;
}
function cancelRelays(origin, threadId, turnId) {
  for (const [id, relay] of relayed) {
    if (relay.origin !== origin || (threadId && relay.message.params?.threadId !== threadId) || (turnId && relay.message.params?.turnId !== turnId)) continue;
    relayed.delete(id);
    for (const client of relay.clients) sendClient(client, { method: "serverRequest/resolved", params: { threadId: relay.message.params.threadId, requestId: id } });
    relay.answer({ error: { code: -32603, message: "The requesting turn ended." } });
  }
}
function flushApprovals(client, threadId) {
  if (helperConns.has(client) || !subscriptions.get(client)?.has(threadId)) return;
  for (const relay of relayed.values()) if (relay.threadId === threadId && !relay.clients.has(client)) {
    relay.clients.add(client); sendClient(client, relay.message);
  }
}
function decorateThread(thread) {
  if (!thread?.id) return;
  providerOwners.get(thread.id)?.decorate(thread);
}
let idleTimer, stopping = false;
async function stopBridge() {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  stopBridgeListener();
  await storeChain;
  for (const c of contexts) c.close();
  await shutdownRuntime();
  process.exit(0);
}
function checkIdle() {
  if (stopping) return;
  for (const c of [...contexts]) c.releaseIfUnused();
  clearTimeout(idleTimer);
  if (!process.env.ELPIS_SHARED_BRIDGE || clients.size || [...contexts].some((c) => c.busy())) return;
  idleTimer = setTimeout(async () => {
    if (clients.size || [...contexts].some((c) => c.busy())) return;
    await stopBridge();
  }, 30_000);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, stopBridge);
wss.on("connection", (ws) => {
  if (stopping) { ws.close(1012, "Session backend is stopping"); return; }
  clients.add(ws);
  clearTimeout(idleTimer);
  subscriptions.set(ws, new Set());
  ws.sendWire = ws.send.bind(ws);
  ws.send = (line) => {
    let msg;
    try { msg = JSON.parse(String(line)); } catch { if (ws.readyState === 1) ws.sendWire(line); return; }
    decorateThread(msg.result?.thread);
    decorateThread(msg.params?.thread);
    if (Array.isArray(msg.result?.data)) for (const t of msg.result.data) if (typeof t === "object") decorateThread(t);
    const owner = providerOwners.get(msg.params?.threadId);
    if (msg.method === "thread/status/changed" && owner) msg.params.status = owner.status();
    if (msg.method === "thread/settings/updated" && owner) {
      const model = owner.model();
      if (model) msg.params.threadSettings = { ...msg.params.threadSettings, model, effort: owner.effort() };
    }
    const route = !msg.method && forwarded.get(msg.id);
    const recipient = route?.client ?? ws;
    if (!msg.method && openingReplies.delete(msg.id) && msg.result?.thread) subscriptions.get(recipient)?.add(msg.result.thread.id);
    if (route) { forwarded.delete(msg.id); sendClient(recipient, { ...msg, id: route.id }); }
    else if (owner?.ws === ws && msg.method && msg.id === undefined && !["thread/status/changed", "thread/name/updated", "thread/archived", "thread/closed", "thread/deleted", "thread/unarchived"].includes(msg.method)) {
      for (const client of viewers(msg.params.threadId)) sendClient(client, msg);
    } else sendClient(recipient, msg);
    // Hydration reaches the terminal before a pending question for that chat.
    if (msg.result?.thread) flushApprovals(recipient, msg.result.thread.id);
  };
  const toOthers = (msg) => { const line = JSON.stringify(msg); for (const c of clients) if (c !== ws && c.readyState === 1) c.send(line); };
  const shareHelper = (msg) => { if (msg?.method === "thread/status/changed" && helperThreads.has(msg.params?.threadId)) toOthers(msg); };
  // A chat's latest plan, kept in the store: the engine sends plans only while a turn runs, so
  // reopening a chat (GPT or Claude) shows it again.
  const notePlan = (msg) => {
    if (msg?.method !== "turn/plan/updated" || !msg.params?.threadId) return;
    const { threadId, turnId, explanation, plan } = msg.params;
    updateStore((st) => { st[threadId] = { ...st[threadId], plan: { turnId, explanation: explanation ?? null, plan } }; });
  };
  const replayPlan = async (threadId) => {
    await storeChain;
    const saved = (await loadStore())[threadId]?.plan;
    if (saved?.plan?.length) notify("turn/plan/updated", { threadId, turnId: saved.turnId, explanation: saved.explanation, plan: saved.plan });
  };
  const toTui = (msg) => { shareHelper(msg); notePlan(msg); ws.send(JSON.stringify(msg)); };
  const notify = (method, params) => {
    const msg = { method, params, emittedAtMs: now() };
    notePlan(msg);
    // Overview changes reach every terminal; transcript events reach only subscribers.
    const all = ["thread/started", "thread/status/changed", "thread/archived", "thread/closed"].includes(method);
    const tid = params.threadId ?? params.thread?.id;
    const recipients = all ? [...clients].filter((c) => !helperConns.has(c)) : viewers(tid);
    if (helperConns.has(ws) && ws.readyState === 1) recipients.push(ws);
    for (const c of new Set(recipients)) sendClient(c, msg);
    checkIdle();
  };
  const engine = createEngine();
  engine.stdin.on("error", (e) => log(`engine input: ${e.message}`)); // a stopped helper's engine
  const threadCwd = new Map();
  const threadSeen = new Map(); // thread id -> the engine's last Thread object for it
  // Claude's subagents as Elpis child threads (what Left/Right and /subagents list): thread id ->
  // { thread, lane } while this connection drew it. Finished ones are also in the store, under
  // their own id with `parentThreadId`, so a resumed chat lists and replays them.
  const childThreads = new Map();
  const childThread = (c) => ({ ...c.thread, status: c.lane && !c.lane.done ? { type: "active", activeFlags: [] } : { type: "idle" }, updatedAt: Math.floor(now() / 1000) });
  async function storedChildren(rootIds) {
    await storeChain;
    const out = new Map();
    for (const [id, saved] of Object.entries(await loadStore())) if (saved?.thread && (!rootIds || rootIds.has(saved.rootThreadId))) out.set(id, { thread: saved.thread, rootThreadId: saved.rootThreadId, turns: saved.turns ?? [] });
    for (const [id, c] of childThreads) if (!rootIds || rootIds.has(c.rootThreadId)) out.set(id, { thread: childThread(c), rootThreadId: c.rootThreadId, turns: c.lane.done ? out.get(id)?.turns ?? [] : [c.lane.turn()] });
    return out;
  }
  // What the TUI asks about a child thread (thread/read when it lists or opens one) is answered
  // here; the engine has never heard of it. Nobody types into a subagent's thread, so a
  // thread/resume is refused and the TUI falls back to thread/read.
  const childIds = new Set(); // every child thread id the bridge answers for
  loadStore().then((st) => { for (const [id, saved] of Object.entries(st)) if (saved?.parentThreadId) childIds.add(id); });
  async function answerChild(msg) {
    const { threadId, includeTurns } = msg.params;
    if (msg.method === "thread/resume") return toTui({ id: msg.id, error: { code: -32600, message: "a Claude subagent's thread is read-only; it is shown from thread/read" } });
    const c = (await storedChildren(null)).get(threadId);
    if (!c) return toTui({ id: msg.id, error: { code: -32600, message: `thread not found: ${threadId}` } });
    toTui({ id: msg.id, result: { thread: { ...c.thread, turns: includeTurns ? c.turns : [] } } });
  }
  const threadPolicy = new Map();
  const smartPrune = new Map(); // thread id -> its Smart Prune switch, as the engine reports it
  const threadSandbox = new Map();
  const pendingDelegation = new Map(); // thread/start id -> the chat that delegated it
  const sessions = new Map();
  const acps = new Map();
  const claudeModel = new Map();
  const claudeEffort = new Map();
  const resumeResults = new Map();
  const context = {
    failed: false,
    busy: () => activeTurns.size > 0 || engineTurns.size > 0 || structured.size > 0 || pendingStart.size > 0 || pendingResume.size > 0 || engineReqs.size > 0
      || [...forwarded.values()].some((r) => r.owner === ws),
    close: () => { cancelRelays(ws); engine.kill(); for (const a of acps.values()) a.kill(); },
    releaseIfUnused: () => {
      if (ws.readyState === 1 || context.busy() || [...relayed.values()].some((r) => r.origin === ws)
        || [...providerOwners].some(([tid, owner]) => owner.ws === ws && viewers(tid).length)) return;
      context.close(); contexts.delete(context);
      for (const [tid, owner] of providerOwners) if (owner.ws === ws) providerOwners.delete(tid);
      for (const tid of ownHelpers.keys()) helperScope.get(tid)?.owners.delete(restrictHelper);
      for (const d of [...pendingDelegation.values(), ...pendingAdopt.values()]) pendingHelpers.delete(d);
    },
  };
  contexts.add(context);
  function claimProvider(tid, result) {
    if (!claudeModel.has(tid)) return;
    if (result) resumeResults.set(tid, { ...result, thread: { ...result.thread } });
    if (providerOwners.has(tid) && providerOwners.get(tid).ws !== ws) return providerOwners.get(tid);
    const owner = {
      ws,
      model: () => claudeModel.get(tid),
      effort: () => claudeEffort.get(tid) ?? null,
      status: () => activeTurns.has(tid) ? { type: "active", activeFlags: [] } : { type: "idle" },
      decorate: (thread) => {
        if (claudeModel.has(tid)) {
          thread.model = claudeModel.get(tid); thread.reasoningEffort = claudeEffort.get(tid) ?? null;
          thread.status = owner.status();
        }
      },
      dispatch: (msg, client) => {
        const id = `forward-${randomUUID()}`;
        forwarded.set(id, { client, id: msg.id, owner: ws });
        handleMessage(JSON.stringify({ ...msg, id }));
      },
    };
    providerOwners.set(tid, owner);
  }
  function rememberStart(id, pick) {
    pendingStart.set(id, pick);
    const key = `${connectionId}:${id}`;
    let release;
    const ready = new Promise((r) => { release = r; });
    const timer = setTimeout(() => { startingProviders.delete(key); release(); log("provider start notification wait expired"); }, 30000);
    startingProviders.set(key, { ready, resolve: () => { clearTimeout(timer); release(); } });
  }
  const connectionId = randomUUID();
  const sessionModel = new Map();
  const threadCollab = new Map();
  // thread id -> its permission profile and approvals reviewer, as the engine last confirmed
  // them; with the approval policy and Plan they pick Claude's own mode (claudeModeOf).
  const threadAccess = new Map();
  const noteAccess = (threadId, s) => {
    if (!threadId || !s) return;
    const cached = resumeResults.get(threadId);
    if (cached) {
      for (const k of ["approvalPolicy", "approvalsReviewer", "activePermissionProfile", "cwd", "collaborationMode", "serviceTier", "disabledPluginIds"]) if (s[k] !== undefined) cached[k] = s[k];
      if (s.sandboxPolicy) cached.sandbox = s.sandboxPolicy;
    }
    const wasWritable = chatAccess.has(threadId) ? writableFor(threadId) : null;
    if (s.approvalPolicy) threadPolicy.set(threadId, s.approvalPolicy);
    const sandbox = (s.sandboxPolicy ?? s.sandbox)?.type;
    const profile = s.permissions ?? s.activePermissionProfile?.id
      ?? (sandbox && ({ readOnly: ":read-only", dangerFullAccess: ":danger-full-access" }[sandbox] ?? ":workspace"));
    const prev = threadAccess.get(threadId) ?? {};
    threadAccess.set(threadId, { profile: profile ?? prev.profile, reviewer: s.approvalsReviewer ?? prev.reviewer });
    chatAccess.set(threadId, { policy: threadPolicy.get(threadId), profile: threadAccess.get(threadId).profile });
    for (const confirm of confirmations.get(threadId) ?? []) confirm(threadAccess.get(threadId).profile);
    // A chat that can no longer write lowers its helpers' ceilings.
    if (writableFor(threadId)) return null;
    if (wasWritable !== false) persistReduction(threadId).then((saved) => {
      if (saved) return;
      log(`helpers of ${threadId}: reduction not saved`);
      notify("warning", { threadId, message: "Elpis could not save its helpers' reduced permissions; they stay reduced only until Elpis restarts." });
    });
    return reduceHelpers(threadId);
  };
  // The Claude Code mode a chat's turn runs in: Codex's permission modes, mapped to Claude's own.
  // Read Only = Manual ("default"), Default = Accept edits, Approve for me = Auto, Full Access =
  // Bypass permissions; Plan is Plan. Antigravity has only its default, Plan and full access. A
  // read-only helper that may not ask plans.
  const MODE_NAMES = { default: "Manual", acceptEdits: "Accept edits", plan: "Plan mode", auto: "Auto", bypassPermissions: "Bypass permissions" };
  const claudeModeOf = (threadId, agentKey, ask) =>
    threadCollab.get(threadId) === "plan" ? "plan" : accessModeOf(threadId, agentKey, ask);
  // The mode of the chat's permission mode alone, which a Plan turn returns to once its plan is
  // approved.
  const accessModeOf = (threadId, agentKey, ask) => {
    const { profile, reviewer } = threadAccess.get(threadId) ?? {};
    const readOnly = threadSandbox.get(threadId) === "read-only" || !!profile?.includes("read-only");
    // Never asking is an approval policy, not permission to leave a restricted profile.
    // Unknown/custom profiles stay restricted unless the engine explicitly names Full Access.
    if (!ask) return readOnly ? "plan" : profile === ":danger-full-access" ? "bypassPermissions" : "default";
    if (agentKey !== "claude" || readOnly) return "default";
    return reviewer === "auto_review" ? "auto" : "acceptEdits";
  };
  const sessionMode = new Map();
  const tokenSums = new Map();
  const ctxChars = new Map();
  const devChars = new Map();
  const addChars = (threadId, part, n) => { const c = ctxChars.get(threadId) ?? { user: 0, agent: 0, reasoning: 0, toolCalls: 0, toolResults: 0 }; c[part] += n ?? 0; ctxChars.set(threadId, c); };
  // A Claude chat's parts come from Claude's own token counts in its Claude Code transcript, so
  // they hold after Elpis restarts and count the thinking Claude keeps in context. Other chats,
  // and a transcript not found, count text length as their turns stream.
  const transcripts = new Map(); // transcript path -> { stamp, tokens }
  const transcriptOf = (threadId) => {
    const live = sessions.get(threadId);
    if (live?.agent !== "claude") return null;
    const project = (threadCwd.get(threadId) ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
    return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", project, `${live.id}.jsonl`);
  };
  const attribution = (threadId, used) => {
    const file = transcriptOf(threadId);
    if (file && existsSync(file)) {
      const { mtimeMs, size } = statSync(file);
      let seen = transcripts.get(file);
      if (seen?.stamp !== `${mtimeMs}:${size}`) transcripts.set(file, seen = { stamp: `${mtimeMs}:${size}`, tokens: transcriptTokens(readFileSync(file, "utf8")) });
      const t = seen.tokens;
      return splitTokens({ developerMessages: Math.round((devChars.get(threadId) ?? 0) / 4), userMessages: t.user, agentMessages: t.agent, reasoning: t.reasoning, toolCalls: t.toolCalls, toolResults: t.toolResults }, used);
    }
    return splitContext(ctxChars.get(threadId), devChars.get(threadId), used);
  };
  const lastContext = new Map();
  const lastTurnUsage = new Map(); // thread id -> its latest finished turn's usage
  // Anthropic reports cache reads and writes apart from input; Elpis (like OpenAI) counts them as input.
  const usageBreakdown = (u) => {
    const input = (u.input ?? 0) + (u.cachedRead ?? 0) + (u.cachedWrite ?? 0);
    return { totalTokens: input + (u.output ?? 0), inputTokens: input, cachedInputTokens: u.cachedRead ?? 0, cacheWriteInputTokens: u.cachedWrite ?? 0, outputTokens: u.output ?? 0, reasoningOutputTokens: 0 };
  };
  const sendUsage = (threadId, turnId, last) => {
    const sum = tokenSums.get(threadId) ?? {};
    const ctx = lastContext.get(threadId) ?? {};
    // Elpis reads `last` as the latest request, whose total is the context now. Claude reports
    // a whole turn (or nothing yet): its output stays, the rest of the context is input.
    const lastB = usageBreakdown(last ?? lastTurnUsage.get(threadId) ?? {});
    if (typeof ctx.used === "number") {
      const output = Math.min(lastB.outputTokens, ctx.used);
      const input = ctx.used - output;
      const cached = Math.min(lastB.cachedInputTokens, input);
      Object.assign(lastB, { totalTokens: ctx.used, inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: Math.min(lastB.cacheWriteInputTokens, input - cached) });
    }
    if (last) lastTurnUsage.set(threadId, last);
    const contextAttribution = typeof ctx.used === "number" ? attribution(threadId, ctx.used) : undefined;
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usageBreakdown(sum), last: lastB, modelContextWindow: ctx.size ?? null, ...(contextAttribution && { contextAttribution }) } });
  };
  const isBridged = (m) => !!agentOf(m);
  const ensureAcp = async (agent) => {
    let a = acps.get(agent.key);
    if (!a || a.dead) { a = new Acp(agent); acps.set(agent.key, a); await a.ready; log(`${agent.key} acp ready`); }
    return a;
  };
  // Each agent's models and each model's effort levels (Claude's Haiku has none; Antigravity
  // models carry their effort in the id). Reading one model's levels
  // means switching a scratch session to it (~4 s each, without touching Claude Code's saved
  // settings), so startup reads only the current model; the rest come from catalog.json and are
  // refreshed in the background at most once a day.
  const catalogs = new Map();
  const catalogFor = (agent) => {
    if (!catalogs.has(agent.key)) catalogs.set(agent.key, readCatalog(agent));
    return catalogs.get(agent.key);
  };
  // A saved list answers at once (starting Antigravity alone takes ~7 s); the live read
  // refreshes the file for the next start. The first start waits for the live read.
  async function readCatalog(agent) {
    const saved = await readJson(agent.catalogFile);
    const efforts = saved?.efforts ?? {}; // filled in place by the live read
    const live = liveCatalog(agent, saved, efforts);
    if (!saved?.models?.length) return live;
    live.catch(() => {});
    return { models: saved.models, efforts, fallback: saved.fallback ?? { levels: [], current: null }, modes: saved.modes ?? null };
  }
  async function liveCatalog(agent, saved, efforts) {
    try {
      const a = await ensureAcp(agent);
      const s = await a.call("session/new", { cwd: process.cwd(), mcpServers: [] });
      const opt = (opts, id) => (opts ?? []).find((o) => o.id === id);
      const levelsOf = (opts) => { const e = opt(opts, "effort"); return e ? { levels: e.options.map((o) => ({ reasoningEffort: o.value, description: o.name })), current: e.currentValue } : { levels: [], current: null }; };
      const models = (opt(s.configOptions, "model")?.options ?? []).filter((m) => m.value !== "default");
      const first = opt(s.configOptions, "model")?.currentValue;
      if (first) efforts[first] = levelsOf(s.configOptions);
      const fallback = first ? efforts[first] : { levels: [], current: null };
      const stale = !saved?.at || now() - saved.at > 86_400_000 || models.some((m) => !efforts[m.value]);
      // The permission modes the agent's own settings allow (Claude's can turn Bypass off), so a
      // refused switch can say why.
      const modes = s.modes?.availableModes?.map((m) => m.id) ?? null;
      await writeJson(agent.catalogFile, { at: stale ? 0 : saved.at, models, efforts, fallback, modes });
      (async () => {
        if (stale) {
          for (const m of models.filter((m) => m.value !== first)) {
            const r = await a.call("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: m.value }).catch(() => null);
            if (r) { efforts[m.value] = levelsOf(r.configOptions); await writeJson(agent.catalogFile, { at: 0, models, efforts, fallback, modes }); }
          }
          await writeJson(agent.catalogFile, { at: now(), models, efforts, fallback, modes });
          log(`${agent.key} catalog: effort levels of ${models.length} models saved`);
        }
        await a.call("session/delete", { sessionId: s.sessionId }).catch(() => {});
      })().catch((e) => log(`${agent.key} catalog refresh: ${e.message ?? JSON.stringify(e)}`));
      return { models, efforts, fallback, modes };
    } catch (e) { log(`${agent.key} catalog: ${e.message}`); return { models: [], efforts: {}, fallback: { levels: [], current: null }, modes: null }; }
  }
  const pendingModelList = new Set();
  const pendingResume = new Map();
  // A Claude model picked as the default ("enter default") lives in the bridge's store, not in
  // config.toml, which plain Elpis also reads. New chats, rewinds and the next start follow it.
  const pendingConfigRead = new Set();
  const pendingStart = new Map();
  let engineDefault = null; // asked once, after the TUI has initialized the engine
  const pendingTurnsList = new Map();
  const pendingItemsList = new Map();
  // Claude-only chats reach the engine as injected history, which never sets a thread's
  // preview, and thread/list leaves out threads without one, so /resume could not find them.
  // The bridge adds them, previewed by their first message, where they fall in the list's order.
  const pendingThreadList = new Map();
  const pendingChildList = new Map(); // thread/loaded/list (null) or thread/list of a chat's descendants (its id)
  const pendingArchive = new Map(); // thread/archive id -> thread id
  const pendingHelperMark = new Set(); // thread/list and thread/read answers: helpers get their chat, bridged chats their model
  // A helper started with the delegate tool is an engine thread the engine does not know as a
  // child; the bridge's record (_delegations) gives it its parent wherever the TUI reads threads.
  // The engine knows only the model it started a bridged chat with; this connection (from the
  // chat's start) or the store (from its first turn) has the real one.
  function ownModel(t, store) {
    const model = providerOwners.get(t.id)?.model() ?? claudeModel.get(t.id) ?? store?.[t.id]?.model;
    if (!model || t.model === model) return false;
    t.model = model;
    t.reasoningEffort = (claudeModel.has(t.id) ? claudeEffort.get(t.id) : store?.[t.id]?.effort) ?? null;
    return true;
  }
  async function markHelpers(result, ancestor) {
    const store = await loadStore();
    const helpers = store._delegations ?? {};
    let changed = false;
    for (const t of [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])]) {
      if (!t || typeof t !== "object") continue;
      if (helpers[t.id] && t.parentThreadId == null) { t.parentThreadId = helpers[t.id].parentThreadId; changed = true; }
      changed = ownModel(t, store) || changed;
    }
    if (ancestor && Array.isArray(result?.data)) {
      const below = new Set([ancestor]);
      for (let grew = true; grew;) { grew = false; for (const [id, d] of Object.entries(helpers)) if (below.has(d.parentThreadId) && !below.has(id)) { below.add(id); grew = true; } }
      const have = new Set(result.data.map((d) => (typeof d === "string" ? d : d.id)));
      for (const id of below) {
        if (id === ancestor || have.has(id)) continue;
        const t = (await engineCall("thread/read", { threadId: id, includeTurns: false }).catch(() => null))?.thread;
        if (t) { result.data.push({ ...t, parentThreadId: helpers[id].parentThreadId }); changed = true; }
      }
    }
    return changed;
  }
  const pageFloor = new Map(); // nextCursor -> sort value of the last thread on the page before it
  const previewed = new Set(); // threads the engine lists itself
  const listField = (req) => ({ updated_at: "updatedAt", recency_at: "recencyAt" })[req.sortKey] ?? "createdAt";
  async function unlistedClaudeThreads(req, page) {
    const field = listField(req);
    const value = (t) => t[field] ?? t.updatedAt ?? 0;
    const ceiling = req.cursor ? pageFloor.get(req.cursor) : Infinity;
    const floor = page.nextCursor && page.data.length ? value(page.data.at(-1)) : -Infinity;
    if (page.nextCursor) pageFloor.set(page.nextCursor, floor);
    if (ceiling === undefined) return [];
    await storeChain;
    const store = await loadStore();
    const have = new Set(page.data.map((t) => t.id));
    const cwds = req.cwd == null ? null : [req.cwd].flat();
    const candidates = Object.entries(store).filter(([id, saved]) =>
      !id.startsWith("_") && !have.has(id) && !previewed.has(id) && saved?.turns?.length && !saved.parentThreadId);
    const out = new Array(candidates.length);
    let next = 0, failure;
    async function readCandidate(index) {
      const [id, saved] = candidates[index];
      const t = (await engineCall("thread/read", { threadId: id, includeTurns: false }, 5000).catch((e) => {
        if (e.code === "ETIMEDOUT") throw e;
        log(`thread/list: cannot read saved thread ${id}: ${e.message ?? JSON.stringify(e)}`);
        return null;
      }))?.thread;
      if (!t) return;
      const interactive = t.source === "cli" || t.source === "vscode" || ["atlas", "chatgpt"].includes(t.source?.custom);
      if (req.sourceKinds?.length ? !req.sourceKinds.includes(t.source) : !interactive) return;
      if (t.preview) { previewed.add(id); return; }
      if (/\/archived_sessions\//.test(t.path ?? "") || (cwds && !cwds.includes(t.cwd))) return;
      if (req.modelProviders?.length && !req.modelProviders.includes(t.modelProvider)) return;
      if (value(t) < floor || value(t) >= ceiling) return;
      const first = saved.turns[0].items?.[0];
      const preview = first?.type === "userMessage" ? inputSummary(first.content ?? []) : first?.type === "enteredReviewMode" ? `Code review: ${first.review}` : "";
      if (req.searchTerm && ![t.name ?? "", preview].some((text) => text.includes(req.searchTerm))) return;
      if (preview.trim()) { const listed = { ...t, preview: preview.trim() }; ownModel(listed, store); out[index] = listed; }
    }
    // The engine serializes reads per thread, so independent roots can overlap. Keep the
    // window bounded and retain store order for equal timestamps despite out-of-order replies.
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (!failure && next < candidates.length) {
        try { await readCandidate(next++); } catch (e) { failure ??= e; }
      }
    }));
    if (failure) throw failure;
    return out.filter(Boolean);
  }
  const engineReqs = new Map();
  let engineSeq = 0;
  const engineCall = (method, params, timeoutMs = 0) => new Promise((resolve, reject) => {
    const id = `acp-bridge-engine-${++engineSeq}`;
    const timer = timeoutMs ? setTimeout(() => {
      engineReqs.delete(id);
      // Shared EngineProxy tracks unanswered frames separately from this bridge's callbacks.
      engine.inflight?.delete(JSON.stringify(id));
      reject(Object.assign(new Error("Reading saved sessions timed out. Retry /resume."), { code: "ETIMEDOUT" }));
      checkIdle();
    }, timeoutMs) : null;
    engineReqs.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
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
    } catch (e) { throw new Error(`Could not read admitted Elpis instructions: ${e.message ?? JSON.stringify(e)}`); }
  }
  // A fork of a Claude chat (/fork, /side, /btw) starts a fresh Claude session; the parent's
  // Claude turns up to the fork point live only in the store, under the parent, so the fork
  // inherits them. The link is kept in memory, and in the store for forks that outlive the chat.
  const forkParent = new Map();
  function claudeTurnsOf(store, threadId, depth = 0) {
    const own = store[threadId]?.turns ?? [];
    const link = forkParent.get(threadId) ?? store[threadId]?.forkOf;
    if (!link || depth > 8) return own;
    const parent = claudeTurnsOf(store, link.threadId, depth + 1);
    const at = (id) => (id ? parent.find((t) => t.id === id)?.startedAt : undefined);
    const before = at(link.beforeTurnId), last = at(link.lastTurnId);
    const kept = parent.filter((t) => (t.startedAt ?? 0) <= link.at && (before == null || (t.startedAt ?? 0) < before) && (last == null || (t.startedAt ?? 0) <= last));
    const have = new Set(own.map((t) => t.id));
    return [...kept.filter((t) => !have.has(t.id)), ...own];
  }
  async function providerHistory(threadId, store) {
    const page = await engineCall("thread/turns/list", { threadId, limit: 200, sortDirection: "desc", itemsView: "full" }).catch(() => null);
    const native = page?.data ?? resumeResults.get(threadId)?.thread?.turns ?? [];
    const running = activeTurns.get(threadId);
    const merged = new Map(native.map((t) => [t.id, t]));
    for (const t of [...claudeTurnsOf(store, threadId), ...(running ? [running.snapshot()] : [])]) merged.set(t.id, t);
    return { turns: [...merged.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)), cursor: page?.nextCursor ?? null };
  }
  async function priorTranscript(threadId) {
    try {
      const r = await engineCall("thread/turns/list", { threadId, limit: 30, sortDirection: "desc", itemsView: "full" }).catch(() => ({ data: [] }));
      await storeChain;
      const stored = claudeTurnsOf(await loadStore(), threadId);
      const have = new Set((r.data ?? []).map((t) => t.id));
      const all = [...(r.data ?? []), ...stored.filter((t) => !have.has(t.id))].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const lines = [];
      for (const turn of all) for (const it of turn.items ?? []) {
        if (it.type === "userMessage") lines.push(`User: ${textOf(it.content)}`);
        else if (it.type === "agentMessage" && it.text?.trim()) lines.push(`Assistant: ${it.text.trim()}`);
        else if (it.type === "commandExecution") lines.push(`(Assistant ran: ${plainCommand(it.command)})`);
        else if (it.type === "fileChange") lines.push(`(Assistant edited: ${(it.changes ?? []).map((c) => c.path).join(", ")})`);
      }
      const t = lines.join("\n\n");
      return t.length > 12000 ? t.slice(-12000) : t;
    } catch (e) { log(`history read for ${threadId}: ${e.message ?? JSON.stringify(e)}`); return ""; }
  }
  // The Ledger's Subagents switch is the engine's `features.multi_agent`, written with
  // config/batchWrite. Asking the engine each Claude turn (~10 ms) follows the switch,
  // /experimental and hand edits alike, as GPT turns do.
  const subagentsAllowed = (cwd) => engineCall("config/read", { includeLayers: false, cwd })
    .then((r) => r?.config?.features?.multi_agent !== false, (e) => { log(`subagents switch unread: ${e.message ?? JSON.stringify(e)}`); return true; });
  const activeTurns = new Map(); // thread id -> its running Claude or Antigravity turn
  const engineTurns = new Map(); // thread id -> its running engine turn
  // Providers may edit without callbacks in Accept edits, Auto, or Bypass. Stop a running turn
  // whose authority a restriction reduces; its next prompt applies the confirmed restricted mode.
  const stopIfReduced = (tid, previousAccess) => {
    const running = activeTurns.get(tid);
    if (!running || AUTHORITY[accessModeOf(tid, "claude", threadPolicy.get(tid) !== "never")] >= AUTHORITY[previousAccess]) return;
    running.cancelled = true;
    if (running.sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId: running.sessionId } });
    notify("warning", { threadId: tid, message: "Stopped the active turn to apply restricted permissions. Send a message to continue." });
  };
  // Sets a helper's profile on this connection's engine; true once the engine confirms it,
  // false if the engine refuses it or does not confirm it in time.
  const confirmations = new Map(); // thread id -> what waits for the profiles its engine confirms
  const HELPER_RESTRICT_MS = 5000;
  const applyProfile = (tid, profile) => new Promise((resolve) => {
    if (threadAccess.get(tid)?.profile === profile) { resolve(true); return; }
    const confirm = (confirmed) => { if (confirmed === profile) settle(true); };
    const settle = (ok, why) => { clearTimeout(timer); confirmations.get(tid)?.delete(confirm); if (!ok) log(`helper ${tid} not set to ${profile}: ${why}`); resolve(ok); };
    const timer = setTimeout(() => settle(false, "no confirmation"), HELPER_RESTRICT_MS);
    if (!confirmations.has(tid)) confirmations.set(tid, new Set());
    confirmations.get(tid).add(confirm);
    engineCall("thread/settings/update", { threadId: tid, permissions: profile }).catch((e) => settle(false, e?.message ?? JSON.stringify(e)));
  });
  const ownHelpers = new Map(); // helper thread id open on this connection -> { applying, waiting, failed }
  // A helper this connection's engine runs, which could not be restricted, stops. A delegate
  // connection serves only its helper: its tool hears that the turn failed, and its engine ends.
  // A TUI's engine also runs the user's other chats: only the helper's turn is interrupted, and
  // the helper runs again only once its restriction applies.
  const failHelper = async (tid, reason) => {
    log(`helper ${tid} stopped: ${reason}`);
    const error = { code: -32600, message: `The helper was stopped: ${reason}.` };
    for (const id of ownHelpers.get(tid)?.waiting.splice(0) ?? []) ws.send(JSON.stringify({ id, error }));
    const turnId = engineTurns.get(tid);
    if (helperConns.has(ws)) {
      if (turnId) ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: tid, turn: { id: turnId, items: [], status: "failed", error: { message: error.message } } } }));
      ws.close();
      engine.kill();
      return;
    }
    if (turnId) {
      const interrupted = engineCall("turn/interrupt", { threadId: tid, turnId }).catch((e) => log(`helper ${tid} interrupt: ${e?.message ?? JSON.stringify(e)}`));
      await Promise.race([interrupted, new Promise((resolve) => setTimeout(resolve, HELPER_RESTRICT_MS))]);
    }
    notify("warning", { threadId: tid, message: `${error.message} It runs again once they apply.` });
  };
  // Restricts an engine helper on this connection to read-only; its turns wait until its engine
  // confirms, and it stops if the engine does not.
  const enforceHelper = (tid) => {
    const own = ownHelpers.get(tid);
    const applying = own.applying = applyProfile(tid, ":read-only").then(async (ok) => {
      own.failed = !ok;
      if (ok) own.waiting.length = 0;
      else await failHelper(tid, "its chat's restricted permissions could not be applied");
      if (own.applying === applying) own.applying = null;
      return ok;
    });
    return applying;
  };
  // Lowers a helper on this connection to read-only. A Claude or Antigravity helper's next tool
  // follows the bridge at once; its engine's copy is only the record. An engine helper's next tool
  // follows its engine.
  const restrictHelper = (tid) => {
    const previousAccess = accessModeOf(tid, "claude", threadPolicy.get(tid) !== "never");
    threadSandbox.set(tid, "read-only");
    stopIfReduced(tid, previousAccess);
    if (claudeModel.has(tid)) { applyProfile(tid, ":read-only"); return null; }
    return enforceHelper(tid);
  };
  // Opens a helper on this connection, under the lower of its known ceiling and `ceiling`.
  const openHelper = (tid, d, ceiling) => {
    let h = helperScope.get(tid);
    if (!h) helperScope.set(tid, h = { parentThreadId: d.parentThreadId, requested: d.requested, ceiling, owners: new Set() });
    if (ceiling === "read-only") h.ceiling = "read-only";
    h.owners.add(restrictHelper);
    ownHelpers.set(tid, { applying: null, waiting: [], failed: false });
    threadSandbox.set(tid, h.ceiling);
    return h;
  };
  // A request for a helper's thread asks for no more than its ceiling: a read-only helper is
  // asked to be read-only, and none is given Full Access. `field` is the request's sandbox field.
  const boundAccess = (p, ceiling, field) => {
    const wide = p.permissions === ":danger-full-access" || p[field] === "danger-full-access" || ["dangerFullAccess", "externalSandbox"].includes(p[field]?.type);
    if (ceiling === "workspace-write" && !wide) return;
    delete p.permissions; delete p[field];
    if (field === "sandbox") p.sandbox = ceiling;
    else p.permissions = ceiling === "read-only" ? ":read-only" : ":workspace";
  };
  // A reopened helper (resumeThread bounded its request): its ceiling, saved if it fell, and its
  // engine checked to be within it. False if the engine could not be brought within it.
  async function adoptHelper(tid, r, bridged) {
    const h = openHelper(tid, r, r.ceiling);
    if (h.ceiling !== r.stored) updateStore((st) => { if (st._delegations?.[tid]) st._delegations[tid].ceiling = h.ceiling; });
    const profile = threadAccess.get(tid)?.profile;
    const want = h.ceiling === "read-only" ? ":read-only" : profile === ":danger-full-access" ? ":workspace" : null;
    if (!want || profile === want) return true;
    if (bridged) { applyProfile(tid, want); return true; }
    const ok = await applyProfile(tid, want);
    ownHelpers.get(tid).failed = !ok;
    return ok;
  }
  // Reopening a helper (by a fresh delegate server, or by the TUI from the agents page) bounds its
  // permissions by its ceiling before the engine loads it, so the reopened thread and what the
  // TUI shows are already within it.
  const pendingAdopt = new Map(); // thread/resume id -> the helper it reopens
  async function resumeThread(msg) {
    const tid = msg.params?.threadId;
    await storeChain;
    const savedStore = await loadStore();
    const d = tid && savedStore._delegations?.[tid];
    const existing = providerOwners.get(tid);
    if (existing && existing.ws !== ws) {
      const route = forwarded.get(msg.id); forwarded.delete(msg.id); pendingResume.delete(msg.id); openingReplies.delete(msg.id);
      existing.dispatch({ ...msg, id: route?.id ?? msg.id }, route?.client ?? ws); return;
    }
    if (claudeModel.has(tid) && resumeResults.has(tid)) {
      const params = { threadId: tid };
      for (const k of ["approvalPolicy", "approvalsReviewer", "permissions", "model", "effort"]) if (msg.params[k] != null) params[k] = msg.params[k];
      if (msg.params.sandbox) params.permissions ??= { "read-only": ":read-only", "workspace-write": ":workspace", "danger-full-access": ":danger-full-access" }[msg.params.sandbox];
      if (d) boundAccess(params, ceilingOf(tid, d), "sandboxPolicy");
      try {
        if (Object.keys(params).length > 1) {
          if (isBridged(params.model)) { claudeModel.set(tid, params.model); delete params.model; }
          await engineCall("thread/settings/update", params);
        }
        const result = { ...resumeResults.get(tid), model: claudeModel.get(tid), reasoningEffort: claudeEffort.get(tid) ?? null };
        const history = await providerHistory(tid, savedStore);
        result.thread = { ...result.thread, ...threadSeen.get(tid), turns: history.turns };
        result.turnsBackwardsCursor = history.cursor;
        await markHelpers(result);
        pendingResume.delete(msg.id);
        toTui({ id: msg.id, result });
        replayPlan(tid);
      } catch (e) { pendingResume.delete(msg.id); toTui({ id: msg.id, error: { code: -32603, message: e.message ?? String(e) } }); }
      return;
    }
    if (!existing && savedStore[tid]?.model) {
      claudeModel.set(tid, savedStore[tid].model);
      if (savedStore[tid].effort) claudeEffort.set(tid, savedStore[tid].effort);
      claimProvider(tid);
    }
    if (d) {
      const r = { parentThreadId: d.parentThreadId, requested: d.requested ?? "read-only", ceiling: ceilingOf(tid, d), stored: d.ceiling };
      pendingHelpers.add(r);
      pendingAdopt.set(msg.id, r);
      boundAccess(msg.params, r.ceiling, "sandbox");
    }
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }
  // A thread/settings/updated that waits for helpers to apply a reduction keeps its place: any
  // later one for this connection waits behind it, so a fast revoke and grant arrive in order.
  let settingsQueue = null;

  lineReader(engine.stdout, async (line) => {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    const th = parsed?.result?.thread ?? parsed?.params?.thread;
    if (th?.id && th?.cwd) { threadCwd.set(th.id, th.cwd); threadSeen.set(th.id, { ...th, turns: [] }); }
    if (th?.id && parsed?.result?.approvalPolicy) { noteAccess(th.id, parsed.result); resumeResults.set(th.id, { ...parsed.result, thread: { ...th } }); }
    if (parsed?.method === "thread/name/updated") {
      const { threadId, threadName } = parsed.params;
      if (threadSeen.has(threadId)) threadSeen.get(threadId).name = threadName;
      if (resumeResults.has(threadId)) resumeResults.get(threadId).thread.name = threadName;
    }
    if (parsed?.method === "turn/started" && parsed.params?.turn?.id) engineTurns.set(parsed.params.threadId, parsed.params.turn.id);
    if (parsed?.method === "turn/completed") { engineTurns.delete(parsed.params?.threadId); checkIdle(); }
    if (parsed?.method === "thread/settings/updated") {
      const tid = parsed.params?.threadId;
      const previousAccess = accessModeOf(tid, "claude", threadPolicy.get(tid) !== "never");
      const reducing = noteAccess(tid, parsed.params?.threadSettings);
      stopIfReduced(tid, previousAccess);
      // The TUI hears of a reduction only once the chat's helpers have applied it.
      if (reducing || settingsQueue) {
        const prior = settingsQueue;
        const mine = settingsQueue = Promise.resolve(prior).then(() => reducing).catch((e) => log(`helper restriction: ${e?.message ?? e}`));
        await mine;
        if (settingsQueue === mine) settingsQueue = null;
      }
    }
    shareHelper(parsed);
    notePlan(parsed);
    if (parsed?.method === "thread/smartPrune/updated" && parsed.params?.threadId) smartPrune.set(parsed.params.threadId, !!parsed.params.smartPrune?.enabled);
    if (parsed?.method && parsed.id !== undefined && ((helperConns.has(ws) && helperThreads.has(parsed.params?.threadId)) || providerOwners.get(parsed.params?.threadId)?.ws === ws)
      && relayToTui(parsed, (reply) => engine.stdin.write(JSON.stringify({ id: parsed.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }) + "\n"), ws)) return;
    if (parsed && engineReqs.has(parsed.id) && !parsed.method) {
      const p = engineReqs.get(parsed.id); engineReqs.delete(parsed.id);
      parsed.error ? p.reject(parsed.error) : p.resolve(parsed.result);
      return;
    }
    // A timed-out internal read may still answer later; it is never a client reply.
    if (!parsed?.method && typeof parsed?.id === "string" && parsed.id.startsWith("acp-bridge-engine-")) return;
    // A chat only the bridge knows (a helper whose one turn failed, so the engine never saved
    // it) archives by leaving the bridge's records.
    if (parsed && pendingArchive.has(parsed.id)) {
      const threadId = pendingArchive.get(parsed.id); pendingArchive.delete(parsed.id);
      if (!parsed.error) {
        providerOwners.delete(threadId); claudeModel.delete(threadId); resumeResults.delete(threadId);
        sessions.delete(threadId); threadSeen.delete(threadId); queues.delete(threadId);
        for (const watched of subscriptions.values()) watched.delete(threadId);
      }
      if (/no rollout found/.test(parsed.error?.message ?? "")) {
        await storeChain;
        const store = await loadStore();
        if (store[threadId] || store._delegations?.[threadId] || claudeModel.has(threadId)) {
          await updateStore((st) => { delete st[threadId]; if (st._delegations) delete st._delegations[threadId]; });
          log(`archived bridge-only thread ${threadId}`);
          ws.send(JSON.stringify({ id: parsed.id, result: {} }));
          notify("thread/archived", { threadId });
          return;
        }
      }
    }
    let helpersMarked = false;
    // A new Claude chat's thread/started can arrive before its thread/start answer; the one
    // bridged start in flight names its model then.
    if (parsed?.method === "thread/started" && parsed.params?.thread) {
      const t = parsed.params.thread;
      await Promise.all([...startingProviders.values()].map((p) => p.ready));
      const starting = [...pendingStart.values()].filter((pick) => pick?.model);
      const pick = !claudeModel.has(t.id) && starting.length === 1 ? starting[0] : null;
      if (pick && t.model !== pick.model) { t.model = pick.model; t.reasoningEffort = pick.effort ?? null; helpersMarked = true; } // shown only; routing waits for the answer
      else helpersMarked = ownModel(t, await loadStore());
    }
    if (parsed && pendingHelperMark.has(parsed.id)) {
      pendingHelperMark.delete(parsed.id);
      helpersMarked = await markHelpers(parsed.result, pendingChildList.get(parsed.id)).catch((e) => { log(`helpers: ${e.message ?? e}`); return false; });
    }
    if (parsed && pendingTurnsList.has(parsed.id)) {
      const req = pendingTurnsList.get(parsed.id); pendingTurnsList.delete(parsed.id);
      await storeChain;
      const running = activeTurns.get(req.threadId);
      const stored = [...((await loadStore())[req.threadId]?.turns ?? []), ...(running ? [running.snapshot()] : [])];
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
    // A chat's Claude subagents join the engine's loaded threads (the TUI's backfill after a
    // resume) and its descendants list (/subagents), so the TUI lists them as its own.
    if (parsed && pendingChildList.has(parsed.id)) {
      const ancestor = pendingChildList.get(parsed.id); pendingChildList.delete(parsed.id);
      const data = parsed.result?.data;
      if (Array.isArray(data)) {
        const kids = await storedChildren(new Set(ancestor ? [ancestor] : data)).catch(() => new Map());
        const have = new Set(data.map((d) => (typeof d === "string" ? d : d.id)));
        const add = [...kids].filter(([id]) => !have.has(id)).map(([id, c]) => (ancestor ? c.thread : id));
        if (add.length) {
          data.push(...add);
          log(`${ancestor ? "thread/list" : "thread/loaded/list"}: +${add.length} Claude subagent threads`);
          ws.send(JSON.stringify(parsed));
          return;
        }
      }
    }
    if (parsed && pendingThreadList.has(parsed.id)) {
      const req = pendingThreadList.get(parsed.id); pendingThreadList.delete(parsed.id);
      if (Array.isArray(parsed.result?.data)) {
        let added;
        try { added = await unlistedClaudeThreads(req, parsed.result); }
        catch (e) {
          log(`thread/list: ${e.message ?? JSON.stringify(e)}`);
          ws.send(JSON.stringify({ id: parsed.id, error: { code: -32603, message: e.message ?? String(e) } }));
          return;
        }
        if (added.length) {
          // Each goes before the first engine thread that sorts after it; the engine's own order stays.
          const field = listField(req);
          const value = (t) => t[field] ?? t.updatedAt ?? 0;
          for (const t of added.sort((a, b) => value(b) - value(a))) {
            const at = parsed.result.data.findIndex((d) => value(d) < value(t));
            parsed.result.data.splice(at < 0 ? parsed.result.data.length : at, 0, t);
          }
          log(`thread/list: +${added.length} Claude-only chats`);
          ws.send(JSON.stringify(parsed));
          return;
        }
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
    if (parsed && pendingDelegation.has(parsed.id)) {
      // A helper started by a chat's delegate tool: remember who started it, for the agent console.
      const d = pendingDelegation.get(parsed.id); pendingDelegation.delete(parsed.id); pendingHelpers.delete(d);
      const tid = parsed.result?.thread?.id;
      if (tid) {
        if (!writableFor(d.parentThreadId)) d.ceiling = "read-only";
        // Its chat lost write access while it was starting.
        if (openHelper(tid, d, d.ceiling).ceiling !== d.sandbox) restrictHelper(tid);
        const { ceiling } = helperScope.get(tid);
        updateStore((st) => { st._delegations = { ...st._delegations, [tid]: { parentThreadId: d.parentThreadId, model: d.model, startedAt: Math.floor(now() / 1000), requested: d.requested, ceiling } }; });
        log(`helper thread ${tid} (${d.model}) started by ${d.parentThreadId}`);
        helperThreads.add(tid);
        toOthers({ method: "thread/started", params: { thread: { ...parsed.result.thread, parentThreadId: d.parentThreadId, turns: [] } }, emittedAtMs: now() });
      }
    }
    if (parsed && pendingStart.has(parsed.id)) {
      const pick = pendingStart.get(parsed.id); pendingStart.delete(parsed.id);
      const tid = parsed.result?.thread?.id;
      const starting = startingProviders.get(`${connectionId}:${parsed.id}`);
      startingProviders.delete(`${connectionId}:${parsed.id}`);
      if (tid && pick?.model) {
        claudeModel.set(tid, pick.model);
        if (pick.effort) claudeEffort.set(tid, pick.effort);
        if (pick.forkOf) {
          forkParent.set(tid, pick.forkOf);
          if (!parsed.result.thread?.ephemeral) updateStore((st) => { st[tid] = { ...st[tid], forkOf: pick.forkOf }; });
        }
        parsed.result.model = pick.model;
        parsed.result.reasoningEffort = pick.effort ?? null;
        Object.assign(parsed.result.thread, { model: pick.model, reasoningEffort: pick.effort ?? null });
        claimProvider(tid, parsed.result);
        if (!parsed.result.thread.ephemeral) await updateStore((st) => { st[tid] = { ...st[tid], model: pick.model, effort: pick.effort ?? null }; });
        starting?.resolve();
        log(`new thread ${tid} -> ${pick.model}`);
        ws.send(JSON.stringify(parsed));
        return;
      }
      starting?.resolve();
    }
    let reopened = null;
    if (parsed?.error && pendingResume.has(parsed.id)) {
      const tid = pendingResume.get(parsed.id); pendingResume.delete(parsed.id);
      if (providerOwners.get(tid)?.ws === ws && !resumeResults.has(tid)) providerOwners.delete(tid);
    }
    if (parsed && pendingAdopt.has(parsed.id) && !parsed.result?.thread?.id) { pendingHelpers.delete(pendingAdopt.get(parsed.id)); pendingAdopt.delete(parsed.id); }
    if (parsed && pendingResume.has(parsed.id) && parsed.result?.thread?.id) {
      pendingResume.delete(parsed.id);
      reopened = parsed.result.thread.id;
      await storeChain;
      const saved = (await loadStore())[parsed.result.thread.id];
      const helper = pendingAdopt.get(parsed.id);
      pendingAdopt.delete(parsed.id); pendingHelpers.delete(helper);
      if (helper && !(await adoptHelper(reopened, helper, !!saved?.model))) {
        ws.send(JSON.stringify({ id: parsed.id, error: { code: -32600, message: "The helper was not reopened: its chat's restricted permissions could not be applied." } }));
        if (helperConns.has(ws)) failHelper(reopened, "its chat's restricted permissions could not be applied");
        return;
      }
      if (saved?.model) {
        claudeModel.set(parsed.result.thread.id, saved.model);
        if (saved.effort) claudeEffort.set(parsed.result.thread.id, saved.effort);
        parsed.result.model = saved.model;
        if (saved.effort) parsed.result.reasoningEffort = saved.effort;
        Object.assign(parsed.result.thread, { model: saved.model, reasoningEffort: saved.effort ?? null });
        claimProvider(parsed.result.thread.id, parsed.result);
        log(`resume ${parsed.result.thread.id} -> ${saved.model}`);
        ws.send(JSON.stringify(parsed));
        replayPlan(parsed.result.thread.id);
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
      const lists = await Promise.all(AGENTS.map((agent) => Promise.race([catalogFor(agent), new Promise((r) => setTimeout(() => r({ models: [], efforts: {}, fallback: null }), 30000))])));
      const tpl = parsed.result.data[0] ?? {};
      const added = [];
      AGENTS.forEach((agent, i) => {
        const { models, efforts, fallback } = lists[i];
        for (const m of models) {
          const id = `${agent.prefix}${m.value}`;
          const e = efforts[m.value] ?? { levels: fallback?.levels ?? [], current: "default" };
          added.push({ ...tpl, id, model: id, inputModalities: ["text", "image"], displayName: `${m.name} (${agent.label})`, description: m.description ?? agent.description, hidden: false, isDefault: false, upgrade: null, upgradeInfo: null, supportedReasoningEfforts: e.levels, defaultReasoningEffort: e.current ?? "default",
            // The template's GPT-only options, which a subscription model does not have (Claude's
            // Fast mode bills extra usage, not the plan).
            additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availabilityNux: null, availableAccessPrograms: null, modelSpecialty: null, supportsPersonality: false });
        }
      });
      parsed.result.data.unshift(...added);
      log(`model/list: added ${added.length} subscription models`);
      ws.send(JSON.stringify(parsed));
      return;
    }
    ws.send(helpersMarked ? JSON.stringify(parsed) : line);
    if (reopened) replayPlan(reopened);
  });

  const askTui = (method, params) => new Promise((resolve) => {
    if (!relayToTui({ method, params }, (reply) => resolve(reply.result), ws)) resolve(null);
  });

  // One transcript drawn from Claude's ACP updates: the chat's turn (`root`), or the turn of a
  // subagent Claude started, in that subagent's child thread. Only the chat's own lane counts
  // toward the chat's context and usage.
  function newLane(threadId, turnId, cwd, root) {
    const lane = { threadId, turnId, items: [], tools: new Map(), message: null, lastPlan: null, done: false, onIdle: () => {} };
    const chars = (part, n) => { if (root) addChars(threadId, part, n); };
    lane.say = (item) => {
      lane.closeMessage();
      notify("item/started", { item, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
      lane.items.push(item);
    };
    // A subagent's start and end, as the rows Elpis's own subagents leave in their parent's turn.
    lane.activity = (kind, agentThreadId, name) => {
      lane.closeMessage();
      const item = { type: "subAgentActivity", id: randomUUID(), kind, agentThreadId, agentPath: name };
      notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
      lane.items.push(item);
    };
    lane.closeMessage = () => {
      if (!lane.message) return;
      notify("item/completed", { item: lane.message, threadId, turnId, completedAtMs: now() });
      lane.items.push(lane.message);
      lane.message = null;
    };
    lane.turn = () => ({ id: turnId, items: [...lane.items], itemsView: "full", status: lane.done ? "completed" : "inProgress", error: null, startedAt: lane.startedAt ?? null, completedAt: null, durationMs: null });
    lane.update = (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        if (!lane.message) {
          lane.message = { type: "agentMessage", id: `msg_${randomUUID()}`, text: "", phase: null, memoryCitation: null, delivery: null, questions: null };
          notify("item/started", { item: lane.message, threadId, turnId, startedAtMs: now() });
        }
        lane.message.text += u.content.text;
        chars("agent", u.content.text.length);
        notify("item/agentMessage/delta", { threadId, turnId, itemId: lane.message.id, delta: u.content.text });
      } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
        chars("reasoning", u.content.text.length);
      } else if (u.sessionUpdate === "usage_update" && typeof u.used === "number") {
        if (!root) return;
        lastContext.set(threadId, { used: u.used, size: u.size ?? null });
        sendUsage(threadId, turnId, null);
      } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
        const step = { pending: "pending", in_progress: "inProgress", completed: "completed" };
        const plan = u.entries.map((e) => ({ step: e.content, status: step[e.status] ?? "pending" }));
        // The adapter repeats an unchanged list (each task tool reports it twice); one row each.
        if (JSON.stringify(plan) === lane.lastPlan) return;
        lane.lastPlan = JSON.stringify(plan);
        notify("turn/plan/updated", { threadId, turnId, explanation: null, plan });
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        let t = lane.tools.get(u.toolCallId);
        if (!t) {
          if (u.sessionUpdate !== "tool_call") return;
          lane.closeMessage();
          t = { name: u.kind, title: null, raw: {}, response: null, text: null, diffs: [], status: "inProgress", declined: false, shown: false, start: now(), end: null };
          lane.tools.set(u.toolCallId, t);
        }
        const cc = u._meta?.claudeCode;
        if (cc?.toolName) t.name = cc.toolName;
        if (u.title) t.title = u.title;
        if (u.rawInput && Object.keys(u.rawInput).length) t.raw = u.rawInput;
        if (cc?.toolResponse) t.response = cc.toolResponse;
        for (const c of u.content ?? []) { if (c.type === "diff") t.diffs.push(c); else if (c.content?.type === "text") t.text = c.content.text; }
        const finished = u.status === "completed" || u.status === "failed";
        if (finished) { t.status = u.status; t.end = now(); lane.onIdle(); }
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
          lane.items.push(item);
          chars("toolCalls", JSON.stringify(t.raw).length);
          chars("toolResults", (item.aggregatedOutput ?? item.changes?.map((c) => c.diff).join("") ?? "").length);
        }
      }
    };
    // The open message and any row still running are closed, so nothing spins forever.
    lane.end = () => {
      lane.closeMessage();
      for (const [id, t] of lane.tools) {
        if (!t.shown || t.end) continue;
        t.status = "failed"; t.end = now();
        notify("item/completed", { item: toolItem(id, t, cwd), threadId, turnId, completedAtMs: now() });
      }
    };
    return lane;
  }

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

    const cwd = threadCwd.get(threadId) ?? process.cwd();
    const lane = newLane(threadId, turnId, cwd, true);
    const { items, tools, closeMessage } = lane;
    // Claude's subagents in this turn: ACP session -> the child thread's lane.
    const subLanes = new Map();
    const busy = () => [...tools.values()].some((t) => !t.end) || [...subLanes.values()].some((l) => !l.done);
    // The running turn, from its first moment, so a steer or a stop during setup finds it.
    let sessionReady, finishTurn;
    const done = new Promise((resolve) => { finishTurn = resolve; });
    const turnState = { threadId, turnId, done, sessionId: null, items, closeMessage, cancelled: false, ready: new Promise((r) => { sessionReady = r; }), toolsIdle: [] };
    // Claude Code takes a steer at once and drops a tool that is still running (a subagent too),
    // so a steer waits for the running tools, as Claude Code's own queue does.
    turnState.whenToolsIdle = () => (!busy() ? Promise.resolve() : new Promise((r) => turnState.toolsIdle.push(r)));
    lane.onIdle = () => { if (!busy()) turnState.toolsIdle.splice(0).forEach((r) => r()); };
    turnState.snapshot = () => ({ ...turn, startedAt, itemsView: "full", items: [userItem, ...items, ...(lane.message ? [lane.message] : [])] });
    activeTurns.set(threadId, turnState);
    let status = "completed";
    let error = null;
    const agent = agentOf(claudeModel.get(threadId)) ?? AGENTS[0];
    try {
      const acp = await ensureAcp(agent);
      turnState.acp = acp;
      // The engine's confirmed policy only: the TUI puts its own choice on every turn/start,
      // also one the engine has not accepted yet, or refused.
      const policy = threadPolicy.get(threadId) ?? "on-request";
      const ask = policy !== "never";
      const mode = ask ? "ask" : "full";
      const subagents = await subagentsAllowed(cwd);
      let live = sessions.get(threadId);
      let sessionId = null;
      let freshSession = false;
      // Smart Prune on: Claude's requests go through the proxy (`smartPruneProxy`).
      const prune = agent.key === "claude" && smartPrune.get(threadId) === true;
      // Capture admitted context at the turn boundary. Changed instructions (including an empty
      // selection), approval mode, Subagents or Smart Prune reload the native conversation.
      // Nothing reloads an in-flight turn; a changed agent starts afresh.
      const instructions = await elpisInstructions(threadId);
      if (live && live.mode === mode && live.subagents === subagents && live.agent === agent.key && live.prune === prune && live.instructions === instructions) sessionId = live.id;
      else {
        const cwd = threadCwd.get(threadId) ?? process.cwd();
        const proxy = prune ? await smartPruneProxy() : null;
        const options = { ...(ask && { settingSources: ["project", "local"] }), ...(!subagents && { disallowedTools: SUBAGENT_TOOLS }), ...(proxy && { env: { ANTHROPIC_BASE_URL: proxy, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") } }) };
        const _meta = { systemPrompt: { append: instructions }, claudeCode: { options, emitRawSDKMessages: [{ type: "system", subtype: "init" }] } };
        devChars.set(threadId, instructions.length);
        log(`Elpis instructions for ${agent.speaker}: ${instructions.length} chars`);
        await storeChain;
        const store = await loadStore();
        const helper = !!store._delegations?.[threadId] || !!store[threadId]?.parentThreadId;
        const mcpServers = mcpServersFor(subagents, threadId, helper ? null : cwd);
        // A session belongs to one agent; a chat that switched agent starts a fresh one, seeded below.
        const sameAgent = (store[threadId]?.agent ?? "claude") === agent.key;
        const saved = (live?.agent === agent.key ? live.id : null) ?? (sameAgent ? store[threadId]?.session ?? Object.values(store[threadId]?.sessions ?? {})[0] : null);
        if (saved) {
          acp.loading.add(saved);
          try { await acp.call("session/load", { sessionId: saved, cwd, mcpServers, _meta }); sessionId = saved; log(`session ${saved} reloaded for thread ${threadId} (subagents ${subagents ? "on" : "off"})`); }
          catch (e) { log(`session reload failed: ${e.message ?? JSON.stringify(e)}`); }
          acp.loading.delete(saved);
        }
        if (!sessionId) {
          sessionId = (await acp.call("session/new", { cwd, mcpServers, _meta })).sessionId;
          freshSession = true;
          log(`session ${sessionId} for thread ${threadId} in ${cwd} (${ask ? "Elpis asks" : "full access"}, policy ${policy}, subagents ${subagents ? "on" : "off"})`);
        }
        live = { id: sessionId, mode, subagents, agent: agent.key, prune, instructions };
        sessions.set(threadId, live);
        const sid = sessionId;
        updateStore((st) => { st[threadId] = { ...st[threadId], session: sid, mode, agent: agent.key }; });
      }
      updateStore((st) => { st[threadId] = { ...st[threadId], model: claudeModel.get(threadId), effort: claudeEffort.get(threadId) ?? null }; });
      const want = claudeModel.get(threadId)?.slice(agent.prefix.length);
      if (want && sessionModel.get(sessionId) !== want) {
        await acp.call("session/set_config_option", { sessionId, configId: "model", value: want });
        sessionModel.set(sessionId, want);
        log(`session ${sessionId} model -> ${want}`);
      }
      const wantMode = claudeModeOf(threadId, agent.key, ask);
      if (sessionMode.get(sessionId) !== wantMode) {
        await acp.call("session/set_mode", { sessionId, modeId: wantMode })
          .then(() => { sessionMode.set(sessionId, wantMode); log(`session ${sessionId} mode -> ${wantMode}`); })
          .catch(async (e) => {
            log(`mode ${wantMode}: ${e.message ?? JSON.stringify(e)}`);
            // A refused Bypass changes nothing the user sees: Full Access answers every question.
            if (wantMode === "bypassPermissions") return;
            const allowed = (await catalogFor(agent)).modes;
            const why = allowed && !allowed.includes(wantMode) ? `${agent.speaker}'s own settings turn it off` : (e.message ?? "it refused");
            const kept = MODE_NAMES[sessionMode.get(sessionId)];
            throw new Error(`${agent.speaker} did not switch to ${MODE_NAMES[wantMode] ?? wantMode}: ${why}. ${kept ? `It stays in ${kept}.` : "Its mode is unchanged."} The turn was not started.`);
          });
      }
      const effort = claudeEffort.get(threadId);
      const known = (await catalogFor(agent)).efforts[want];
      if (effort && (!known || known.levels.some((l) => l.reasoningEffort === effort))) await acp.call("session/set_config_option", { sessionId, configId: "effort", value: effort }).catch((e) => log(`effort ${effort}: ${e.message}`));
      turnState.sessionId = sessionId;
      sessionReady(sessionId);
      // The chat's updates draw into this turn; a subagent's come under its own ACP session and
      // draw into its child thread (see spawnSubagent). The turn hears only its own sessions.
      const own = turnState.own = {};
      own.onUpdate = ({ sessionId: sid, update: u }) => {
        if (u.sessionUpdate === "subagent_spawned") { spawnSubagent(u, sid === sessionId ? lane : subLanes.get(sid) ?? lane); return; }
        if (u.sessionUpdate === "subagent_state_update") { finishSubagent(subLanes.get(u.subagentSessionId), u.state); return; }
        const into = sid === sessionId ? lane : subLanes.get(sid);
        if (!into) { log(`update for unknown session ${sid}: ${u.sessionUpdate}`); return; }
        if (into === lane && u.sessionUpdate === "agent_message_chunk") firstTokenAt ??= now();
        into.update(u);
      };
      const spawnSubagent = (u, parent) => {
        if (!u.subagentSessionId || subLanes.has(u.subagentSessionId)) return;
        const childId = randomUUID();
        const name = u.name?.trim() || "Claude subagent";
        const task = (u.prompt ?? u.task ?? "").trim();
        const base = threadSeen.get(threadId) ?? {};
        const t = Math.floor(now() / 1000);
        const depth = (parent.depth ?? 0) + 1;
        const thread = {
          ...base, id: childId, turns: [], forkedFromId: null, parentThreadId: parent.threadId, preview: task.slice(0, 200), ephemeral: false,
          name, agentNickname: name, agentRole: "Claude", canAcceptDirectInput: false, threadSource: "subagent", historyMode: "legacy",
          source: { subAgent: { thread_spawn: { parent_thread_id: parent.threadId, depth, agent_path: null, agent_nickname: name, agent_role: "Claude" } } },
          model: claudeModel.get(threadId) ?? base.model ?? null, createdAt: t, updatedAt: t, recencyAt: t, path: null,
        };
        const sub = newLane(childId, randomUUID(), cwd, false);
        sub.depth = depth; sub.name = name; sub.parent = parent; sub.startedAt = t;
        subLanes.set(u.subagentSessionId, sub);
        acp.bySession.set(u.subagentSessionId, own);
        childThreads.set(childId, { thread, lane: sub, rootThreadId: threadId });
        childIds.add(childId);
        log(`claude subagent "${name}" (session ${u.subagentSessionId}) -> child thread ${childId} of ${parent.threadId}`);
        notify("thread/started", { thread: { ...thread, status: { type: "active", activeFlags: [] } } });
        parent.activity("started", childId, name);
        notify("thread/status/changed", { threadId: childId, status: { type: "active", activeFlags: [] } });
        notify("turn/started", { threadId: childId, turn: { id: sub.turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: t, completedAt: null, durationMs: null } });
        sub.say({ type: "userMessage", id: randomUUID(), clientId: null, content: [{ type: "text", text: task || name, text_elements: [] }] });
      };
      const finishSubagent = (sub, state) => {
        if (!sub || sub.done) return;
        sub.end();
        sub.done = true;
        const turnStatus = state === "completed" ? "completed" : state === "failed" ? "failed" : "interrupted";
        const completedAt = Math.floor(now() / 1000);
        const record = { ...sub.turn(), status: turnStatus, completedAt, durationMs: (completedAt - sub.startedAt) * 1000 };
        notify("turn/completed", { threadId: sub.threadId, turn: { ...record, itemsView: "summary" } });
        notify("thread/status/changed", { threadId: sub.threadId, status: { type: "idle" } });
        sub.parent.activity(state === "completed" ? "completed" : "interrupted", sub.threadId, sub.name);
        log(`claude subagent "${sub.name}" ${state} (child thread ${sub.threadId})`);
        const thread = { ...childThreads.get(sub.threadId).thread, status: { type: "idle" } };
        updateStore((st) => { st[sub.threadId] = { parentThreadId: sub.parent.threadId, rootThreadId: threadId, thread, turns: [clipTurn(record)] }; });
        lane.onIdle();
      };
      turnState.endSubagents = () => { for (const sub of subLanes.values()) finishSubagent(sub, "cancelled"); };
      own.onPermission = async (p) => {
        const t = [lane, ...subLanes.values()].map((l) => l.tools.get(p.toolCall?.toolCallId)).find(Boolean);
        const what = (t && t.name === "Bash" && t.raw.command) || p.toolCall?.title || t?.title || "a tool";
        const pick = (kind) => p.options.find((o) => o.kind === kind)?.optionId;
        if (turnState.cancelled) return undefined;
        let access = accessModeOf(threadId, agent.key, (threadPolicy.get(threadId) ?? policy) !== "never");
        // Approving a plan is the user's to decide, in every mode (as Codex asks to implement it).
        const planIds = p.options.map((o) => o.optionId).filter((id) => id?.startsWith("exit-plan-"));
        // Full Access never asks, as in Codex: whatever the agent's own mode (its settings may
        // refuse Bypass, Claude Code still asks before writing in .claude, and a Plan turn goes on
        // after its plan), the bridge says yes.
        if (access === "bypassPermissions" && !planIds.length) {
          log(`approval ${what} -> allowed (Full Access)`);
          return pick("allow_once") ?? pick("allow_always");
        }
        if ((threadPolicy.get(threadId) ?? policy) === "never" && !planIds.length) {
          log(`approval ${what} -> denied (restricted permissions cannot ask)`);
          if (t) t.declined = true;
          return pick("reject_once") ?? pick("reject_always") ?? null;
        }
        const decision = await askTui("item/commandExecution/requestApproval", {
          kind: "command", threadId, turnId, itemId: p.toolCall?.toolCallId ?? randomUUID(), startedAtMs: now(),
          environmentId: null, reason: `${agent.speaker} wants to run: ${what}`, command: what, cwd,
          // No "don't ask again": Claude Code would save that rule to the project for good,
          // while Elpis's label promises only this session.
          availableDecisions: ["accept", "decline", "cancel"],
        });
        if (turnState.cancelled) return undefined;
        access = accessModeOf(threadId, agent.key, (threadPolicy.get(threadId) ?? policy) !== "never");
        if ((threadPolicy.get(threadId) ?? policy) === "never" && access !== "bypassPermissions" && !planIds.length) {
          if (t) t.declined = true;
          return pick("reject_once") ?? pick("reject_always") ?? null;
        }
        const d = decision?.decision;
        log(`approval ${what} -> ${JSON.stringify(d)}`);
        if (d === "accept" && planIds.length) {
          // An approved plan goes on in the chat's permission mode, not Claude's "manually
          // approve edits". Claude offers Accept edits only when it offers neither Auto nor Bypass;
          // then the bridge switches to it once Claude has left Plan.
          const want = { bypassPermissions: ["bypass", "auto", "accept-edits"], auto: ["auto", "accept-edits"], acceptEdits: ["accept-edits"] }[access] ?? [];
          const id = want.map((m) => `exit-plan-${m}`).find((x) => planIds.includes(x)) ?? "exit-plan-default";
          const mode = { "exit-plan-bypass": "bypassPermissions", "exit-plan-auto": "auto", "exit-plan-accept-edits": "acceptEdits" }[id] ?? "default";
          sessionMode.set(sessionId, mode);
          if (access === "acceptEdits" && mode === "default") {
            setTimeout(() => {
              if (turnState.cancelled || activeTurns.get(threadId) !== turnState
                || accessModeOf(threadId, agent.key, (threadPolicy.get(threadId) ?? policy) !== "never") !== "acceptEdits") return;
              acp.call("session/set_mode", { sessionId, modeId: "acceptEdits" })
                .then(() => { sessionMode.set(sessionId, "acceptEdits"); log(`session ${sessionId} mode -> acceptEdits (plan approved)`); })
                .catch((e) => log(`mode acceptEdits after the plan: ${e.message ?? JSON.stringify(e)}`));
            }, 200);
          }
          log(`plan approved: ${id}`);
          return planIds.includes(id) ? id : pick("allow_once");
        }
        if (d === "accept") return pick("allow_once") ?? pick("allow_always");
        if (t) t.declined = true;
        if (d === "cancel") {
          // "No, and tell Elpis what to do differently": stop the reply so the user can answer.
          turnState.cancelled = true;
          setImmediate(() => acp.send({ method: "session/cancel", params: { sessionId } }));
        }
        return pick("reject_once") ?? pick("reject_always") ?? null;
      };
      acp.bySession.set(sessionId, own);
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
        else if (it.type === "commandExecution") used.push(plainCommand(it.command));
        else if (it.type === "fileChange") used.push(`edited ${it.changes.map((c) => c.path).join(", ")}`);
        else if (it.type === "subAgentActivity" && it.kind === "started") used.push(`started the subagent "${it.agentPath}"`);
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
    sessionReady(null);
    // The ended turn answers for its sessions no more: a late approval from them is refused.
    for (const sid of [turnState.sessionId, ...subLanes.keys()]) {
      if (turnState.own && turnState.acp.bySession.get(sid) === turnState.own) turnState.acp.bySession.delete(sid);
    }
    // A subagent or row still running when the turn ends (stop, error) must not spin forever.
    turnState.endSubagents?.();
    lane.end();
    if (req.kind === "review") {
      const exit = { type: "exitedReviewMode", id: randomUUID(), review: items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n\n").trim() };
      notify("item/started", { item: exit, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item: exit, threadId, turnId, completedAtMs: now() });
      items.push(exit);
    }
    if (activeTurns.get(threadId) === turnState) activeTurns.delete(threadId);
    cancelRelays(ws, threadId, turnId);
    turnState.toolsIdle.splice(0).forEach((r) => r());
    const completedAt = Math.floor(now() / 1000);
    {
      const record = clipTurn({ id: turnId, items: [userItem, ...items], itemsView: "full", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 });
      await updateStore((st) => { st[threadId] = { ...st[threadId], turns: [...(st[threadId]?.turns ?? []), record].slice(-200) }; });
    }
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
    notify("turn/activityUpdated", { threadId, turnId, status: status === "inProgress" ? "completed" : status, durationMs: now() - t0, timeToFirstTokenMs: firstTokenAt ? firstTokenAt - t0 : null });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    agent.limits().then((all) => { for (const rateLimits of all) { log(`${rateLimits.limitName} limits: 5h ${rateLimits.primary?.usedPercent}% week ${rateLimits.secondary?.usedPercent}%`); notify("account/rateLimits/updated", { rateLimits }); } })
      .catch((e) => log(`${agent.key} limits: ${e.message}`));
    if (agent.key === "agy") recordAccounts().catch((e) => log(`accounts: ${e.message}`));
    setImmediate(() => runNext(threadId));
    const used = lastTurnUsage.get(threadId) ?? {};
    finishTurn();
    return { status, turnId, seconds: completedAt - startedAt, tokens: (used.input ?? 0) + (used.cachedRead ?? 0) + (used.cachedWrite ?? 0) + (used.output ?? 0) };
  }

  // A Claude chat's queued messages (elpis queue, thread/queue/*) and Claude Code's own /goal
  // (thread/goal/*): each runs as the chat's next Claude turn once the running one ends.
  const queues = new Map(); // thread id -> [{ id, input, clientUserMessageId, goal? }]
  const queueOf = (threadId) => queues.get(threadId) ?? queues.set(threadId, []).get(threadId);
  const shown = (threadId) => queueOf(threadId).filter((q) => !q.goal).map(({ id, input, clientUserMessageId }) => ({ id, input, clientUserMessageId }));
  function runNext(threadId) {
    if (activeTurns.has(threadId)) return;
    const next = queueOf(threadId).shift();
    if (!next) return;
    if (!next.goal) notify("thread/queue/changed", { threadId });
    claudeTurn({ kind: next.goal ? "goal" : "queued", params: { threadId, input: next.input } }).then((r) => next.after?.(r));
  }
  function queueRequest(msg) {
    const { threadId } = msg.params;
    const q = queueOf(threadId);
    const find = (id) => q.findIndex((e) => e.id === id && !e.goal);
    const changed = () => notify("thread/queue/changed", { threadId });
    switch (msg.method) {
      case "thread/queue/add": {
        const entry = { id: randomUUID(), input: msg.params.input ?? [], clientUserMessageId: msg.params.clientUserMessageId };
        q.push(entry);
        toTui({ id: msg.id, result: { queuedSubmission: { id: entry.id, input: entry.input, clientUserMessageId: entry.clientUserMessageId } } });
        changed(); runNext(threadId); return;
      }
      case "thread/queue/list": toTui({ id: msg.id, result: { data: shown(threadId), nextCursor: null } }); return;
      case "thread/queue/update": {
        const i = find(msg.params.queuedSubmissionId);
        if (i < 0) { toTui({ id: msg.id, error: { code: -32600, message: "no such queued message" } }); return; }
        q[i].input = msg.params.input ?? [];
        toTui({ id: msg.id, result: { queuedSubmission: shown(threadId).find((e) => e.id === q[i].id) } }); changed(); return;
      }
      case "thread/queue/delete": {
        const i = find(msg.params.queuedSubmissionId);
        if (i >= 0) q.splice(i, 1);
        toTui({ id: msg.id, result: { deleted: i >= 0 } }); if (i >= 0) changed(); return;
      }
      case "thread/queue/reorder": {
        const order = msg.params.queuedSubmissionIds ?? [];
        q.sort((a, b) => (order.indexOf(a.id) >>> 0) - (order.indexOf(b.id) >>> 0));
        toTui({ id: msg.id, result: {} }); changed(); return;
      }
      case "thread/queue/start": {
        if (activeTurns.has(threadId)) { toTui({ id: msg.id, error: { code: -32600, message: "thread already has an active or pending turn" } }); return; }
        const i = msg.params.queuedSubmissionId ? find(msg.params.queuedSubmissionId) : q.findIndex((e) => !e.goal);
        if (i < 0) { toTui({ id: msg.id, error: { code: -32600, message: "no queued message to start" } }); return; }
        const [entry] = q.splice(i, 1);
        changed();
        claudeTurn({ id: msg.id, kind: "queued", params: { threadId, input: entry.input } });
        return;
      }
    }
  }

  // Elpis's goal record for a Claude chat (kept in the store, so it survives a restart).
  const goals = new Map();
  const nowSecs = () => Math.floor(now() / 1000);
  async function goalOf(threadId) {
    if (!goals.has(threadId)) { await storeChain; goals.set(threadId, (await loadStore())[threadId]?.goal ?? null); }
    return goals.get(threadId);
  }
  function saveGoal(threadId, goal) {
    goals.set(threadId, goal);
    updateStore((st) => { st[threadId] = { ...st[threadId], goal }; });
  }
  function pursue(threadId, text, goal) {
    const entry = { id: randomUUID(), goal: true, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: randomUUID() };
    if (goal) entry.after = (r) => {
      const now_ = goals.get(threadId);
      if (!now_ || now_.objective !== goal.objective || now_.status !== "active") return;
      const status = r.status === "completed" ? "complete" : r.status === "interrupted" ? "paused" : "blocked";
      const next = { ...now_, status, tokensUsed: now_.tokensUsed + r.tokens, timeUsedSeconds: now_.timeUsedSeconds + r.seconds, updatedAt: nowSecs() };
      saveGoal(threadId, next);
      notify("thread/goal/updated", { threadId, turnId: r.turnId, goal: next });
    };
    queueOf(threadId).push(entry);
    runNext(threadId);
  }
  async function goalRequest(msg) {
    const { threadId } = msg.params;
    const prev = await goalOf(threadId);
    if (msg.method === "thread/goal/get") { toTui({ id: msg.id, result: { goal: prev } }); return; }
    if (msg.method === "thread/goal/clear") {
      saveGoal(threadId, null);
      toTui({ id: msg.id, result: { cleared: !!prev } });
      if (prev) { notify("thread/goal/cleared", { threadId }); if (prev.status === "active") pursue(threadId, "/goal clear", null); }
      return;
    }
    const { objective, status = "active", tokenBudget } = msg.params;
    const text = objective?.trim() || prev?.objective;
    if (!text) { toTui({ id: msg.id, error: { code: -32600, message: "This chat has no goal to update." } }); return; }
    const fresh = !prev || text !== prev.objective;
    const goal = { threadId, objective: text, status, tokenBudget: tokenBudget === undefined ? prev?.tokenBudget ?? null : tokenBudget, tokensUsed: fresh ? 0 : prev.tokensUsed, timeUsedSeconds: fresh ? 0 : prev.timeUsedSeconds, createdAt: fresh ? nowSecs() : prev.createdAt, updatedAt: nowSecs() };
    saveGoal(threadId, goal);
    toTui({ id: msg.id, result: { goal } });
    notify("thread/goal/updated", { threadId, turnId: null, goal });
    if (status === "active") pursue(threadId, `/goal ${text}`, goal);
    else if (prev?.status === "active") pursue(threadId, "/goal clear", null);
  }

  // A new chat on a Claude model: the engine keeps its own model, the TUI is told Claude.
  async function startThread(msg) {
    const p = msg.params ?? {};
    if (p.elpisParentThreadId) {
      // The helper's ceiling (helperScope): its chat's Full Access is never passed on.
      const parentThreadId = p.elpisParentThreadId;
      const requested = p.sandbox === "workspace-write" ? "workspace-write" : "read-only";
      p.sandbox = requested === "workspace-write" && writableFor(parentThreadId) ? "workspace-write" : "read-only";
      delete p.permissions;
      const d = { parentThreadId, model: p.model ?? null, sandbox: p.sandbox, requested, ceiling: p.sandbox };
      pendingDelegation.set(msg.id, d);
      pendingHelpers.add(d);
      // The helper asks before acting when its chat does.
      const inherited = chatAccess.get(parentThreadId)?.policy;
      if (inherited && inherited !== "never") p.approvalPolicy = inherited;
      delete p.elpisParentThreadId;
    }
    let pick = null;
    if (isBridged(p.model)) pick = { model: p.model, effort: p.config?.model_reasoning_effort ?? null };
    else {
      await storeChain;
      const def = (await loadStore())._default;
      engineDefault ??= engineCall("config/read", { includeLayers: false }).then((r) => r?.config?.model ?? null, () => null);
      if (def?.model && (p.model == null || p.model === await engineDefault)) pick = def;
    }
    if (pick) {
      rememberStart(msg.id, pick);
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

  // Chat titles and /recap on a Claude chat: the TUI starts a hidden ephemeral thread on the
  // chat's model and asks for JSON. A one-off Claude session with no tools, no MCP servers and
  // no user settings answers it; nothing is recorded in the store or the engine.
  const structured = new Map(); // hidden thread -> its Claude session
  async function structuredClaude(msg) {
    const { threadId, input = [], outputSchema = null } = msg.params;
    const turnId = randomUUID();
    const startedAt = Math.floor(now() / 1000);
    const turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    toTui({ id: msg.id, result: { turn } });
    notify("turn/started", { threadId, turn: { ...turn, startedAt } });
    const items = [];
    let status = "completed", error = null, sessionId = null, a = null;
    try {
      // Hidden requests always go to Claude (Haiku), whichever subscription the chat uses.
      a = await ensureAcp(AGENTS[0]);
      sessionId = (await a.call("session/new", { cwd: threadCwd.get(threadId) ?? process.cwd(), mcpServers: [], _meta: { systemPrompt: STRUCTURED_SYSTEM, claudeCode: { options: { tools: [], settingSources: [] } } } })).sessionId;
      let text = "";
      a.bySession.set(sessionId, { onUpdate: ({ update: u }) => { if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text; } });
      structured.set(threadId, sessionId);
      await a.call("session/set_config_option", { sessionId, configId: "model", value: STRUCTURED_MODEL });
      const ask = outputSchema ? `${inputSummary(input)}\n\nAnswer with only one JSON object that matches this JSON Schema:\n${JSON.stringify(outputSchema)}` : inputSummary(input);
      const r = await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text: ask }] });
      if (r.stopReason === "cancelled") status = "interrupted";
      else {
        const answer = outputSchema ? jsonIn(text) : text.trim();
        if (!answer) throw new Error(`Claude did not answer with JSON: ${text.slice(0, 200)}`);
        const item = { type: "agentMessage", id: `msg_${randomUUID()}`, text: answer, phase: null, memoryCitation: null, delivery: null, questions: null };
        notify("item/started", { item, threadId, turnId, startedAtMs: now() });
        notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
        items.push(item);
      }
      log(`structured request on Claude ${STRUCTURED_MODEL} for hidden thread ${threadId}: ${status}`);
    } catch (e) {
      status = "failed";
      error = { message: `Claude (ACP) error: ${e?.message ?? JSON.stringify(e)}`, codexErrorInfo: null, additionalDetails: null };
      log(`structured request error ${JSON.stringify(e?.message ?? e)}`);
    }
    structured.delete(threadId);
    if (sessionId) { a?.bySession.delete(sessionId); a?.call("session/delete", { sessionId }).catch(() => {}); }
    const completedAt = Math.floor(now() / 1000);
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
  }

  // A message sent while Claude works joins that reply instead of stopping it. With no
  // running Claude turn, the TUI's "no active turn to steer" fallback starts a new turn.
  async function steerClaude(msg) {
    const { threadId, input = [], clientUserMessageId = null } = msg.params;
    const refuse = () => toTui({ id: msg.id, error: { code: -32600, message: "no active turn to steer" } });
    const turn = activeTurns.get(threadId);
    if (!turn) return refuse();
    const sessionId = await turn.ready;
    await turn.whenToolsIdle();
    if (!sessionId || activeTurns.get(threadId) !== turn || turn.cancelled) return refuse();
    try {
      const r = await turn.acp.call("_session/steering", { sessionId, prompt: await toAcpPrompt(input), _meta: { steering: { idleBehavior: "promptRequired" } } });
      if (r?.outcome === "promptRequired") return refuse();
      toTui({ id: msg.id, result: { turnId: turn.turnId } });
      if (r?._meta?.delivery === "nextTurn") {
        notify("warning", { threadId, message: "Gemini will read this message after its current reply finishes." });
      }
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

  async function archiveProvider(msg) {
    const tid = msg.params.threadId;
    queueOf(tid).splice(0);
    const running = activeTurns.get(tid);
    try {
      if (running) {
        running.cancelled = true;
        const sessionId = await running.ready;
        if (sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId } });
        let timer;
        try {
          await Promise.race([running.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The provider has not stopped yet; the chat was not archived.")), 10000); })]);
        } finally { clearTimeout(timer); }
      }
      engine.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) { pendingArchive.delete(msg.id); toTui({ id: msg.id, error: { code: -32603, message: e.message } }); }
  }
  const openingReplies = new Set();
  function handleMessage(data) {
    const line = data.toString();
    let msg;
    try { msg = JSON.parse(line); } catch { engine.stdin.write(line + "\n"); return; }
    if (msg.id !== undefined && !msg.method && String(msg.id).startsWith("relay-")) {
      const relay = relayed.get(msg.id);
      if (relay?.clients.has(ws)) {
        relayed.delete(msg.id);
        relay.answer(msg);
        for (const client of relay.clients) sendClient(client, { method: "serverRequest/resolved", params: { threadId: relay.message.params.threadId, requestId: msg.id } });
      }
      return;
    }
    if (msg.method === "initialize" && msg.params?.clientInfo?.name === "elpis-agents") helperConns.add(ws);
    if (context.failed && msg.method && msg.id !== undefined) { toTui({ id: msg.id, error: { code: -32603, message: "The session backend disconnected; reopen this chat." } }); return; }
    const owner = providerOwners.get(msg.params?.threadId);
    if (msg.method === "thread/unsubscribe" && owner) {
      const tid = msg.params.threadId;
      const subscribed = subscriptions.get(ws)?.delete(tid);
      for (const [id, relay] of relayed) if (relay.threadId === tid && relay.clients.delete(ws)) {
        sendClient(ws, { method: "serverRequest/resolved", params: { threadId: relay.message.params.threadId, requestId: id } });
      }
      // The provider runtime still needs its engine subscription for confirmed permissions.
      toTui({ id: msg.id, result: { status: subscribed ? "unsubscribed" : "notSubscribed" } });
      checkIdle(); return;
    }
    if (msg.method && owner && owner.ws !== ws) { owner.dispatch(msg, ws); return; }
    if (["thread/start", "thread/fork", "thread/resume"].includes(msg.method)) openingReplies.add(msg.id);
    if (process.env.ACP_BRIDGE_DEBUG && msg.method && (process.env.ACP_BRIDGE_DEBUG === "all" || !/^thread\/(read|turns\/list|list|loaded)/.test(msg.method))) log(`tui-> ${line.slice(0, 600)}`);
    if (msg.method === "thread/read" && claudeModel.has(msg.params?.threadId) && resumeResults.has(msg.params.threadId)) {
      const tid = msg.params.threadId;
      storeChain.then(loadStore).then(async (store) => {
        const history = msg.params.includeTurns ? await providerHistory(tid, store) : { turns: [], cursor: null };
        const thread = { ...resumeResults.get(tid).thread, ...threadSeen.get(tid), turns: history.turns };
        await markHelpers({ thread });
        toTui({ id: msg.id, result: { thread } });
      }).catch((e) => toTui({ id: msg.id, error: { code: -32603, message: e.message } }));
      return;
    }
    if ((msg.method === "thread/read" || msg.method === "thread/resume") && childIds.has(msg.params?.threadId)) { answerChild(msg); return; }
    if (msg.method === "thread/loaded/list") pendingChildList.set(msg.id, null);
    if (msg.method === "thread/list" && msg.params?.ancestorThreadId && !msg.params.cursor) pendingChildList.set(msg.id, msg.params.ancestorThreadId);
    if (msg.method === "thread/list" || msg.method === "thread/read") pendingHelperMark.add(msg.id);
    if (msg.method === "model/list") pendingModelList.add(msg.id);
    if (msg.method === "thread/resume") { pendingResume.set(msg.id, msg.params?.threadId); resumeThread(msg); return; }
    if (msg.method === "thread/archive") {
      pendingArchive.set(msg.id, msg.params?.threadId);
      if (claudeModel.has(msg.params?.threadId)) { archiveProvider(msg); return; }
    }
    if (msg.method === "config/read") pendingConfigRead.add(msg.id);
    if (msg.method === "thread/fork" && claudeModel.has(msg.params?.threadId)) {
      const src = msg.params.threadId;
      const forkOf = { threadId: src, at: Math.floor(now() / 1000), beforeTurnId: msg.params.beforeTurnId ?? null, lastTurnId: msg.params.lastTurnId ?? null };
      rememberStart(msg.id, { model: claudeModel.get(src), effort: claudeEffort.get(src) ?? null, forkOf });
    }
    if (msg.method === "thread/start") { startThread(msg); return; }
    if (msg.method === "thread/revert") { revertThread(msg); return; }
    if (msg.method === "review/start" && claudeModel.has(msg.params?.threadId) && !activeTurns.has(msg.params.threadId)) { reviewClaude(msg); return; }
    if (msg.method === "thread/turns/list" && msg.params?.threadId) pendingTurnsList.set(msg.id, msg.params);
    if (msg.method === "thread/items/list" && msg.params?.threadId) pendingItemsList.set(msg.id, msg.params);
    const lp = msg.params ?? {};
    if (msg.method === "thread/list" && !lp.archived && lp.sortKey !== "section_position" && lp.sortDirection !== "asc"
      && lp.sectionId == null && lp.projectId == null && lp.parentThreadId == null && lp.ancestorThreadId == null) pendingThreadList.set(msg.id, lp);
    if (msg.method === "thread/settings/update") {
      const p = msg.params ?? {};
      if (ownHelpers.has(p.threadId)) boundAccess(p, helperScope.get(p.threadId).ceiling, "sandboxPolicy");
      if (isBridged(p.model)) { claudeModel.set(p.threadId, p.model); claimProvider(p.threadId); p.model = null; log(`thread ${p.threadId} -> ${claudeModel.get(p.threadId)}`); }
      else if (typeof p.model === "string") claudeModel.delete(p.threadId);
      // Permissions become authoritative only on thread/settings/updated. A rejected or queued
      // request must never grant the bridge permission ahead of the engine.
      if (p.collaborationMode?.mode) {
        threadCollab.set(p.threadId, p.collaborationMode.mode);
        if (claudeModel.has(p.threadId) && p.collaborationMode.settings && !isBridged(p.collaborationMode.settings.model)) p.collaborationMode.settings.model = null;
      }
      if (p.effort && claudeModel.has(p.threadId)) { claudeEffort.set(p.threadId, p.effort); p.effort = null; }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "config/batchWrite" && Array.isArray(msg.params?.edits)) {
      const modelEdit = msg.params.edits.find((e) => e.keyPath === "model");
      const claudePick = isBridged(modelEdit?.value);
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
      if (ownHelpers.has(tid)) boundAccess(msg.params, helperScope.get(tid).ceiling, "sandboxPolicy");
      if (msg.params?.collaborationMode?.mode) threadCollab.set(tid, msg.params.collaborationMode.mode);
      // Its permission fields are the TUI's unconfirmed choice: a Claude turn ignores them (see
      // claudeTurn), and the engine reports what it accepts for its own turn in
      // thread/settings/updated.
      if (isBridged(msg.params?.model)) {
        claudeModel.set(tid, msg.params.model);
        claimProvider(tid);
        if (msg.params.effort) claudeEffort.set(tid, msg.params.effort);
      }
      if (claudeModel.has(tid) && String(msg.id).startsWith("temporary-structured-turn")) { structuredClaude(msg); return; }
      if (claudeModel.has(tid)) {
        if (activeTurns.has(tid)) {
          toTui({ id: msg.id, error: { code: -32600, message: "thread already has an active or pending turn; steer or queue the message instead" } });
          return;
        }
        log(`subscription turn for thread ${tid} (${claudeModel.get(tid)})`);
        claudeTurn(msg);
        return;
      }
      if (isBridged(msg.params?.model)) msg.params.model = null;
      const own = ownHelpers.get(tid);
      if (own?.applying || own?.failed) {
        // An engine helper starts its next turn only once its engine has confirmed its restriction.
        own.waiting.push(msg.id);
        (own.applying ?? enforceHelper(tid)).then((ok) => { if (ok) engine.stdin.write(JSON.stringify(msg) + "\n"); });
        return;
      }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "thread/compact/start" && claudeModel.has(msg.params?.threadId) && !activeTurns.has(msg.params.threadId)) {
      toTui({ id: msg.id, result: {} });
      const extra = msg.params.instructions ? ` ${msg.params.instructions}` : "";
      log(`claude compact for thread ${msg.params.threadId}`);
      claudeTurn({ kind: "compact", params: { threadId: msg.params.threadId, input: [{ type: "text", text: `/compact${extra}`, text_elements: [] }] } });
      return;
    }
    if (msg.method === "turn/interrupt" && structured.has(msg.params?.threadId)) {
      acps.get(AGENTS[0].key)?.send({ method: "session/cancel", params: { sessionId: structured.get(msg.params.threadId) } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (/^thread\/goal\/(set|get|clear)$/.test(msg.method) && claudeModel.has(msg.params?.threadId)) { goalRequest(msg); return; }
    if (/^thread\/queue\//.test(msg.method) && claudeModel.has(msg.params?.threadId)) { queueRequest(msg); return; }
    if (msg.method === "turn/interrupt" && activeTurns.has(msg.params?.threadId)) {
      const running = activeTurns.get(msg.params.threadId);
      running.cancelled = true;
      if (running.sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId: running.sessionId } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === "turn/steer" && claudeModel.has(msg.params?.threadId)) {
      steerClaude(msg);
      return;
    }
    engine.stdin.write(line + "\n");
  }
  const engineExited = () => {
    if (context.failed || engine.closing) return;
    context.failed = true;
    const error = { code: -32603, message: "The session backend disconnected. Reopen Elpis to continue this chat." };
    for (const request of engineReqs.values()) request.reject(error);
    engineReqs.clear(); engineTurns.clear();
    for (const [key, start] of startingProviders) if (key.startsWith(`${connectionId}:`)) { start.resolve(); startingProviders.delete(key); }
    for (const id of new Set([...pendingStart.keys(), ...pendingResume.keys(), ...openingReplies])) toTui({ id, error });
    pendingStart.clear(); pendingResume.clear(); openingReplies.clear();
    for (const [id, route] of forwarded) if (route.owner === ws) { forwarded.delete(id); sendClient(route.client, { id: route.id, error }); }
    for (const [tid, owner] of providerOwners) if (owner.ws === ws) for (const client of viewers(tid)) client.close(1011, "Session backend disconnected");
    context.close(); ws.close(1011, "Session backend disconnected"); checkIdle();
  };
  engine.stdout.on("exit", engineExited);
  engine.once?.("exit", engineExited);
  ws.on("message", handleMessage);
  ws.on("close", async () => {
    clients.delete(ws); subscriptions.delete(ws);
    for (const relay of relayed.values()) relay.clients.delete(ws);
    for (const [id, route] of forwarded) if (route.client === ws) forwarded.delete(id);
    if (!process.env.ELPIS_SHARED_BRIDGE || helperConns.has(ws)) {
      for (const tid of ownHelpers.keys()) helperScope.get(tid)?.owners.delete(restrictHelper);
      for (const d of [...pendingDelegation.values(), ...pendingAdopt.values()]) pendingHelpers.delete(d);
      await storeChain; context.close(); contexts.delete(context);
      for (const [tid, owner] of providerOwners) if (owner.ws === ws) providerOwners.delete(tid);
    }
    checkIdle(); log("tui disconnected");
  });
});
