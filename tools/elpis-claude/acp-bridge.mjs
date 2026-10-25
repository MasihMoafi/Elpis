// Elpis TUI <-ws-> bridge <-stdio-> real `elpis app-server` (everything else)
//                         \-stdio-> claude-agent-acp (chat turns -> Claude)
import { splitContext, splitTokens, transcriptReader } from "./context-split.mjs";
import { createBridgeServer, bridgeUrl, createEngine, stopBridgeListener, shutdownRuntime, createDrainServer, drainFile, probe, startToken, allowEngines } from "./shared-runtime.mjs";
import { closeWhenQuiet, currentDrain, drainProxy, trackRequests } from "./handover.mjs";
import { withFileLock } from "./file-lock.mjs";
import { isSignedOut, setSignedOut, SIGNED_OUT_MESSAGE } from "./anthropic-signout.mjs";
import { ClaudeAccounts } from "./claude-accounts.mjs";
import { recordedClaudeEnd } from "./claude-turn-record.mjs";
import { WorkflowRunner, noticeText, personAskedForWorkflow } from "./workflow-runner.mjs";
import { bridgeExecutor } from "./workflow-agents.mjs";
import { connectAppServer } from "./app-server-connection.mjs";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { appendLog, redactSecrets, redactedLines } from "./log-redaction.mjs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultPermissionMode, defaultPermissionSettings, permissionSettingsAllowed, permissionSettings, permissionMode } from './permission-policy.mjs';
import { PermissionChoices } from './permission-choices.mjs';

const HOME = process.env.HOME;
const permissionChoices = new PermissionChoices(process.env.ELPIS_HOME || join(HOME, '.elpis-next'));
const LOG = process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/bridge.log";
const log = (s) => { try { appendLog(LOG, s); } catch {} };
const ADAPTER = process.env.ACP_ADAPTER ?? new URL("./context-agent.mjs", import.meta.url).pathname;
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
// RemoteTrigger runs cloud agents) are disallowed, including shell and configured MCP routes.
const AGENT_CLIS = ["claude", "codex", "agy", "elpis", "gemini"];
const SUBAGENT_TOOLS = ["Agent", "Task", "ListAgents", "SendMessage", "Workflow", "RemoteTrigger",
  ...AGENT_CLIS.flatMap(cli => [`Bash(${cli}:*)`, `Bash(*/${cli}:*)`]),
  ...["list_models", "delegate", "delegate_status", "delegate_steer", "delegate_stop"].flatMap((tool) => [`mcp__elpis-agents__${tool}`, `mcp__elpis_agents__${tool}`])];
// WR6: the person's own request for a workflow is the one exception: the elpis-agents workflow tool stays, and the
// runtime starts it only when the person's message asked for one.
const SUBAGENTS_DISABLED = `Subagents are disabled. Do all work in this thread. Do not start, resume, or delegate to other agents through agent tools, MCP tools (including elpis-agents delegate tools), or shell commands such as ${AGENT_CLIS.join(", ")}. Shell scripts, wrappers, background processes, and alternate paths must not bypass this switch. Earlier instructions or requests to delegate do not override it; the user must enable Subagents first. The one exception is the elpis-agents workflow tool when the person explicitly asks for a workflow in their own message (the keyword "ultracode", or words like "use a workflow").`;
// A37: the adapter's origins of a result Claude reached on its own (its AUTONOMOUS_RESULT_ORIGINS),
// and the updates that start such a reply between turns.
const AUTONOMOUS_ORIGINS = new Set(["task-notification", "peer", "coordinator", "observer", "observer-activity"]);
const REPLY_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "plan"]);
// The delegate tool reaches back into this bridge, so a helper can be any model it serves
// (engine models, Claude, Antigravity), and it names the chat that started it.
// Elpis's own tools for a Claude or Antigravity session: helpers on other models (when it may
// delegate) and durable memory (a chat the user started, not a helper; the tool itself checks
// the workspace opted in).
// A37: an engine chat delegates like a Claude one. The engine names the calling thread in each MCP
// tool call's `_meta.threadId`, so its server needs no parent of its own; given as config overrides.
// WR6: a chat the person talks to (not a helper) also gets the workflow tool, with the Subagents switch on or off.
const engineAgentsConfig = (subagents = true, workflow = false) => Object.fromEntries(mcpServersFor(subagents, null, null, workflow).map((s) =>
  [`mcp_servers.${s.name}`, { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) }]));
const mcpServersFor = (subagents, parentThreadId, memoryCwd, workflow = false) => {
  const agents = subagents && !process.env.ACP_BRIDGE_NO_AGENTS;
  if (!agents && !memoryCwd && !workflow) return [];
  return [{
    name: "elpis-agents", command: process.execPath, args: [AGENTS_MCP],
    env: [
      { name: "ELPIS_ENGINE_BIN", value: process.env.ELPIS_ENGINE_BIN ?? `${HOME}/.local/bin/elpis` },
      { name: "ELPIS_BRIDGE_URL", value: bridgeUrl(wss) },
      { name: "ELPIS_AGENT_TOOLS", value: agents ? "1" : "0" },
      { name: "ELPIS_WORKFLOW_TOOL", value: workflow ? "1" : "0" },
      ...(parentThreadId ? [{ name: "ELPIS_PARENT_THREAD", value: parentThreadId }] : []),
      ...(memoryCwd ? [{ name: "ELPIS_MEMORY_CWD", value: memoryCwd }] : []),
      ...(process.env.ELPIS_HOME ? [{ name: "ELPIS_HOME", value: process.env.ELPIS_HOME }] : []),
    ],
  }];
};
// A37: the app hands a chat its own MCP servers (the built-in browser) as `config["mcp_servers.<name>"]`
// overrides on thread/start, /fork and /resume. A Claude session gets the same servers in ACP's form;
// Claude's MCP calls carry no `_meta.threadId`, so the server's environment names the thread.
const appMcpConfig = (config) => {
  const entries = Object.entries(config ?? {}).filter(([key, s]) =>
    key.startsWith("mcp_servers.") && key !== "mcp_servers.elpis-agents" && typeof s?.command === "string");
  return entries.length ? Object.fromEntries(entries) : null;
};
const acpServersFrom = (config, threadId) => Object.entries(config ?? {}).map(([key, s]) => ({
  name: key.slice("mcp_servers.".length), command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [],
  env: [...Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value: String(value) })), { name: "ELPIS_THREAD_ID", value: threadId }],
}));
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
  // Bash's own one-line description of the command: the desktop app titles the step by it, as Claude's does.
  const description = t.name === "Bash" && typeof r.description === "string" && r.description.trim() ? { description: r.description.trim() } : {};
  return { type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd, processId: null, source: "agent", status, commandActions, aggregatedOutput: output, exitCode: status === "completed" ? 0 : status === "inProgress" ? null : 1, durationMs: t.end ? t.end - t.start : null, ...description };
}
// A finished turn as the store keeps it: long outputs and diffs cut.
const cut = (s) => (s.length > 4000 ? s.slice(0, 4000) + "\n…" : s);
const clipItem = (it) => it.type === "fileChange" ? { ...it, changes: it.changes.map((c) => ({ ...c, diff: cut(c.diff) })) }
  : it.aggregatedOutput ? { ...it, aggregatedOutput: cut(it.aggregatedOutput) } : it;
const clipTurn = (turn) => ({ ...turn, items: turn.items.map(clipItem) });
const ELPIS_HOME = process.env.ELPIS_HOME || `${HOME}/.elpis-next`;
const STORE = process.env.ACP_BRIDGE_STORE ?? `${ELPIS_HOME}/elpis-claude/sessions.json`;
async function readStore() {
  try {
    const store = JSON.parse(await readFile(STORE, "utf8"));
    if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("expected a JSON object");
    return store;
  } catch (e) {
    if (e.code === "ENOENT") return {};
    const error = Object.assign(new Error(`cannot load ${STORE}: ${e.message}`), { storeLoadError: true });
    log(`store: ${error.message}`);
    throw error;
  }
}
// All read-only callers share a parse of the saved version, including concurrent startup reads.
// Writes still read a fresh, private copy. Atomic saves and external replacements invalidate it.
let storeSnapshot = null;
let storeRead = null;
async function loadStore() { return loadStoreSnapshot(); }
async function loadStoreSnapshot() {
  let sig = null;
  try { const s = statSync(STORE); sig = `${s.ino}:${s.size}:${s.mtimeMs}`; } catch {}
  if (sig && storeSnapshot?.sig === sig) return storeSnapshot.store;
  if (sig && storeRead?.sig === sig) return storeRead.promise;
  const promise = readStore().then(store => { if (sig) storeSnapshot = { sig, store }; return store; });
  storeRead = { sig, promise };
  try { return await promise; }
  finally { if (storeRead?.promise === promise) storeRead = null; }
}
let storeChain = Promise.resolve();
let pendingStoreUpdates = [];
const deletingThreads = new Set();
const deletedThreads = new Set();
// Resolves true once saved, false if saving failed.
function updateStore(fn) {
  const updates = pendingStoreUpdates;
  const saved = new Promise(resolve => updates.push({ fn, resolve }));
  if (updates.length === 1) storeChain = storeChain.then(async () => {
    let success = false;
    try {
      await withFileLock(STORE, async () => {
        const st = await readStore();
        // Edits arriving during the read share this transaction, in order. Edits
        // arriving during the save get a new transaction behind this one.
        pendingStoreUpdates = [];
        for (const update of updates) update.fn(st);
        // Late plan/tool notifications cannot recreate a deleted transcript.
        for (const tid of deletedThreads) { delete st[tid]; if (st._delegations) delete st._delegations[tid]; }
        await saveStore(st);
      });
      success = true;
    } catch (e) { if (!e.storeLoadError) log(`store: ${e.message}`); }
    finally {
      if (pendingStoreUpdates === updates) pendingStoreUpdates = [];
      for (const update of updates) update.resolve(success);
    }
  });
  return saved;
}
const STATE_DIR = STORE.slice(0, STORE.lastIndexOf("/"));
const claudeAccounts = new ClaudeAccounts({ home: HOME, dir: STATE_DIR, defaultConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), claudeBin: process.env.CLAUDE_CODE_EXECUTABLE ?? join(HOME, ".local/bin/claude") });
const CATALOG = `${STATE_DIR}/catalog.json`;
// Elpis's own sign-out of the Claude subscription (anthropic-signout.mjs), read whenever it matters, so
// the terminal and the desktop follow it at once. While it is on, Claude's models, usage and turns are
// gone from Elpis; Claude Code's own login (~/.claude) is never touched.
const claudeSignedOut = () => isSignedOut(STATE_DIR);
// The subscriptions Elpis reaches through ACP, each by a model-id prefix. Antigravity (Gemini on
// the Google sign-in) runs through agy-acp.mjs and is offered only when `agy` is installed.
const AGY_BIN = process.env.AGY_BIN ?? `${HOME}/.local/bin/agy`;
const AGENTS = [
  { key: "claude", speaker: "Claude", prefix: "claude/", label: "Claude subscription", description: "Claude Code on your Pro/Max plan", adapter: ADAPTER, get env() { return { CLAUDE_CODE_EXECUTABLE: CLAUDE, ...claudeAccounts.environment() }; }, catalogFile: CATALOG, signedOut: claudeSignedOut, limits: () => (claudeSignedOut() ? Promise.resolve([]) : claudeLimitsCached().then((one) => [one])) },
  ...(!process.env.ELPIS_NO_AGY && existsSync(AGY_BIN)
    ? [{ key: "agy", speaker: "Gemini", prefix: "agy/", label: "Antigravity", description: "Antigravity, your Google sign-in", adapter: new URL("./agy-acp.mjs", import.meta.url).pathname, env: { AGY_BIN }, catalogFile: CATALOG.replace(/catalog\.json$/, "catalog-agy.json"), limits: () => agyLimitsCached() }]
    : []),
];
const agentOf = (model) => (typeof model === "string" ? AGENTS.find((a) => model.startsWith(a.prefix)) : undefined);
// Whether a model (or agent) is one Elpis has signed out of, and the error that refuses its turn.
const signedOutModel = (model) => agentOf(model)?.signedOut?.() === true;
const refuseSignedOut = (agent) => { if (agent?.signedOut?.()) throw Object.assign(new Error(SIGNED_OUT_MESSAGE), { signedOut: true }); };
const acpErrorMessage = (e) => (e?.signedOut ? e.message : `Claude (ACP) error: ${e?.message ?? JSON.stringify(e)}`);
// A dropped or timed-out connection is no error to show: the chat retries on its own (any message retries at once).
const RECONNECT_MS = Number(process.env.ELPIS_RECONNECT_MS) || 180_000;
const connectionDropped = (e) => /API Error/.test(e?.message ?? "") && /connection|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(e.message);
const RECONNECT_NOTE = `Connection lost. Retrying in ${RECONNECT_MS >= 60_000 ? `${RECONNECT_MS / 60_000} minutes` : `${RECONNECT_MS / 1000} seconds`}; send a message to retry now.`;
async function readJson(path) { try { const { readFile } = await import("node:fs/promises"); return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function writeJson(path, value) {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1)); await rename(`${path}.tmp`, path);
}
async function saveStore(store) { await writeJson(STORE, store); }

async function claudeLimits() {
  const { readFile } = await import("node:fs/promises");
  const creds = claudeAccounts.credentials();
  if (!creds?.accessToken) throw new Error("Sign in to the selected Claude account in Models & accounts.");
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
const claudeLimitCaches = new Map();
const claudeLimitsCached = () => {
  const id = claudeAccounts.activeId();
  if (!claudeLimitCaches.has(id)) claudeLimitCaches.set(id, everyMinute(claudeLimits, "Claude usage"));
  return claudeLimitCaches.get(id)();
};
const agyLimitsCached = everyMinute(agyLimits, "Antigravity usage");

// The TUI applies a resumed or started thread's collaboration mode after its model, so a bridged
// chat must name its own model there too, or the engine's default replaces it on screen.
function nameModel(result, model, effort) {
  Object.assign(result, { model, reasoningEffort: effort ?? null });
  Object.assign(result.thread, { model, reasoningEffort: effort ?? null });
  const settings = result.collaborationMode?.settings;
  if (settings) Object.assign(settings, { model, reasoning_effort: effort ?? null });
}

// A subscription's limits as account/rateLimits/updated notifications, so /usage has them as soon
// as its chat opens or a turn ends.
function announceLimits(agent, send) {
  agent?.limits().then((all) => {
    for (const rateLimits of all) {
      log(`${rateLimits.limitName} limits: 5h ${rateLimits.primary?.usedPercent}% week ${rateLimits.secondary?.usedPercent}%`);
      send("account/rateLimits/updated", { rateLimits });
    }
  }).catch((e) => log(`${agent.key} limits: ${e.message}`));
}

// /usage reads every account's limits at once, but the engine only knows OpenAI's, so a Claude
// chat showed the GPT plan. Each subscription answers within 5 s or is left out; without a
// ChatGPT sign-in the engine refuses, and the subscriptions' limits answer instead.
async function addSubscriptionLimits(answer) {
  const within = (limits) => Promise.race([limits, new Promise((resolve) => setTimeout(resolve, 5000, []))]).catch(() => []);
  const limits = (await Promise.all(AGENTS.map((agent) => within(agent.limits())))).flat();
  if (!limits.length) return;
  const byId = Object.fromEntries(limits.map((one) => [one.limitId, one]));
  if (answer.result) answer.result.rateLimitsByLimitId = { ...answer.result.rateLimitsByLimitId, ...byId };
  else { delete answer.error; answer.result = { rateLimits: limits[0], rateLimitsByLimitId: byId }; }
}

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
const ACCOUNTS = `${STATE_DIR}/accounts.json`;
async function recordAccounts() {
  const { readFile } = await import("node:fs/promises");
  const json = (path) => readFile(path, "utf8").then(JSON.parse).catch(() => null);
  const out = {};
  const { email, plan } = claudeAccounts.account();
  if (email && !claudeSignedOut()) out.claude = { email, plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
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
    redactedLines(this.proc.stderr, clean => log(`${agent.key} acp stderr: ${clean.trim().slice(0, 300)}`));
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
  call(method, params, timeoutMs = 0) {
    if (this.dead) return Promise.reject({ message: this.dead });
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject({ message: 'Reading Claude context files timed out.' }); }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, method, sessionId: params?.sessionId });
      this.send({ id, method, params });
    });
  }
  settleRecorded(sessionId, method, result) {
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId && pending.method === method) {
      this.pending.delete(id);
      pending.resolve(result);
    }
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
const workflowToolConns = new WeakSet(); // a chat's workflow tool: its launches need the person's request (WR6)
const relayed = new Map(); // id sent to the TUI -> answers the helper's request
const chatAccess = new Map(); // confirmed approval policy and profile for automatic tool decisions
const automaticThreads = new Set(), blockedAutomaticThreads = new Set();
const explicitChatChoices = new Set();
// Automatic helpers follow the shared default. An explicitly requested read-only
// delegate scope remains scoped; a user choice for the helper itself wins. The
// connections that hold a helper apply changes together, including private engines.
const helperScope = new Map(); // helper thread id -> { parentThreadId, requested, ceiling, owners }
const pendingHelpers = new Set(); // a parent cannot be deleted while one of its helpers is starting
const AUTHORITY = { plan: 0, default: 0, acceptEdits: 1, auto: 2, bypassPermissions: 3 };
// Elpis's built-in profiles with no sandbox: Full Access and Bypass permissions (the engine's
// `:bypass-permissions`, which also lifts its own refusals).
const UNSANDBOXED = [":danger-full-access", ":bypass-permissions"];
const fullFor = (threadId) => UNSANDBOXED.includes(chatAccess.get(threadId)?.profile) && (explicitChatChoices.has(threadId) || [undefined, "danger-full-access"].includes(helperScope.get(threadId)?.ceiling));
// A helper's own choice and the shared default determine its access, independently
// of a permission choice for the parent chat. Automatic access never selects Bypass.
const CEILINGS = ["read-only", "workspace-write", "danger-full-access"];
const lowest = (...ceilings) => CEILINGS[Math.min(...ceilings.map((c) => Math.max(0, CEILINGS.indexOf(c))))];
const helperCeiling = requested => requested === 'workspace-write' ? 'danger-full-access' : 'read-only';
// Explicit delegate scopes stay bounded; automatic writers are reconciled with the
// current default before reopening or taking another turn.
const ceilingOf = (threadId, d) => explicitChatChoices.has(threadId) ? 'danger-full-access' : lowest(d.ceiling, helperScope.get(threadId)?.ceiling ?? "danger-full-access", helperCeiling(d.requested));
// Provider turns live in this bridge, while native turns live in the shared engine.
// A provider thread has one runtime owner. Other terminals subscribe to that runtime;
// their requests and replies keep their own ids, including when both clients use id 1.
const providerOwners = new Map();
const subscriptions = new Map(); // physical client -> threads it opened
// A completed callback may be the last thing keeping a detached context alive. Defer the
// check until its current cleanup (including any new queued work) has finished.
class BusyMap extends Map {
  delete(key) { const changed = super.delete(key); if (changed) queueMicrotask(checkIdle); return changed; }
  clear() { const changed = this.size; super.clear(); if (changed) queueMicrotask(checkIdle); }
}
const forwarded = new BusyMap(); // bridge id -> original client and request id
const startingProviders = new Map(); // start response must name the model before its notification
const contexts = new Set();
const sendClient = (client, msg) => { if (client.readyState === 1) client.sendWire(JSON.stringify(msg)); };
const viewers = (threadId, includeHelpers = false) => [...clients].filter((c) => c.readyState === 1 && (includeHelpers || !helperConns.has(c)) && subscriptions.get(c)?.has(threadId));
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
async function stopBridge(successor) {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  workflows.close(); // its runs stay running: the next runtime resumes them from their journals
  if (draining) { draining.server.close(); try { if (JSON.parse(readFileSync(drainFile(), "utf8")).pid === process.pid) rmSync(drainFile(), { force: true }); } catch {} }
  stopBridgeListener();
  await storeChain;
  for (const c of contexts) c.close();
  await shutdownRuntime();
  // Started only now, so the new bridge never meets this one's engines or unsaved chats.
  if (successor) spawn(process.execPath, [join(dirname(successor), "shared-runtime.mjs"), successor], { detached: true, stdio: ["ignore", "ignore", "inherit"], cwd: HOME }).unref();
  process.exit(0);
}
// A newer installation takes over while chats work (handover.mjs): this bridge gives it bridge.sock at once and keeps
// only the chats working now, which the newer bridge reaches through this drain socket until each is done.
let draining = null; // { threads, released, server }
function busyThreads() { const ids = new Set(); for (const c of contexts) for (const id of c.busyThreads()) ids.add(id); return ids; }
function writeDrain() {
  const file = drainFile();
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, token: startToken(process.pid), sock: draining.server.sock, threads: [...draining.threads] }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
async function startDrain(successor) {
  if (stopping || draining) return;
  const launchSuccessor = () => spawn(process.execPath, [join(dirname(successor), "shared-runtime.mjs"), successor], { detached: true, stdio: ["ignore", "ignore", "inherit"], cwd: HOME }).unref();
  workflows.release(); // the newer runtime resumes the runs from their journals
  if (![...contexts].some((c) => c.busy())) return void stopBridge(successor);
  const server = createDrainServer();
  server.wss.on("connection", (ws) => { ws.drainShadow = true; wss.emit("connection", ws); });
  draining = { threads: busyThreads(), released: new Set(), server };
  const started = Date.now();
  await server.listening;
  writeDrain();
  log(`handing over to ${successor} while ${draining.threads.size} chats work`);
  await stopBridgeListener(); allowEngines();
  launchSuccessor();
  for (let i = 0; i < 300 && !(await probe(process.env.ELPIS_BRIDGE_SOCKET)).ok; i++) await new Promise((r) => setTimeout(r, 100));
  log(`the newer bridge answers after ${Date.now() - started} ms; moving the clients`);
  // The delegate tool's connections never reconnect: they stay until their chats are done.
  for (const ws of clients) if (!ws.drainShadow && !helperConns.has(ws)) closeWhenQuiet(ws, "Session backend changed");
  checkDrain();
}
function checkDrain() {
  if (!draining || stopping) return;
  const now = busyThreads();
  // Work a remaining delegate connection started meanwhile stays here too.
  for (const id of now) if (!draining.released.has(id)) draining.threads.add(id);
  let changed = false;
  for (const id of [...draining.threads]) {
    if (now.has(id)) continue;
    draining.threads.delete(id); draining.released.add(id); changed = true;
    log(`handing over: chat ${id} is done here`);
    for (const ws of clients) if (ws.drainShadow) sendClient(ws, { method: "bridge/released", params: { threadId: id } });
  }
  if (changed) writeDrain();
  // Its last events get a second to reach the newer bridge before this one exits.
  if (!draining.threads.size && ![...contexts].some((c) => c.busy()) && !draining.exiting) {
    draining.exiting = setTimeout(() => { draining.exiting = null; if (!draining.threads.size && ![...contexts].some((c) => c.busy())) void stopBridge(); else checkDrain(); }, 1000);
  }
}
function checkIdle() {
  if (stopping) return;
  checkDrain();
  for (const c of [...contexts]) c.releaseIfUnused();
  clearTimeout(idleTimer);
  // A running workflow, or a notice still due, keeps the runtime (WR3).
  const working = () => clients.size || [...contexts].some((c) => c.busy()) || workflows.busy() || noticesDue.size;
  if (!process.env.ELPIS_SHARED_BRIDGE || working()) return;
  idleTimer = setTimeout(async () => {
    if (working()) return;
    await stopBridge();
  }, 30_000);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stopBridge());

// Workflows that run until they finish (SPEC WR1–WR8). The runner lives here, in the long-lived runtime: a run
// continues after its chat's turn, its window or the app ends, and the next runtime resumes it from its journal.
const retryMs = Number(process.env.ELPIS_WORKFLOW_RETRY_MS) || 2000;
const workflows = new WorkflowRunner({
  home: ELPIS_HOME, log,
  retry: { attempts: Number(process.env.ELPIS_WORKFLOW_ATTEMPTS) || 4, delays: [retryMs, retryMs * 4, retryMs * 15] },
  executor: bridgeExecutor({ url: () => bridgeUrl(wss), log }),
});
// Every change reaches the app and the terminals (WR7).
workflows.on("updated", (change) => {
  const msg = { method: "workflowRun/updated", params: change, emittedAtMs: now() };
  for (const c of clients) if (!helperConns.has(c)) sendClient(c, msg);
  if (change.kind === "ended") checkIdle();
});
// WR5: the chat that started a run gets its notice as a new turn once it is free, and its model continues from it.
// An archived chat (the engine's delete is an archive too) keeps its notice until it is back: nothing is lost, the chat
// is not brought back by the notice, and the runtime does not keep trying (24 Oct review: it retried every 2 s for
// ever and never went idle).
const noticesDue = new Set();
const errorText = (e) => e?.message ?? JSON.stringify(e);
async function deliverNotice(run) {
  if (!run.parentThreadId || run.notice?.state !== "pending" || noticesDue.has(run.id) || stopping) return;
  noticesDue.add(run.id);
  const threadId = run.parentThreadId;
  const later = (why) => { workflows.markNotice(run.id, { state: "pending", waiting: why }); log(`workflow ${run.id}: notice waits until chat ${threadId} is back (${why})`); };
  let conn = null;
  try {
    while (!stopping) {
      if (!conn || conn.closed) {
        conn = connectAppServer({ url: bridgeUrl(wss), name: "elpis-workflow-runner" });
        await conn.ready;
        const refused = await conn.call("thread/resume", { threadId }).then(() => null, (e) => e);
        if (refused && /is archived/i.test(errorText(refused))) return later("archived");
        if (refused && /not found/i.test(errorText(refused))) { workflows.markNotice(run.id, { state: "undeliverable", why: "the chat was deleted" }); return; }
        if (refused) log(`workflow ${run.id}: notice: reopen ${threadId}: ${errorText(refused)}`);
      }
      const read = await conn.call("thread/read", { threadId, includeTurns: false }).catch((e) => ({ error: e }));
      if (read.thread?.status?.type === "active") { await new Promise((r) => setTimeout(r, 2000)); continue; }
      let answered;
      const done = new Promise((resolve) => { answered = (m) => { if (m.method === "turn/completed" && m.params?.threadId === threadId) resolve(); }; conn.listeners.add(answered); });
      try {
        const started = await conn.call("turn/start", { threadId, input: [{ type: "text", text: noticeText(run), text_elements: [] }] });
        workflows.markNotice(run.id, { state: "delivered", waiting: null, turnId: started?.turn?.id ?? null, at: now() });
        log(`workflow ${run.id}: notice delivered to ${threadId}`);
      } catch (e) {
        conn.listeners.delete(answered);
        log(`workflow ${run.id}: notice to ${threadId} waits: ${errorText(e)}`);
        // Reopened next time, so a chat archived or deleted meanwhile is told apart from a busy one.
        if (/not found|is archived/i.test(errorText(e))) { conn.close(); conn = null; }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // The notice's turn belongs to this connection; it stays open until the chat has answered.
      await Promise.race([done, new Promise((r) => setTimeout(r, 30 * 60_000))]);
      return;
    }
  } catch (e) {
    log(`workflow ${run.id}: notice failed: ${errorText(e)}`);
    setTimeout(() => { noticesDue.delete(run.id); void deliverNotice(run); }, 5000).unref();
  } finally { noticesDue.delete(run.id); conn?.close(); checkIdle(); }
}
// A chat that comes back from the archive gets the notices it missed.
function chatBack(threadId) {
  for (const summary of workflows.list({ parentThreadId: threadId })) if (summary.notice === "pending") { const run = workflows.pending(summary.id); if (run) void deliverNotice(run); }
}
workflows.on("ended", (run) => { void deliverNotice(run); });
// After a restart, and while a handed-over runtime lets its runs go: runs nobody owns continue here.
const recoverWorkflows = () => { if (!stopping && !draining) { try { workflows.recover(); } catch (e) { log(`workflow recovery: ${e.message}`); } } };
wss.on("listening", recoverWorkflows);
setInterval(recoverWorkflows, 5000).unref();
// A newer installation that joined this bridge left its bridge's path here (shared-runtime.mjs). This bridge starts
// that one and hands it every connection (startDrain); the open terminals and the desktop app reconnect to it.
const successorFile = process.env.ELPIS_SHARED_BRIDGE && process.env.ELPIS_BRIDGE_SOCKET && join(dirname(process.env.ELPIS_BRIDGE_SOCKET), "successor");
if (successorFile) setInterval(() => {
  if (stopping || draining) return;
  let successor; try { successor = readFileSync(successorFile, "utf8").trim(); } catch { return; }
  if (successor) void startDrain(successor);
}, 2000).unref();
wss.on("connection", (ws) => {
  if (stopping) { ws.close(1012, "Session backend is stopping"); return; }
  clients.add(ws);
  clearTimeout(idleTimer);
  subscriptions.set(ws, new Set());
  ws.sendWire = ws.send.bind(ws);
  const noteRequest = trackRequests(ws);
  const handover = drainProxy(ws, log);
  ws.send = (line) => {
    let msg;
    try { msg = JSON.parse(String(line)); } catch { if (ws.readyState === 1) ws.sendWire(line); return; }
    if (msg.result?.thread && deletedThreads.has(msg.result.thread.id)) msg = { id: msg.id, error: { code: -32600, message: `thread not found: ${msg.result.thread.id}` } };
    decorateThread(msg.result?.thread);
    decorateThread(msg.params?.thread);
    if (Array.isArray(msg.result?.data)) for (const t of msg.result.data) if (typeof t === "object") decorateThread(t);
    // A chat still working in the bridge that handed over shows as working.
    const old = Array.isArray(msg.result?.data) && currentDrain();
    if (old) for (const t of msg.result.data) if (old.threads.has(t?.id)) t.status = { type: "active", activeFlags: [] };
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
      const recipients = new Set(viewers(msg.params.threadId, true));
      // The delegate connection follows its helper even before subscribing. A thread/start
      // reply also subscribes it, so combine the routes before sending each event once.
      if (owner.nativeHelper) recipients.add(ws);
      for (const client of recipients) sendClient(client, msg);
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
    const all = ["thread/started", "thread/status/changed", "thread/archived", "thread/closed", "thread/deleted"].includes(method);
    const tid = params.threadId ?? params.thread?.id;
    const recipients = all ? [...clients].filter((c) => !helperConns.has(c)) : viewers(tid, true);
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
  const pendingHelperTurns = new Map(); // native turn/start id -> helper awaiting its acknowledgement
  const sessions = new Map();
  const threadMcp = new Map(); // thread -> the app's `mcp_servers.*` overrides for it (A37)
  const acps = new Map();
  const claudeModel = new Map();
  const pendingSteers = new Map();       // threadId → client message id → undelivered steer
  const claudeEffort = new Map();
  const resumeResults = new Map();
  const materializedProviders = new Set();
  const context = {
    failed: false,
    claudeBusy: () => [...activeTurns.keys()].some(tid => agentOf(claudeModel.get(tid))?.key === "claude") || structured.size > 0,
    stopProvider: (tid) => stopProvider(tid, "deleted"),
    childrenOf: (ids) => [...childThreads].filter(([, child]) => ids.has(child.rootThreadId) || ids.has(child.thread.parentThreadId)).map(([id]) => id),
    forgetThread: (tid) => {
      cancelRelays(ws, tid);
      for (const cache of [threadCwd, threadSeen, childThreads, childIds, threadPolicy, smartPrune,
        threadSandbox, sessions, claudeModel, claudeEffort, resumeResults, sessionModel,
        threadCollab, threadAccess, lastTurnUsage, forkParent, queues, goals, ownHelpers, pendingSteers, materializedProviders]) cache.delete(tid);
    },
    // An abandoned request is bookkeeping, not running work. Turns (including native
    // background agents) and structured tool calls still outlive their terminal, and so does a chat
    // whose helpers still run: its delegate server lives in the chat's session, which the engine
    // ends once no client holds the idle chat.
    busy: () => activeTurns.size > 0 || engineTurns.size > 0 || structured.size > 0
      || [...helperScope].some(([tid, h]) => threadSeen.has(h.parentThreadId) && providerOwners.get(tid)?.status().type === "active")
      || (ws.readyState === 1 && (pendingStart.size > 0 || pendingResume.size > 0 || engineReqs.size > 0))
      || [...forwarded.values()].some((r) => r.owner === ws),
    // The chats behind busy(): a hand-over keeps them in this bridge until they are done.
    busyThreads: () => [...activeTurns.keys(), ...engineTurns.keys(), ...structured.keys(),
      ...[...helperScope].filter(([tid, h]) => threadSeen.has(h.parentThreadId) && providerOwners.get(tid)?.status().type === "active").flatMap(([tid, h]) => [tid, h.parentThreadId]),
      ...[...relayed.values()].filter((r) => r.origin === ws).map((r) => r.threadId)],
    close: () => { cancelRelays(ws); engine.kill(); for (const a of acps.values()) a.kill(); },
    releaseIfUnused: () => {
      if (ws.readyState === 1 || context.busy() || [...relayed.values()].some((r) => r.origin === ws)
        // Let detached requests finish during the idle grace, without extending it forever.
        || pendingStart.size || pendingResume.size || pendingDelegation.size || pendingHelperTurns.size || engineReqs.size
        || [...providerOwners].some(([tid, owner]) => owner.ws === ws && viewers(tid, true).length)) return;
      context.close(); contexts.delete(context);
      for (const [tid, owner] of providerOwners) if (owner.ws === ws) providerOwners.delete(tid);
      releaseHelpers();
      for (const d of [...pendingDelegation.values(), ...pendingAdopt.values()]) pendingHelpers.delete(d);
    },
  };
  contexts.add(context);
  const dispatchOwned = (msg, client) => {
    const id = `forward-${randomUUID()}`;
    forwarded.set(id, { client, id: msg.id, owner: ws });
    void withPermissions(JSON.stringify({ ...msg, id }));
  };
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
      dispatch: dispatchOwned,
    };
    providerOwners.set(tid, owner);
  }
  function claimEngineHelper(tid, h) {
    if (providerOwners.has(tid) && providerOwners.get(tid).ws !== ws) return;
    const owner = {
      ws,
      nativeHelper: true,
      model: () => h.model ?? null,
      effort: () => null,
      status: () => h.activeOwner ? { type: "active", activeFlags: [] } : { type: "idle" },
      decorate: (thread) => { thread.status = owner.status(); },
      lastTurn: () => h.lastTurn,
      dispatch: dispatchOwned,
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
    if (s.approvalPolicy) threadPolicy.set(threadId, s.approvalPolicy);
    const sandbox = (s.sandboxPolicy ?? s.sandbox)?.type;
    const profile = s.permissions ?? s.activePermissionProfile?.id
      ?? (sandbox && ({ readOnly: ":read-only", dangerFullAccess: ":danger-full-access" }[sandbox] ?? ":workspace"));
    const prev = threadAccess.get(threadId) ?? {};
    threadAccess.set(threadId, { profile: profile ?? prev.profile, reviewer: s.approvalsReviewer ?? prev.reviewer });
    chatAccess.set(threadId, { policy: threadPolicy.get(threadId), profile: threadAccess.get(threadId).profile });
    for (const confirm of confirmations.get(threadId) ?? []) confirm(threadAccess.get(threadId).profile);
  };
  // The Claude Code mode a chat's turn runs in: Codex's permission modes, mapped to Claude's own.
  // Ask uses Accept edits, Approve for me uses Auto. Full access keeps normal
  // provider checks and answers their permission hook; only Bypass selects the
  // provider's bypass mode. A read-only helper that may not ask plans.
  const MODE_NAMES = { default: "Manual", acceptEdits: "Accept edits", plan: "Plan mode", auto: "Auto", bypassPermissions: "Bypass permissions" };
  const claudeModeOf = (threadId, agentKey, ask) =>
    threadCollab.get(threadId) === "plan" ? "plan" : accessModeOf(threadId, agentKey, ask);
  // The mode of the chat's permission mode alone, which a Plan turn returns to once its plan is
  // approved.
  const accessModeOf = (threadId, agentKey, ask) => {
    const { profile, reviewer } = threadAccess.get(threadId) ?? {};
    const readOnly = (!explicitChatChoices.has(threadId) && threadSandbox.get(threadId) === "read-only") || !!profile?.includes("read-only");
    // Never asking is an approval policy, not permission to leave a restricted profile.
    // Unknown/custom profiles stay restricted unless the engine explicitly names Full Access.
    if (!ask) return readOnly ? "plan" : profile === ':bypass-permissions' ? "bypassPermissions" : "default";
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
  const readTranscript = transcriptReader(); // the Context Ledger's split; cheap on a long transcript
  const transcriptOf = (threadId) => {
    const live = sessions.get(threadId);
    if (live?.agent !== "claude") return null;
    const project = (threadCwd.get(threadId) ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
    return join(claudeAccounts.configDir(live.accountId ?? "default"), "projects", project, `${live.id}.jsonl`);
  };
  async function recoverClaudeTurn(threadId) {
    const running = activeTurns.get(threadId);
    if (running) { await running.recover?.(); return; }
    await storeChain;
    const saved = (await loadStore())[threadId], active = saved?.active;
    if (active && processAlive(active.pid)) return;
    // A fresh connection has no provider owner until resume. History reads also need
    // that ownership: the native carrier's unloaded status is not Claude's turn status.
    if (isBridged(saved?.model) && !providerOwners.has(threadId)) {
      claudeModel.set(threadId, saved.model);
      if (saved.effort) claudeEffort.set(threadId, saved.effort);
      claimProvider(threadId);
    }
    // A followup (A37) has no prompt of its own to find in Claude's record.
    if (!active?.userItems?.length || (saved.agent ?? "claude") !== "claude") return;
    const project = active.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const file = join(claudeAccounts.configDir(saved.claudeAccountId ?? "default"), "projects", project, `${saved.session}.jsonl`);
    const final = await recordedClaudeEnd(file, active.transcriptOffset ?? 0, active.inputs ?? []);
    if (!final) return;
    const completedAt = Math.floor(now() / 1000);
    const turn = { id: active.turnId, items: [...active.userItems, { type: "agentMessage", id: final.id ?? randomUUID(), text: final.text }], itemsView: "full", status: "completed", error: null,
      startedAt: active.startedAt, startedAtMs: active.startedAtMs, completedAt, durationMs: (completedAt - active.startedAt) * 1000 };
    await updateStore(st => {
      if (st[threadId]?.active?.turnId !== active.turnId) return;
      const { active: unused, ...rest } = st[threadId];
      st[threadId] = { ...rest, turns: [...(rest.turns ?? []).filter(row => row.id !== turn.id), clipTurn(turn)] };
    });
    for (const item of turn.items) notify("item/completed", { threadId, turnId: turn.id, item });
    notify("turn/completed", { threadId, turn });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
  }
  const attribution = (threadId, used) => {
    const file = transcriptOf(threadId);
    if (file && existsSync(file)) {
      const t = readTranscript(file);
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
    const key = agent.key === "claude" ? `claude:${claudeAccounts.activeId()}` : agent.key;
    let a = acps.get(key);
    if (!a || a.dead) { a = new Acp(agent); acps.set(key, a); await a.ready; log(`${key} acp ready`); }
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
  const pendingResume = new BusyMap();
  const resumeOptions = new Map();
  const pendingNativeRoutes = new Map();
  // A Claude model picked as the default ("enter default") lives in the bridge's store, not in
  // config.toml, which plain Elpis also reads. New chats, rewinds and the next start follow it.
  const pendingConfigRead = new Set();
  const pendingStart = new BusyMap();
  const openingMcp = new Map(); // thread/start or /fork request id -> the app's MCP overrides
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
  const pendingLimitsRead = new Set(); // account/rateLimits/read answers gain the subscriptions' limits
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
    await storeChain;
    const store = await loadStore();
    const helpers = store._delegations ?? {};
    let changed = false;
    const markHelperTurn = (t) => {
      const turn = providerOwners.get(t.id)?.lastTurn?.();
      if (!turn) return false;
      const turns = Array.isArray(t.turns) ? t.turns : (t.turns = []);
      const index = turns.findIndex((listed) => listed.id === turn.id);
      if (index < 0) turns.push(turn);
      else turns[index] = { ...turns[index], status: turn.status };
      return true;
    };
    for (const t of [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])]) {
      if (!t || typeof t !== "object") continue;
      if (helpers[t.id] && t.parentThreadId == null) { t.parentThreadId = helpers[t.id].parentThreadId; changed = true; }
      if (helpers[t.id]?.workflowRunId && t.workflowRunId == null) { t.workflowRunId = helpers[t.id].workflowRunId; t.workflowAgentId = helpers[t.id].workflowAgentId ?? null; changed = true; }
      changed = ownModel(t, store) || changed;
      if (Array.isArray(result?.data)) changed = markHelperTurn(t) || changed;
    }
    if (ancestor && Array.isArray(result?.data)) {
      const below = new Set([ancestor]);
      for (let grew = true; grew;) { grew = false; for (const [id, d] of Object.entries(helpers)) if (below.has(d.parentThreadId) && !below.has(id)) { below.add(id); grew = true; } }
      const have = new Set(result.data.map((d) => (typeof d === "string" ? d : d.id)));
      for (const id of below) {
        if (id === ancestor || have.has(id)) continue;
        const t = (await engineCall("thread/read", { threadId: id, includeTurns: false }).catch(() => null))?.thread;
        if (t) {
          t.parentThreadId = helpers[id].parentThreadId;
          ownModel(t, store);
          markHelperTurn(t);
          result.data.push(t);
          changed = true;
        }
      }
    }
    return changed;
  }
  const pageFloor = new Map(); // nextCursor -> sort value of the last thread on the page before it
  const previewed = new Set(); // threads the engine lists itself
  const missingThreadUntil = new Map(); // a native thread/read said this saved chat is not loaded
  const listField = (req) => ({ updated_at: "updatedAt", recency_at: "recencyAt" })[req.sortKey] ?? "createdAt";
  const previewOf = (first) => first?.type === "userMessage" ? inputSummary(first.content ?? []) : first?.type === "enteredReviewMode" ? `Code review: ${first.review}` : "";
  const runningFirstTurn = (saved) => !saved?.turns?.length && typeof saved?.active?.preview === "string";
  const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
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
      !id.startsWith("_") && !have.has(id) && !previewed.has(id) && (saved?.turns?.length || runningFirstTurn(saved)) && !saved.parentThreadId);
    const out = new Array(candidates.length);
    let next = 0, failure;
    async function readCandidate(index) {
      const [id, saved] = candidates[index];
      if ((missingThreadUntil.get(id) ?? 0) > now()) return;
      const t = (await engineCall("thread/read", { threadId: id, includeTurns: false }, 5000).catch((e) => {
        if (e.code === "ETIMEDOUT") throw e;
        if (/^thread not loaded:/.test(e.message ?? "")) missingThreadUntil.set(id, now() + 30_000);
        log(`thread/list: cannot read saved thread ${id}: ${e.message ?? JSON.stringify(e)}`);
        return null;
      }))?.thread;
      if (!t) return;
      missingThreadUntil.delete(id);
      const interactive = t.source === "cli" || t.source === "vscode" || ["atlas", "chatgpt"].includes(t.source?.custom);
      if (req.sourceKinds?.length ? !req.sourceKinds.includes(t.source) : !interactive) return;
      if (t.preview) { previewed.add(id); return; }
      if (/\/archived_sessions\//.test(t.path ?? "") || (cwds && !cwds.includes(t.cwd))) return;
      if (req.modelProviders?.length && !req.modelProviders.includes(t.modelProvider)) return;
      if (value(t) < floor || value(t) >= ceiling) return;
      const preview = saved.turns?.length ? previewOf(saved.turns[0].items?.[0]) : saved.active.preview;
      if (req.searchTerm && ![t.name ?? "", preview].some((text) => text.includes(req.searchTerm))) return;
      if (preview.trim()) {
        const listed = { ...t, preview: preview.trim() }; ownModel(listed, store);
        // A first turn still running has no saved turn; the store's `active` record, kept by whichever connection runs it, says so.
        if (runningFirstTurn(saved) && (activeTurns.has(id) || processAlive(saved.active.pid))) listed.status = { type: "active", activeFlags: [] };
        out[index] = listed;
      }
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
  const engineReqs = new BusyMap();
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
  const permissionWrites = new Map();
  const permissionRefreshes = new Set();
  // Frontends send their cached engine settings on starts/resumes/turns. Those are
  // not a user choice. Only the chat menu (settings/update), or an explicitly marked
  // new-chat choice, detaches a chat from Settings > Default permissions.
  async function withPermissions(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { handleMessage(data); return; }
    const p = msg.params ?? {}, method = msg.method;
    if (method === 'thread/settings/update' && p.elpisPermissionSource == null && !helperConns.has(ws) && p.model == null
      && ['approvalPolicy', 'permissions', 'sandboxPolicy'].some(key => p[key] != null)) p.elpisPermissionSource = 'chat';
    const owner = providerOwners.get(p.threadId);
    if (owner && owner.ws !== ws && ['thread/resume', 'thread/settings/update', 'turn/start'].includes(method)) { owner.dispatch(msg, ws); return; }
    if (method === 'config/batchWrite' && p.edits?.some(edit => ['approval_policy', 'approvals_reviewer', 'default_permissions', 'sandbox_mode'].includes(edit.keyPath))) permissionRefreshes.add(msg.id);
    if (!['thread/start', 'thread/resume', 'thread/fork', 'thread/settings/update', 'turn/start'].includes(method)) { handleMessage(data); return; }
    const source = p.elpisPermissionSource;
    delete p.elpisPermissionSource;
    const fields = ['approvalPolicy', 'approvalsReviewer', 'permissions', 'sandbox', 'sandboxPolicy'];
    const hasPermissions = fields.some(key => p[key] != null);
    const explicit = source === 'chat';
    let automatic = !!p.elpisParentThreadId || helperConns.has(ws) || automaticThreads.has(p.threadId) || p.ephemeral === true || source === 'automatic';
    try {
      if (method === 'thread/settings/update') {
        // A model picker may attach its model-specific permission suggestion. A
        // model change does not detach the chat from its permission default.
        if (hasPermissions && !explicit && source !== 'default') for (const key of fields) delete p[key];
        if (explicit && (!providerOwners.has(p.threadId) || providerOwners.get(p.threadId).ws === ws)) permissionWrites.set(msg.id, { threadId: p.threadId, settings: Object.fromEntries(fields.filter(k => p[k] != null).map(k => [k, p[k]])) });
      } else {
        const record = p.threadId ? await permissionChoices.read(p.threadId) : null;
        if (record && !record.inherit && !record.automatic) explicitChatChoices.add(p.threadId);
        const scope = helperScope.get(p.threadId) ?? (method === 'thread/resume' ? (await loadStoreSnapshot())._delegations?.[p.threadId] : null);
        if (scope) automatic = true;
        let loaded = false;
        if (explicit || (record && !record.inherit && !record.automatic)) automatic = false;
        let chosen = record?.inherit ? null : record;
        if (chosen?.automatic) {
          automatic = true;
          chosen = chosen.permissions === ':read-only' || !chosen.permissions?.startsWith(':') ? { ...chosen } : null;
          if (chosen) delete chosen.automatic;
        }
        if (explicit) chosen = Object.fromEntries(fields.filter(k => p[k] != null).map(k => [k, p[k]]));
        // A deliberately scoped task (read-only or a named workflow profile) keeps
        // that scope. It still never asks the person for permission.
        if (automatic && method === 'thread/start' && (p.sandbox === 'read-only' || (p.permissions && ![':workspace', ':danger-full-access', ':bypass-permissions'].includes(p.permissions)))) {
          chosen = { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: p.permissions ?? ':read-only' };
        }
        if (method === 'thread/start' && p.elpisParentThreadId) p.elpisRequestedScope = p.sandbox === 'read-only' || p.permissions === ':read-only' ? 'read-only' : 'workspace-write';
        if (!chosen) {
          const read = await engineCall('config/read', { includeLayers: true, ...(p.cwd ? { cwd: p.cwd } : {}) });
          const mode = defaultPermissionMode(read);
          chosen = defaultPermissionSettings(read, automatic);
          // Legacy TUI's on-request + Full access was an inherited engine fallback.
          // Preserve distinguishable old chat choices; new records carry provenance.
          if (!record && p.threadId && method === 'thread/resume' && !automatic) {
            const prior = await engineCall('thread/resume', { threadId: p.threadId, excludeTurns: true });
            loaded = true;
            const old = permissionMode(prior), profile = prior.activePermissionProfile?.id;
            if (prior.thread?.parentThreadId || prior.thread?.source?.subAgent) { automatic = true; chosen = defaultPermissionSettings(read, true); }
            const own = !automatic && (old === 'bypass' || old === 'auto' || (old === 'ask' && profile === ':workspace' && mode === 'full'));
            if (own) chosen = permissionSettings(old);
            await permissionChoices.write(p.threadId, own || automatic ? { ...chosen, ...(automatic ? { automatic: true } : {}) } : { inherit: true });
          }
        }
        const requirements = (await engineCall('configRequirements/read', {})).requirements ?? {};
        if (!permissionSettingsAllowed(chosen, requirements)) throw new Error('This permission mode is restricted by managed settings. Choose an allowed default in Settings.');
        if (automatic) { chosen = { ...chosen, approvalPolicy: 'never', permissions: chosen.permissions === ':bypass-permissions' ? ':danger-full-access' : chosen.permissions }; }
        if (scope && scope.requested !== 'read-only' && !explicitChatChoices.has(p.threadId)) {
          const ceiling = { ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' }[chosen.permissions];
          if (ceiling && scope.ceiling !== ceiling) {
            scope.ceiling = ceiling;
            await updateStore(store => { if (store._delegations?.[p.threadId]) store._delegations[p.threadId].ceiling = ceiling; });
          }
        }
        if (scope && !explicitChatChoices.has(p.threadId)) boundAccess(chosen, helperScope.has(p.threadId) ? scope.ceiling : ceilingOf(p.threadId, scope), 'sandboxPolicy');
        // A loaded native thread ignores resume profile overrides. Apply the
        // confirmed settings before it resumes or starts either provider's turn.
        if (method === 'thread/resume' || method === 'turn/start') {
          if (method === 'thread/resume' && !loaded) {
            const ids = (await engineCall('thread/loaded/list', {})).data ?? [];
            if (!ids.includes(p.threadId)) await engineCall('thread/resume', { threadId: p.threadId, excludeTurns: true });
          }
          await engineCall('thread/settings/update', { threadId: p.threadId, ...chosen });
        }
        for (const key of fields) delete p[key];
        Object.assign(p, chosen);
        if (automatic) { p.approvalPolicy = 'never'; if (p.permissions === ':bypass-permissions') p.permissions = ':danger-full-access'; }
        if (method === 'thread/start') permissionWrites.set(msg.id, { settings: explicit || automatic ? { ...chosen, ...(automatic ? { automatic: true } : {}) } : { inherit: true }, ephemeral: p.ephemeral === true });
        if (method === 'turn/start' && (explicit || automatic) && !claudeModel.has(p.threadId)) permissionWrites.set(msg.id, { threadId: p.threadId, settings: { ...chosen, ...(automatic ? { automatic: true } : {}) } });
        if (method === 'turn/start' && claudeModel.has(p.threadId)) {
          if (explicit || automatic) await permissionChoices.write(p.threadId, { ...chosen, ...(automatic ? { automatic: true } : {}) });
        }
      }
      handleMessage(JSON.stringify(msg));
    } catch (error) {
      permissionWrites.delete(msg.id);
      toTui({ id: msg.id, error: { code: Number.isInteger(error.code) ? error.code : -32600, message: error.message ?? String(error) } });
    }
  }
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
  async function providerContextFiles(msg) {
    try {
      const { threadId } = msg.params;
      const result = await engineCall(msg.method, msg.params);
      await storeChain;
      const entry = (await loadStore())[threadId];
      const saved = entry?.contextFiles ?? [];
      const live = sessions.get(threadId), agent = agentOf(claudeModel.get(threadId));
      let files = saved, note;
      if (agent?.key === 'claude' && live && !activeTurns.has(threadId)) {
        try {
          const native = await acps.get(agent.key).call('_elpis/contextFiles', { sessionId: live.id }, 4000);
          const selected = entry?.contextSessionId === live.id ? saved.filter(file => file.group === 'skills') : [];
          files = [...native.files.filter(file => typeof file.path === 'string' && file.path.startsWith('/')).map(file => ({ name: basename(file.path), path: file.path, estimatedTokens: file.estimatedTokens, group: /(?:^|\/)MEMORY\.md$/.test(file.path) ? 'durableMemory' : 'instructions', included: true, selectable: false, reason: 'Loaded by Claude' })), ...selected];
          if (JSON.stringify(files) !== JSON.stringify(saved) || entry?.contextSessionId !== live.id) updateStore(st => {
            if (sessions.get(threadId) !== live) return;
            const current = st[threadId] ?? {};
            const skills = current.contextSessionId === live.id ? (current.contextFiles ?? []).filter(file => file.group === 'skills') : [];
            st[threadId] = { ...current, contextFiles: [...files.filter(file => file.group !== 'skills'), ...skills], contextSessionId: live.id };
          });
        } catch { note = 'Claude’s native context files could not be refreshed. Showing the last recorded list.'; }
      } else if (agent?.key === 'claude' && !saved.length) note = 'Claude’s native context files appear after its first turn.';
      const seen = new Set(result.files.map(file => file.path));
      toTui({ id: msg.id, result: { ...result, files: [...result.files, ...files.filter(file => { if (seen.has(file.path)) return false; seen.add(file.path); return true; })], ...(note ? { note } : {}) } });
    } catch (error) { toTui({ id: msg.id, error: { code: -32603, message: error.message ?? 'Could not read context files.' } }); }
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
  const unrecorded = (error, method) => typeof error?.message === "string" && error.message.includes("is not materialized yet;") && error.message.includes(`${method} is unavailable before first user message`);
  async function nativeProviderHistory(method, params) {
    try { return await engineCall(method, params); }
    catch (error) {
      // A subscription turn can be active before its native carrier has any turns.
      // This known empty-carrier state is distinct from load/permission failures.
      if (unrecorded(error, method)) return { data: [], nextCursor: null, backwardsCursor: null };
      // Until a chat's first turn is recorded the engine has no state row for it and refuses item
      // pages as unsupported (-32601); its turn list names that state, so ask it before reading empty.
      if (method === "thread/items/list" && error?.code === -32601) {
        const probe = await engineCall("thread/turns/list", { threadId: params.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }).then(() => null, (e) => e);
        if (unrecorded(probe, "thread/turns/list")) return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw error;
    }
  }
  async function providerHistory(threadId, store) {
    const page = await nativeProviderHistory("thread/turns/list", { threadId, limit: 100, sortDirection: "desc", itemsView: "full" });
    const native = page?.data ?? resumeResults.get(threadId)?.thread?.turns ?? [];
    const running = activeTurns.get(threadId);
    const merged = new Map(native.map((t) => [t.id, t]));
    for (const t of [...claudeTurnsOf(store, threadId), ...(running ? [running.snapshot()] : [])]) merged.set(t.id, t);
    return { turns: [...merged.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)), cursor: page?.nextCursor ?? null };
  }
  function turnProjection(turn, view) {
    if (view === "full") return turn;
    const items = turn.items ?? [];
    const first = items.find(item => item.type === "userMessage");
    const last = items.findLast(item => item.type === "agentMessage");
    return { ...turn, itemsView: view, items: view === "notLoaded" ? [] : [first, last].filter(Boolean) };
  }
  // Provider records and native records have independent continuations. Never forward
  // these cursors to the engine, or truncate a merged page behind its native cursor.
  async function providerPage(threadId, store, kind, params = {}) {
    const direction = params.sortDirection ?? "desc";
    const view = params.itemsView ?? "summary";
    const max = kind === "turns" ? 100 : 1000;
    const limit = params.limit ?? (kind === "turns" ? 25 : 50);
    if (!["asc", "desc"].includes(direction) || !["summary", "full", "notLoaded"].includes(view) || !Number.isInteger(limit) || limit < 1 || limit > max) throw new Error("Invalid provider history page options");
    const binding = { threadId, kind, direction, view, turnId: params.turnId ?? null };
    const encode = state => "acp-page:" + Buffer.from(JSON.stringify({ ...binding, ...state })).toString("base64url");
    let state = { nativeCursor: null, nativeSeen: [], nativeLimit: limit, storedAfter: null, boundary: null };
    let legacy = false;
    if (params.cursor) {
      if (typeof params.cursor !== "string" || params.cursor.length > 100000) throw new Error("Invalid provider history cursor");
      if (params.cursor.startsWith("acp-page:")) {
        try {
          const decoded = JSON.parse(Buffer.from(params.cursor.slice(9), "base64url").toString());
          for (const [key, value] of Object.entries(binding)) if (decoded[key] !== value) throw new Error();
          if (!Array.isArray(decoded.nativeSeen) || decoded.nativeSeen.length > max || decoded.nativeSeen.some(id => typeof id !== "string") || !(decoded.nativeCursor === null || typeof decoded.nativeCursor === "string")) throw new Error();
          if (!Number.isInteger(decoded.nativeLimit) || decoded.nativeLimit < 1 || decoded.nativeLimit > max || !(decoded.boundary === null || typeof decoded.boundary === "string")) throw new Error();
          for (const key of ["storedAfter"]) if (!(decoded[key] === null || (Array.isArray(decoded[key]) && decoded[key].length === 2 && Number.isFinite(decoded[key][0]) && typeof decoded[key][1] === "string"))) throw new Error();
          state = decoded;
        } catch { throw new Error("Invalid or mismatched provider history cursor"); }
      } else { state.nativeCursor = params.cursor; legacy = true; }
    }
    const running = activeTurns.get(threadId);
    const child = childIds.has(threadId) ? (await storedChildren(null)).get(threadId) : null;
    const turns = new Map((child ? child.turns : claudeTurnsOf(store, threadId)).map(turn => [turn.id, turn]));
    if (running) turns.set(running.turnId, running.snapshot(kind === "turns" ? view : "full"));
    const itemPositions = new Map();
    const records = kind === "turns" ? [...turns.values()] : [...turns.values()].filter(turn => !params.turnId || turn.id === params.turnId).flatMap(turn => (turn.items ?? []).map((item, index) => {
      if (turn.startedAtMs != null) itemPositions.set(`${turn.id}:${item.id}`, index);
      return { turnId: turn.id, item, startedAtMs: turn.startedAtMs ?? (turn.startedAt ?? 0) * 1000 + index, completedAtMs: turn.completedAt == null ? null : turn.completedAt * 1000 };
    }));
    const idOf = row => kind === "turns" ? row.id : row.item?.id;
    const keyOf = row => {
      const position = itemPositions.get(`${row.turnId}:${row.item?.id}`);
      return [kind === "turns" ? (row.startedAtMs == null ? row.startedAt ?? 0 : row.startedAtMs / 1000) : row.startedAtMs ?? 0,
        position == null ? String(idOf(row) ?? "") : `${String(position).padStart(10, "0")}:${idOf(row)}`];
    };
    const compareKey = (a, b) => ((a[0] - b[0]) || a[1].localeCompare(b[1])) * (direction === "desc" ? -1 : 1);
    const compare = (a, b) => compareKey(keyOf(a), keyOf(b));
    const providerIds = new Set(records.map(idOf));
    const stored = legacy ? [] : records.filter(row => (!state.storedAfter || compareKey(keyOf(row), state.storedAfter) > 0)).sort(compare);
    let storedIndex = 0;
    let nativePage = null;
    let nativeRows = [];
    let nativeDone = !!child;
    let seen = new Set(state.nativeSeen);
    const nativeParams = { threadId, limit: state.nativeLimit, sortDirection: direction, ...(kind === "turns" ? { itemsView: view } : params.turnId ? { turnId: params.turnId } : {}) };
    const ensureNative = async () => {
      while (!nativeRows.length && !nativeDone) {
        if (nativePage) {
          if (!nativePage.nextCursor) { nativeDone = true; break; }
          if (nativePage.nextCursor === state.nativeCursor) throw new Error("Native history cursor did not advance");
          state.nativeCursor = nativePage.nextCursor;
          seen = new Set();
        }
        nativePage = await nativeProviderHistory(`thread/${kind}/list`, { ...nativeParams, ...(state.nativeCursor ? { cursor: state.nativeCursor } : {}) });
        nativeRows = (nativePage.data ?? []).filter(row => !providerIds.has(idOf(row)) && !seen.has(idOf(row)));
      }
    };
    const data = [];
    let pageBytes = 2;
    const pageByteLimit = 6 * 1024 * 1024;
    while (data.length < limit) {
      await ensureNative();
      const a = stored[storedIndex], b = nativeRows[0];
      if (!a && !b) break;
      // Keep the native rollout order intact, including ties across native pages.
      const storedFirst = a && (!b || ((keyOf(a)[0] - keyOf(b)[0]) * (direction === "desc" ? -1 : 1) < 0) || (keyOf(a)[0] === keyOf(b)[0] && direction === "desc"));
      const row = storedFirst ? (kind === "turns" ? turnProjection(a, view) : a) : b;
      const skipping = state.boundary && idOf(row) !== state.boundary;
      if (!skipping) {
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes > pageByteLimit) throw new Error(`History ${kind === "items" ? "item" : "turn"} ${idOf(row)} exceeds the supported page size; its saved content was not truncated.`);
        if (data.length && pageBytes + bytes > pageByteLimit) break;
        pageBytes += bytes;
      }
      if (storedFirst) {
        storedIndex++;
        state.storedAfter = keyOf(a);
      } else {
        nativeRows.shift();
        seen.add(idOf(b));
      }
      if (skipping) continue;
      state.boundary = null;
      data.push(row);
    }
    // Determine continuation without hydrating another native page.
    const moreNative = nativeRows.length || (!nativeDone && nativePage?.nextCursor);
    state.nativeSeen = [...seen];
    const nextCursor = storedIndex < stored.length || moreNative ? encode(state) : null;
    let backwardsCursor = null;
    if (data.length) {
      backwardsCursor = "acp-page:" + Buffer.from(JSON.stringify({ ...binding, direction: direction === "desc" ? "asc" : "desc", nativeCursor: null, nativeSeen: [], nativeLimit: limit, storedAfter: null, boundary: idOf(data[0]) })).toString("base64url");
    }
    return { data, nextCursor, backwardsCursor };
  }
  async function resumeHistory(result, threadId, store, params) {
    result = { ...result, thread: { ...result.thread, ...threadSeen.get(threadId) } };
    const owner = providerOwners.get(threadId);
    if (owner) result.thread.status = owner.status();
    if (params.excludeTurns) {
      result.thread.turns = [];
      result.turnsBackwardsCursor = null;
    } else {
      const history = await providerHistory(threadId, store);
      result.thread.turns = history.turns;
      result.turnsBackwardsCursor = history.cursor;
    }
    result.initialTurnsPage = params.initialTurnsPage ? await providerPage(threadId, store, "turns", params.initialTurnsPage) : null;
    return result;
  }
  async function listProviderHistory(msg, store) {
    const tid = msg.params?.threadId;
    const existing = providerOwners.get(tid);
    if (existing && existing.ws !== ws) {
      const target = forwarded.get(msg.id);
      forwarded.delete(msg.id);
      existing.dispatch(msg, target?.client ?? ws);
      return;
    }
    const result = await providerPage(tid, store, msg.method === "thread/turns/list" ? "turns" : "items", msg.params);
    toTui({ id: msg.id, result });
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
  // The engine's own chats and helpers get the delegate tool while the Subagents switch is on (A37).
  // WR6: a chat the person talks to gets the workflow tool whatever the switch says; a helper never does.
  const withAgents = async (params, helper = false) => {
    if (!params) return;
    const tools = engineAgentsConfig(await subagentsAllowed(params.cwd), !helper);
    if (Object.keys(tools).length) params.config = { ...params.config, ...tools };
  };
  const activeTurns = new BusyMap(); // thread id -> its running Claude or Antigravity turn
  const reconnects = new Map(); // thread id -> the timer of its retry after a dropped connection
  const pendingMirrors = new Map(); // native history copies do not own the provider's turn status
  const engineTurns = new BusyMap(); // thread id -> its running engine turn
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
    if (threadAccess.get(tid)?.profile === profile && threadPolicy.get(tid) === 'never') { resolve(true); return; }
    const confirm = (confirmed) => { if (confirmed === profile && threadPolicy.get(tid) === 'never') settle(true); };
    const settle = (ok, why) => { clearTimeout(timer); confirmations.get(tid)?.delete(confirm); if (!ok) log(`helper ${tid} not set to ${profile}: ${why}`); resolve(ok); };
    const timer = setTimeout(() => settle(false, "no confirmation"), HELPER_RESTRICT_MS);
    if (!confirmations.has(tid)) confirmations.set(tid, new Set());
    confirmations.get(tid).add(confirm);
    engineCall("thread/settings/update", { threadId: tid, approvalPolicy: 'never', approvalsReviewer: 'user', permissions: profile }).catch((e) => settle(false, e?.message ?? JSON.stringify(e)));
  });
  const ownHelpers = new Map(); // helper thread id open on this connection -> { applying, waiting, failed }
  const releaseHelpers = () => {
    for (const tid of ownHelpers.keys()) {
      const h = helperScope.get(tid);
      h?.owners.delete(restrictHelper);
      if (h?.activeOwner === restrictHelper) h.activeOwner = null;
    }
  };
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
      context.failed = true;
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
  // Apply a helper's current default scope; its turns wait for engine confirmation.
  const enforceHelper = (tid) => {
    const own = ownHelpers.get(tid);
    const profile = { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[helperScope.get(tid)?.ceiling];
    const applying = own.applying = applyProfile(tid, profile).then(async (ok) => {
      own.failed = !ok;
      if (ok) own.waiting.length = 0;
      else await failHelper(tid, "its chat's restricted permissions could not be applied");
      if (own.applying === applying) own.applying = null;
      return ok;
    });
    return applying;
  };
  // Update each connection holding a helper. Provider tools follow the confirmed
  // bridge policy; native tools follow the engine's confirmed settings.
  const restrictHelper = (tid) => {
    const previousAccess = accessModeOf(tid, "claude", threadPolicy.get(tid) !== "never");
    const ceiling = helperScope.get(tid)?.ceiling ?? 'read-only';
    threadSandbox.set(tid, ceiling);
    stopIfReduced(tid, previousAccess);
    if (claudeModel.has(tid)) return applyProfile(tid, { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[ceiling]);
    return enforceHelper(tid);
  };
  // Opens a helper on this connection, under the lower of its known ceiling and `ceiling`.
  const openHelper = (tid, d, ceiling) => {
    let h = helperScope.get(tid);
    if (!h) helperScope.set(tid, h = { parentThreadId: d.parentThreadId, requested: d.requested, ceiling, owners: new Set() });
    h.ceiling = lowest(h.ceiling, ceiling);
    h.model = d.model ?? h.model;
    h.owners.add(restrictHelper);
    ownHelpers.set(tid, { applying: null, waiting: [], failed: false });
    threadSandbox.set(tid, h.ceiling);
    if (helperConns.has(ws) && !isBridged(h.model)) claimEngineHelper(tid, h);
    return h;
  };
  // A request for a helper's thread asks for no more than its ceiling: a read-only helper is
  // asked to be read-only, and only a Full Access one is given Full Access, never Bypass. `field` is the request's sandbox field.
  const boundAccess = (p, ceiling, field) => {
    if (ceiling === "danger-full-access") { if (p.permissions === ":bypass-permissions") p.permissions = ":danger-full-access"; return; }
    const wide = UNSANDBOXED.includes(p.permissions) || p[field] === "danger-full-access" || ["dangerFullAccess", "externalSandbox"].includes(p[field]?.type);
    if (ceiling === "workspace-write" && !wide) return;
    delete p.permissions; delete p[field];
    if (field === "sandbox") p.sandbox = ceiling;
    else p.permissions = ceiling === "read-only" ? ":read-only" : ":workspace";
  };
  // A reopened helper (resumeThread bounded its request): its ceiling, saved if it fell, and its
  // engine checked to be within it. False if the engine could not be brought within it.
  async function adoptHelper(tid, r, bridged) {
    const h = openHelper(tid, r, r.ceiling);
    if (explicitChatChoices.has(tid)) return true;
    if (h.ceiling !== r.stored) updateStore((st) => { if (st._delegations?.[tid]) st._delegations[tid].ceiling = h.ceiling; });
    const profile = threadAccess.get(tid)?.profile;
    const want = h.ceiling === "read-only" ? ":read-only" : h.ceiling === "workspace-write" ? (UNSANDBOXED.includes(profile) ? ":workspace" : null)
      : profile === ":bypass-permissions" ? ":danger-full-access" : null;
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
    if (existing && existing.ws !== ws && !existing.nativeHelper) {
      const route = forwarded.get(msg.id); forwarded.delete(msg.id); pendingResume.delete(msg.id); resumeOptions.delete(msg.id); openingReplies.delete(msg.id);
      existing.dispatch({ ...msg, id: route?.id ?? msg.id }, route?.client ?? ws); return;
    }
    if ((claudeModel.has(tid) || existing?.nativeHelper) && resumeResults.has(tid)) {
      const params = { threadId: tid };
      for (const k of ["approvalPolicy", "approvalsReviewer", "permissions", "model", "effort"]) if (msg.params[k] != null) params[k] = msg.params[k];
      if (msg.params.sandbox) params.permissions ??= { "read-only": ":read-only", "workspace-write": ":workspace", "danger-full-access": ":danger-full-access" }[msg.params.sandbox];
      if (d && !explicitChatChoices.has(tid)) boundAccess(params, ceilingOf(tid, d), "sandboxPolicy");
      try {
        if (Object.keys(params).length > 1) {
          if (isBridged(params.model)) { claudeModel.set(tid, params.model); delete params.model; }
          await engineCall("thread/settings/update", params);
        }
        let result = { ...resumeResults.get(tid), ...(claudeModel.has(tid) && { model: claudeModel.get(tid), reasoningEffort: claudeEffort.get(tid) ?? null }) };
        result = await resumeHistory(result, tid, savedStore, msg.params ?? {});
        await markHelpers(result);
        pendingResume.delete(msg.id); resumeOptions.delete(msg.id);
        toTui({ id: msg.id, result });
        replayPlan(tid);
      } catch (e) { pendingResume.delete(msg.id); resumeOptions.delete(msg.id); toTui({ id: msg.id, error: Number.isInteger(e.code) ? e : { code: -32603, message: e.message ?? String(e) } }); }
      return;
    }
    if (!existing && savedStore[tid]?.model) {
      claudeModel.set(tid, savedStore[tid].model);
      if (savedStore[tid].effort) claudeEffort.set(tid, savedStore[tid].effort);
      claimProvider(tid);
    }
    if (d) {
      const r = { parentThreadId: d.parentThreadId, model: d.model, requested: d.requested ?? "read-only", ceiling: ceilingOf(tid, d), stored: d.ceiling };
      pendingAdopt.set(msg.id, r);
      pendingHelpers.add(r);
      if (!explicitChatChoices.has(tid)) boundAccess(msg.params, r.ceiling, "sandbox");
    }
    if (!claudeModel.has(tid)) await withAgents(msg.params, !!d);
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }
  lineReader(engine.stdout, async (line) => {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed && !parsed.method && permissionRefreshes.delete(parsed.id) && !parsed.error) {
      try {
        const loaded = new Set((await engineCall('thread/loaded/list', {})).data ?? []);
        for (const tid of chatAccess.keys()) {
          const choice = await permissionChoices.read(tid);
          if (!loaded.has(tid) || helperThreads.has(tid) || (choice && !choice.inherit && !choice.automatic)) continue;
          const read = await engineCall('config/read', { includeLayers: true, ...(threadCwd.get(tid) ? { cwd: threadCwd.get(tid) } : {}) });
          const settings = defaultPermissionSettings(read, choice?.automatic === true);
          if (settings) await engineCall('thread/settings/update', { threadId: tid, ...settings });
        }
        const scopes = [];
        for (const [tid, helper] of helperScope) {
          const choice = await permissionChoices.read(tid);
          if (helper.requested === 'read-only' || (choice && !choice.inherit && !choice.automatic)) continue;
          const read = await engineCall('config/read', { includeLayers: true, ...(threadCwd.get(tid) ? { cwd: threadCwd.get(tid) } : {}) });
          const settings = defaultPermissionSettings(read, true);
          const ceiling = { ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' }[settings.permissions];
          if (ceiling) { helper.ceiling = ceiling; scopes.push([tid, helper]); }
        }
        if (scopes.length) {
          await updateStore(store => { for (const [tid, helper] of scopes) if (store._delegations?.[tid]) store._delegations[tid].ceiling = helper.ceiling; });
          const applied = await Promise.all(scopes.flatMap(([tid, helper]) => [...helper.owners].map(apply => apply(tid))));
          if (applied.some(ok => !ok)) throw new Error('An automatic agent could not apply the new default permissions.');
        }
      } catch (error) { parsed = { id: parsed.id, error: { code: -32603, message: `The default was saved, but an open chat could not be updated: ${error.message ?? error}` } }; }
      line = JSON.stringify(parsed);
    }
    if (parsed && !parsed.method && permissionWrites.has(parsed.id)) {
      const write = permissionWrites.get(parsed.id); permissionWrites.delete(parsed.id);
      if (!parsed.error) {
        try {
          const tid = write.threadId ?? parsed.result?.thread?.id;
          if (!write.settings.inherit && !write.settings.automatic) explicitChatChoices.add(tid);
          if (write.ephemeral) { if (write.settings.automatic) automaticThreads.add(tid); }
          else await permissionChoices.write(tid, write.settings);
        }
        catch { parsed = { id: parsed.id, error: { code: -32603, message: 'The permission choice could not be saved. Choose it again before restarting.' } }; line = JSON.stringify(parsed); }
      }
    }
    if (parsed && !parsed.method && pendingHelperTurns.has(parsed.id)) {
      const tid = pendingHelperTurns.get(parsed.id);
      pendingHelperTurns.delete(parsed.id);
      if (parsed.result?.turn?.status === "inProgress") engineTurns.set(tid, parsed.result.turn.id);
      checkIdle();
    }
    const th = parsed?.result?.thread ?? parsed?.params?.thread;
    if (th?.id && th?.cwd) { threadCwd.set(th.id, th.cwd); threadSeen.set(th.id, { ...th, turns: [] }); }
    if (parsed?.method === 'thread/started' && th?.id && (th.parentThreadId || th.source?.subAgent)) {
      automaticThreads.add(th.id);
      try {
        const requirements = (await engineCall('configRequirements/read', {})).requirements ?? {};
        const settings = defaultPermissionSettings(await engineCall('config/read', { includeLayers: true, ...(th.cwd ? { cwd: th.cwd } : {}) }), true);
        if (!permissionSettingsAllowed(settings, requirements)) throw new Error('Managed settings forbid Full access for this automatic agent.');
        await engineCall('thread/settings/update', { threadId: th.id, ...settings });
        await permissionChoices.write(th.id, { ...settings, automatic: true });
      } catch (error) {
        blockedAutomaticThreads.add(th.id);
        notify('warning', { threadId: th.id, message: error.message ?? String(error) });
      }
    }
    if (parsed?.method === 'turn/started' && blockedAutomaticThreads.has(parsed.params?.threadId)) {
      void engineCall('turn/interrupt', { threadId: parsed.params.threadId, turnId: parsed.params.turn.id }).catch(error => log(`automatic agent interrupt: ${error.message ?? error}`));
    }
    if (parsed?.id !== undefined && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(parsed.method)
      && (automaticThreads.has(parsed.params?.threadId) || helperScope.has(parsed.params?.threadId))) {
      const own = await permissionChoices.read(parsed.params.threadId);
      if (!own || own.inherit || own.automatic) {
        engine.stdin.write(JSON.stringify({ id: parsed.id, result: { decision: !blockedAutomaticThreads.has(parsed.params.threadId) && fullFor(parsed.params.threadId) ? 'accept' : 'decline' } }) + '\n');
        return;
      }
    }
    if (th?.id && parsed?.result?.approvalPolicy) { noteAccess(th.id, parsed.result); resumeResults.set(th.id, { ...parsed.result, thread: { ...th } }); }
    if (parsed?.method === "thread/name/updated") {
      const { threadId, threadName } = parsed.params;
      if (threadSeen.has(threadId)) threadSeen.get(threadId).name = threadName;
      if (resumeResults.has(threadId)) resumeResults.get(threadId).thread.name = threadName;
    }
    if (parsed?.method === "turn/started" && parsed.params?.turn?.id) engineTurns.set(parsed.params.threadId, parsed.params.turn.id);
    if (parsed?.method === "turn/completed") { engineTurns.delete(parsed.params?.threadId); checkIdle(); }
    const helperId = parsed?.params?.threadId;
    const helperOwner = providerOwners.get(helperId);
    const helper = helperOwner?.nativeHelper && helperOwner.ws === ws ? helperScope.get(helperId) : null;
    if (helper) {
      const turn = parsed.params?.turn;
      if (parsed.method === "turn/started" && turn?.id) {
        helper.lastTurn = { ...turn, items: [], itemsView: "notLoaded" };
        helper.activeOwner = restrictHelper;
      } else if (parsed.method === "turn/completed" && turn?.id === helper.lastTurn?.id) {
        helper.lastTurn = { ...turn, items: [], itemsView: "notLoaded" };
        helper.activeOwner = null;
      } else if (parsed.method === "thread/status/changed") {
        if (parsed.params.status?.type === "active") helper.activeOwner = restrictHelper;
        else if (["idle", "notLoaded"].includes(parsed.params.status?.type) && helper.activeOwner === restrictHelper) helper.activeOwner = null;
      }
    }
    // An unsubscribed native thread no longer sends its turn/completed here. The engine
    // broadcasts thread/closed after its work stops and its unsubscribed runtime unloads.
    if (parsed?.method === "thread/closed") engineTurns.delete(parsed.params?.threadId);
    if (parsed?.method === "thread/status/changed" && ["idle", "notLoaded"].includes(parsed.params?.status?.type)) engineTurns.delete(parsed.params.threadId);
    if (parsed?.method === "thread/settings/updated") {
      const tid = parsed.params?.threadId;
      const previousAccess = accessModeOf(tid, "claude", threadPolicy.get(tid) !== "never");
      noteAccess(tid, parsed.params?.threadSettings);
      stopIfReduced(tid, previousAccess);
    }
    shareHelper(parsed);
    notePlan(parsed);
    if (parsed?.method === "thread/unarchived" && parsed.params?.threadId) chatBack(parsed.params.threadId);
    if (parsed?.method === "thread/smartPrune/updated" && parsed.params?.threadId) smartPrune.set(parsed.params.threadId, !!parsed.params.smartPrune?.enabled);
    if (parsed?.method && parsed.id !== undefined && ((helperConns.has(ws) && helperThreads.has(parsed.params?.threadId)) || providerOwners.get(parsed.params?.threadId)?.ws === ws)
      && relayToTui(parsed, (reply) => engine.stdin.write(JSON.stringify({ id: parsed.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }) + "\n"), ws)) return;
    if (parsed && pendingNativeRoutes.has(parsed.id)) {
      const route = pendingNativeRoutes.get(parsed.id);
      pendingNativeRoutes.delete(parsed.id);
      if (!parsed.error) {
        claudeModel.delete(route.threadId); claudeEffort.delete(route.threadId);
        providerOwners.delete(route.threadId); resumeResults.delete(route.threadId);
        sessions.delete(route.threadId);
        await updateStore(store => {
          const record = store[route.threadId];
          if (record) { record.providerHistory = true; record.model = null; delete record.effort; record.nativeModel = route.model; }
        });
        const seen = threadSeen.get(route.threadId);
        if (seen) { seen.model = route.model; seen.reasoningEffort = route.effort ?? null; }
      }
    }
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
      missingThreadUntil.delete(t.id);
      await Promise.all([...startingProviders.values()].map((p) => p.ready));
      const starting = [...pendingStart.values()].filter((pick) => pick?.model);
      const pick = !claudeModel.has(t.id) && starting.length === 1 ? starting[0] : null;
      if (pick && t.model !== pick.model) { t.model = pick.model; t.reasoningEffort = pick.effort ?? null; helpersMarked = true; } // shown only; routing waits for the answer
      else helpersMarked = ownModel(t, await loadStore());
    }
    if (parsed && pendingLimitsRead.delete(parsed.id)) { await addSubscriptionLimits(parsed); helpersMarked = true; }
    if (parsed && pendingHelperMark.has(parsed.id)) {
      pendingHelperMark.delete(parsed.id);
      helpersMarked = await markHelpers(parsed.result, pendingChildList.get(parsed.id)).catch((e) => { log(`helpers: ${e.message ?? e}`); return false; });
    }
        if (parsed.id != null && pendingTurnsList.has(parsed.id)) pendingTurnsList.delete(parsed.id);
        if (parsed.id != null && pendingItemsList.has(parsed.id)) pendingItemsList.delete(parsed.id);

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
          ws.send(JSON.stringify({ id: parsed.id, error: Number.isInteger(e.code) ? e : { code: -32603, message: e.message ?? String(e) } }));
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
      if (def?.model && !signedOutModel(def.model) && parsed.result?.config) {
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
        // Every connection uses this helper's resolved scope.
        if (openHelper(tid, d, d.ceiling).ceiling !== d.sandbox) restrictHelper(tid);
        const { ceiling } = helperScope.get(tid);
        const run = d.workflowRunId ? { workflowRunId: d.workflowRunId, workflowAgentId: d.workflowAgentId } : {};
        updateStore((st) => { st._delegations = { ...st._delegations, [tid]: { parentThreadId: d.parentThreadId, model: d.model, startedAt: Math.floor(now() / 1000), requested: d.requested, ceiling, ...run } }; });
        log(`helper thread ${tid} (${d.model}) started by ${d.parentThreadId}`);
        helperThreads.add(tid);
        toOthers({ method: "thread/started", params: { thread: { ...parsed.result.thread, parentThreadId: d.parentThreadId, ...run, turns: [] } }, emittedAtMs: now() });
      }
    }
    if (parsed && openingMcp.has(parsed.id)) {
      const tid = parsed.result?.thread?.id;
      if (tid) threadMcp.set(tid, openingMcp.get(parsed.id));
      openingMcp.delete(parsed.id);
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
        nameModel(parsed.result, pick.model, pick.effort);
        claimProvider(tid, parsed.result);
        announceLimits(agentOf(pick.model), (method, params) => ws.send(JSON.stringify({ method, params })));
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
      const tid = pendingResume.get(parsed.id); pendingResume.delete(parsed.id); resumeOptions.delete(parsed.id);
      if (providerOwners.get(tid)?.ws === ws && !resumeResults.has(tid)) providerOwners.delete(tid);
    }
    if (parsed && pendingAdopt.has(parsed.id) && !parsed.result?.thread?.id) { pendingHelpers.delete(pendingAdopt.get(parsed.id)); pendingAdopt.delete(parsed.id); }
    if (parsed && pendingResume.has(parsed.id) && parsed.result?.thread?.id) {
      const requestedResume = resumeOptions.get(parsed.id) ?? {};
      resumeOptions.delete(parsed.id);
      pendingResume.delete(parsed.id);
      reopened = parsed.result.thread.id;
      missingThreadUntil.delete(reopened);
      await storeChain;
      const saved = (await loadStore())[parsed.result.thread.id];
      const helper = pendingAdopt.get(parsed.id);
      pendingAdopt.delete(parsed.id); pendingHelpers.delete(helper);
      if (helper && !(await adoptHelper(reopened, helper, !!saved?.model))) {
        ws.send(JSON.stringify({ id: parsed.id, error: { code: -32600, message: "The helper was not reopened: its chat's restricted permissions could not be applied." } }));
        if (helperConns.has(ws)) failHelper(reopened, "its chat's restricted permissions could not be applied");
        return;
      }
      if (saved?.model || saved?.providerHistory) {
        if (saved.model) claudeModel.set(parsed.result.thread.id, saved.model);
        if (saved.effort) claudeEffort.set(parsed.result.thread.id, saved.effort);
        if (saved.model) { nameModel(parsed.result, saved.model, saved.effort); claimProvider(parsed.result.thread.id, parsed.result); }
        try { parsed.result = await resumeHistory(parsed.result, parsed.result.thread.id, await loadStore(), requestedResume); }
        catch (error) { toTui({ id: parsed.id, error: Number.isInteger(error.code) ? error : { code: -32603, message: error.message } }); return; }
        log(`resume ${parsed.result.thread.id} -> ${saved.model}`);
        ws.send(JSON.stringify(parsed));
        if (saved.model) announceLimits(agentOf(saved.model), (method, params) => ws.send(JSON.stringify({ method, params })));
        replayPlan(parsed.result.thread.id);
        return;
      }
    }
    if (parsed?.method === "thread/settings/updated" && claudeModel.has(parsed.params?.threadId) && ![...pendingNativeRoutes.values()].some(route => route.threadId === parsed.params.threadId)) {
      const tid = parsed.params.threadId;
      parsed.params.threadSettings = { ...parsed.params.threadSettings, model: claudeModel.get(tid), effort: claudeEffort.get(tid) ?? parsed.params.threadSettings?.effort ?? null };
      ws.send(JSON.stringify(parsed));
      return;
    }
    if (parsed && pendingModelList.has(parsed.id) && Array.isArray(parsed.result?.data)) {
      pendingModelList.delete(parsed.id);
      // A subscription Elpis is signed out of offers no models (and is not even started).
      const noModels = { models: [], efforts: {}, fallback: null };
      const catalogWithin = (agent) => {
        let timer;
        return Promise.race([catalogFor(agent), new Promise((resolve) => { timer = setTimeout(resolve, 30000, noModels); })])
          .finally(() => clearTimeout(timer));
      };
      const lists = await Promise.all(AGENTS.map((agent) => agent.signedOut?.() ? noModels : catalogWithin(agent)));
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
        // The adapter reports a guessed 200k window until a turn's result gives the model's real
        // one, and only a result's update carries a cost. Until then the window is unknown.
        const known = lastContext.get(threadId)?.size ?? null;
        const size = u.cost && typeof u.size === "number" ? u.size : known;
        lastContext.set(threadId, { used: u.used, size });
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

  // A37: a background job Claude started can end after its reply. Claude then answers on its own,
  // outside any prompt (the adapter's autonomous cycle), so between turns the chat's session wakes
  // a followup turn that shows the answer, as Claude Code does. Updates that carry no reply
  // (commands, modes, usage) wake nothing.
  function listenBetweenTurns(threadId, acp, sessionId) {
    const turnFor = (wake) => {
      const running = activeTurns.get(threadId);
      if (running || !wake || sessions.get(threadId)?.id !== sessionId || deletedThreads.has(threadId)) return running ?? null;
      void claudeTurn({ kind: "followup", params: { threadId }, acp, sessionId });
      return activeTurns.get(threadId) ?? null;
    };
    acp.bySession.set(sessionId, {
      // Until the turn listens itself, its updates reach it in order once its session is ready.
      onUpdate: (params) => { const t = turnFor(REPLY_UPDATES.has(params.update?.sessionUpdate)); t?.ready.then(() => t.own?.onUpdate(params)); },
      onPermission: async (params) => { const t = turnFor(true); return t && (await t.ready) && t.own?.onPermission ? t.own.onPermission(params) : null; },
    });
  }

  async function claudeTurn(req) {
    const { threadId, input = [] } = req.params;
    clearTimeout(reconnects.get(threadId));
    reconnects.delete(threadId);
    const turnId = randomUUID();
    const turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    if (req.id !== undefined) toTui({ id: req.id, result: req.kind === "review" ? { turn, reviewThreadId: threadId } : { turn } });
    const compacting = req.kind === "compact";
    // A37: Claude's own reply after a background job it started ends (listenBetweenTurns): no user message, no prompt.
    const followup = req.kind === "followup";
    const startedAt = Math.floor(now() / 1000);
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId, turn: { ...turn, startedAt } });
    notify("turn/costUpdated", { threadId, turnId, cost: { type: "unavailable", reason: "subscriptionAuthentication" } });
    const t0 = now();
    turn.startedAtMs = t0;
    let firstTokenAt = null;
    const userItem = followup ? null : req.kind === "review"
      ? { type: "enteredReviewMode", id: randomUUID(), review: req.reviewHint }
      : { type: "userMessage", id: randomUUID(), clientId: req.params.clientUserMessageId ?? null, content: input };
    const lead = userItem ? [userItem] : [];
    // A chat's first turn is not a saved turn until it ends; this lets any connection list the chat meanwhile.
    updateStore((st) => { st[threadId] = { ...st[threadId], active: { turnId, startedAt, startedAtMs: t0, pid: process.pid, cwd: threadCwd.get(threadId) ?? process.cwd(), userItems: lead, ...(userItem && { preview: previewOf(userItem).trim().slice(0, 500) }) } }; });
    for (const item of lead) {
      notify("item/started", { item, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
    }

    const cwd = threadCwd.get(threadId) ?? process.cwd();
    const lane = newLane(threadId, turnId, cwd, true);
    const { items, tools, closeMessage } = lane;
    // Claude's subagents in this turn: ACP session -> the child thread's lane.
    const subLanes = new Map();
    const busy = () => [...tools.values()].some((t) => !t.end) || [...subLanes.values()].some((l) => !l.done);
    // The running turn, from its first moment, so a steer or a stop during setup finds it.
    let sessionReady, finishTurn;
    const done = new Promise((resolve) => { finishTurn = resolve; });
    const turnState = { threadId, turnId, done, sessionId: null, items, closeMessage, cancelled: false, ready: new Promise((r) => { sessionReady = r; }), toolsIdle: [], steers: Promise.resolve(), promptEnded: false, bufferedUpdates: null };
    // Claude Code takes a steer at once and drops a tool that is still running (a subagent too),
    // so a steer waits for the running tools, as Claude Code's own queue does.
    turnState.toolsBusy = busy;
    turnState.whenToolsIdle = () => (!busy() ? Promise.resolve() : new Promise((r) => turnState.toolsIdle.push(r)));
    lane.onIdle = () => { if (!busy()) turnState.toolsIdle.splice(0).forEach((r) => r()); };
    turnState.snapshot = (view = "full") => ({ ...turn, startedAt, itemsView: view, items: view === "notLoaded" ? [] : view === "summary" ? [...lead, ...(lane.message ? [lane.message] : items.filter(item => item.type === "agentMessage").slice(-1))] : [...lead, ...items, ...(lane.message ? [lane.message] : [])] });
    // A followup ends at Claude's autonomous result, or when the user stops it.
    if (followup) turnState.followupEnded = new Promise((resolve) => { turnState.endFollowup = resolve; });
    activeTurns.set(threadId, turnState);
    let status = "completed";
    let error = null;
    const agent = agentOf(claudeModel.get(threadId)) ?? AGENTS[0];
    const accountId = agent.key === "claude" ? claudeAccounts.activeId() : null;
    let lastClaudeMessageId = null;
    try {
      await pendingMirrors.get(threadId);
      const carrier = threadSeen.get(threadId);
      if (!carrier?.ephemeral && carrier?.historyMode === "paginated" && !materializedProviders.has(threadId)) {
        // Native turns persist at TurnStart; provider turns never enter that path.
        // A full paginated read is the engine's Standard persistence barrier. Wait
        // before inference so a crash cannot leave Claude's record without its carrier.
        await engineCall("thread/read", { threadId, includeTurns: true }, 5000);
        materializedProviders.add(threadId);
      }
      refuseSignedOut(agent);
      const acp = followup ? req.acp : await ensureAcp(agent);
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
      const instructions = [await elpisInstructions(threadId), ...(!subagents ? [SUBAGENTS_DISABLED] : [])].filter(Boolean).join("\n\n");
      // MCP servers are fixed when a session is created, so changed app servers reload it.
      const appServers = acpServersFrom(threadMcp.get(threadId), threadId);
      const mcp = JSON.stringify(appServers);
      if (followup) sessionId = req.sessionId;
      else if (live && (live.accountId ?? null) === accountId && live.mode === mode && live.subagents === subagents && live.agent === agent.key && live.prune === prune && live.instructions === instructions && (live.mcp ?? "[]") === mcp) sessionId = live.id;
      else {
        const cwd = threadCwd.get(threadId) ?? process.cwd();
        const proxy = prune ? await smartPruneProxy() : null;
        const browser = appServers.some((s) => s.name === "elpis_browser");
        const options = { ...(ask && { settingSources: ["project", "local"] }), ...(browser && { allowedTools: ["mcp__elpis_browser"] }), ...(!subagents && { disallowedTools: SUBAGENT_TOOLS }), ...(proxy && { env: { ANTHROPIC_BASE_URL: proxy, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") } }) };
        const _meta = { systemPrompt: { append: instructions }, claudeCode: { options, emitRawSDKMessages: [{ type: "system", subtype: "init" }] } };
        devChars.set(threadId, instructions.length);
        log(`Elpis instructions for ${agent.speaker}: ${instructions.length} chars`);
        await storeChain;
        const store = await loadStore();
        const helper = !!store._delegations?.[threadId] || !!store[threadId]?.parentThreadId;
        const mcpServers = [...mcpServersFor(subagents, threadId, helper ? null : cwd, !helper), ...appServers];
        // A session belongs to one agent; a chat that switched agent starts a fresh one, seeded below.
        const sameAccount = agent.key !== "claude" || (store[threadId]?.claudeAccountId ?? "default") === accountId;
        const sameAgent = (store[threadId]?.agent ?? "claude") === agent.key && sameAccount;
        const saved = (live?.agent === agent.key && (live.accountId ?? null) === accountId ? live.id : null) ?? (sameAgent ? store[threadId]?.session ?? Object.values(store[threadId]?.sessions ?? {})[0] : null);
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
        live = { id: sessionId, mode, subagents, agent: agent.key, accountId, prune, instructions, mcp };
        sessions.set(threadId, live);
        const sid = sessionId;
        updateStore((st) => { st[threadId] = { ...st[threadId], session: sid, mode, agent: agent.key, ...(agent.key === "claude" && { claudeAccountId: accountId }) }; });
      }
      if (!followup) {
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
      }
      turnState.sessionId = sessionId;
      sessionReady(sessionId);
      // The chat's updates draw into this turn; a subagent's come under its own ACP session and
      // draw into its child thread (see spawnSubagent). The turn hears only its own sessions.
      const own = turnState.own = {};
      const drawUpdate = ({ sessionId: sid, update: u }) => {
        if (u.sessionUpdate === "subagent_spawned") { spawnSubagent(u, sid === sessionId ? lane : subLanes.get(sid) ?? lane); return; }
        if (u.sessionUpdate === "subagent_state_update") { finishSubagent(subLanes.get(u.subagentSessionId), u.state); return; }
        const into = sid === sessionId ? lane : subLanes.get(sid);
        if (!into) { log(`update for unknown session ${sid}: ${u.sessionUpdate}`); return; }
        if (into === lane && u.sessionUpdate === "agent_message_chunk") {
          firstTokenAt ??= now();
          // A143: Claude's id for its reply, where a rewind to the next turn forks its session.
          if (typeof u.messageId === "string" && u.messageId) lastClaudeMessageId = u.messageId;
        }
        into.update(u);
        if (followup && into === lane) {
          if (u.sessionUpdate === "usage_update" && AUTONOMOUS_ORIGINS.has(u._meta?.["_claude/origin"]?.kind)) turnState.endFollowup({ stopReason: "end_turn" });
          else quietEnd();
        }
      };
      // Without the adapter's end marker, a followup ends after a minute without updates or running tools.
      const quietEnd = () => {
        clearTimeout(turnState.quiet);
        turnState.quiet = setTimeout(() => { if (busy()) quietEnd(); else turnState.endFollowup({ stopReason: "end_turn" }); }, 60_000);
      };
      own.onUpdate = update => { if (turnState.bufferedUpdates) turnState.bufferedUpdates.push(update); else drawUpdate(update); };
      turnState.flushUpdates = () => {
        const buffered = turnState.bufferedUpdates ?? [];
        turnState.bufferedUpdates = null;
        for (const update of buffered) drawUpdate(update);
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
        if (((threadPolicy.get(threadId) ?? policy) === 'never' && fullFor(threadId)) && !planIds.length) {
          log(`approval ${what} -> allowed (Full Access)`);
          return pick("allow_once") ?? pick("allow_always");
        }
        if ((threadPolicy.get(threadId) ?? policy) === "never" && !planIds.length) {
          log(`approval ${what} -> denied (restricted permissions cannot ask)`);
          if (t) t.declined = true;
          return pick("reject_once") ?? pick("reject_always") ?? null;
        }
        let reason = `${agent.speaker} wants to run: ${what}`;
        if (threadAccess.get(threadId)?.reviewer === "auto_review" && !planIds.length) {
          const reviewAccess = threadAccess.get(threadId);
          try {
            const review = await engineCall("thread/approval/review", { threadId, command: what, cwd, reason });
            if (turnState.cancelled) return undefined;
            if (reviewAccess !== threadAccess.get(threadId)) throw new Error("Permissions changed during automatic review; review the action again.");
            if (!["approved", "denied"].includes(review?.decision) || typeof review.rationale !== "string") throw new Error("Invalid automatic approval review response");
            log(`approval ${what} -> ${review.decision} (auto-review): ${review.rationale}`);
            if (review.decision === "approved") return pick("allow_once");
            if (t) t.declined = true;
            lane.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Automatic approval review denied the action: ${review.rationale}\n` } });
            lane.closeMessage();
            return pick("reject_once") ?? null;
          } catch (error) {
            if (turnState.cancelled) return undefined;
            reason += `\nAutomatic approval review failed: ${error.message ?? JSON.stringify(error)}`;
          }
        }
        const decision = await askTui("item/commandExecution/requestApproval", {
          kind: "command", threadId, turnId, itemId: p.toolCall?.toolCallId ?? randomUUID(), startedAtMs: now(),
          environmentId: null, reason, command: what, cwd,
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
      const file = transcriptOf(threadId);
      let transcriptOffset = 0;
      try { if (file) transcriptOffset = statSync(file).size; } catch {}
      const inputs = [prompt.filter(block => block.type === "text").map(block => block.text).join("\n")];
      turnState.inputs = inputs;
      await updateStore(st => { if (st[threadId]?.active?.turnId === turnId) Object.assign(st[threadId].active, { transcriptOffset, inputs }); });
      let recovering;
      turnState.recover = () => {
        if (recovering) return recovering;
        if (followup || !file || turnState.promptEnded || turnState.cancelled) return;
        return recovering ??= (async () => {
          const expected = [...inputs];
          const final = await recordedClaudeEnd(file, transcriptOffset, expected);
          if (!final || expected.length !== inputs.length || expected.some((text, index) => text !== inputs[index]) || turnState.promptEnded || turnState.cancelled || activeTurns.get(threadId) !== turnState) return;
          // The record proves this prompt ended even if the adapter lost its live answer/result.
          turnState.promptEnded = true;
          turnState.toolsIdle.splice(0).forEach(resolve => resolve());
          acp.settleRecorded(sessionId, "_session/steering", { outcome: "injected" });
          await turnState.steers;
          turnState.flushUpdates();
          const known = lane.message?.text ?? items.filter(item => item.type === "agentMessage").at(-1)?.text ?? "";
          if (!known.endsWith(final.text)) lane.say({ type: "agentMessage", id: final.id ?? randomUUID(), text: final.text });
          acp.send({ method: "session/cancel", params: { sessionId } });
          acp.settleRecorded(sessionId, "session/prompt", { stopReason: "end_turn" });
          await done;
        })().catch(e => log(`turn recovery: ${e.message}`)).finally(() => { recovering = null; });
      };
      if (file && !followup) {
        try {
          await mkdir(dirname(file), { recursive: true });
          let timer;
          const watcher = watch(dirname(file), (_event, name) => {
            if (String(name) !== basename(file)) return;
            clearTimeout(timer);
            // Let ordinary ACP delivery finish first. No polling, and no watcher after the turn.
            timer = setTimeout(() => { void turnState.recover(); }, 250);
          });
          watcher.on("error", error => log(`turn record watcher: ${error.message}`));
          turnState.stopRecordWatch = () => { clearTimeout(timer); watcher.close(); };
        } catch (error) { log(`turn record watcher: ${error.message}`); }
      }
      const result = turnState.cancelled ? { stopReason: "cancelled" } : followup ? await turnState.followupEnded : await acp.call("session/prompt", { sessionId, prompt });
      clearTimeout(turnState.quiet);
      turnState.promptEnded = true;
      turnState.toolsIdle.splice(0).forEach(resolve => resolve());
      await turnState.steers;
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
      if (!followup) say("user", userText);
      for (const it of items) {
        if (it.type === "userMessage") { flush(); say("user", inputSummary(it.content)); }
        else if (it.type === "commandExecution") used.push(plainCommand(it.command));
        else if (it.type === "fileChange") used.push(`edited ${it.changes.map((c) => c.path).join(", ")}`);
        else if (it.type === "subAgentActivity" && it.kind === "started") used.push(`started the subagent "${it.agentPath}"`);
        else if (it.type === "agentMessage" && it.text.trim()) { flush(); say("assistant", it.text.trim()); }
      }
      flush();
      if (!compacting) {
        const mirror = engineCall("thread/inject_items", { threadId, items: record }, 5000)
          .then(() => log(`recorded Claude turn in thread ${threadId} (${record.length} items)`))
          .catch(e => {
            log(`record failed for ${threadId}: ${e.message ?? JSON.stringify(e)}`);
            notify("warning", { threadId, message: "The answer is saved, but its native history copy could not be confirmed." });
          }).finally(() => { if (pendingMirrors.get(threadId) === mirror) pendingMirrors.delete(threadId); });
        pendingMirrors.set(threadId, mirror);
      }
    } catch (e) {
      status = "failed";
      const dropped = connectionDropped(e) && !compacting;
      error = { message: dropped ? RECONNECT_NOTE : acpErrorMessage(e), codexErrorInfo: null, additionalDetails: null };
      log(`turn error ${JSON.stringify(e)}`);
      if (dropped) reconnects.set(threadId, setTimeout(() => {
        reconnects.delete(threadId);
        if (activeTurns.has(threadId) || deletedThreads.has(threadId) || !claudeModel.has(threadId)) return;
        void claudeTurn({ kind: "queued", params: { threadId, input: [{ type: "text", text: "The connection dropped before you could answer. Continue where you left off.", text_elements: [] }] } });
      }, RECONNECT_MS));
    }
    turnState.stopRecordWatch?.();
    sessionReady(null);
    // The ended turn answers for its sessions no more: a late approval from them is refused.
    for (const sid of [turnState.sessionId, ...subLanes.keys()]) {
      if (turnState.own && turnState.acp.bySession.get(sid) === turnState.own) turnState.acp.bySession.delete(sid);
    }
    if (agent.key === "claude" && turnState.sessionId) listenBetweenTurns(threadId, turnState.acp, turnState.sessionId);
    // A subagent or row still running when the turn ends (stop, error) must not spin forever.
    turnState.endSubagents?.();
    lane.end();
    if (req.kind === "review") {
      const exit = { type: "exitedReviewMode", id: randomUUID(), review: items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n\n").trim() };
      notify("item/started", { item: exit, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item: exit, threadId, turnId, completedAtMs: now() });
      items.push(exit);
    }
    cancelRelays(ws, threadId, turnId);
    turnState.toolsIdle.splice(0).forEach((r) => r());
    const completedAt = Math.floor(now() / 1000);
    {
      const record = clipTurn({ id: turnId, items: [...lead, ...items], itemsView: "full", status, error, startedAt, startedAtMs: t0, completedAt, durationMs: (completedAt - startedAt) * 1000, ...(lastClaudeMessageId && { claudeMessageId: lastClaudeMessageId }) });
      await updateStore((st) => {
        const { active, ...rest } = st[threadId] ?? {}, sessionId = sessions.get(threadId)?.id;
        const loaded = new Map((rest.contextSessionId === sessionId ? rest.contextFiles ?? [] : []).map(file => [file.path, file]));
        for (const item of record.items) if (item.status === 'completed') for (const action of item.commandActions ?? []) {
          if (action.type === 'read' && typeof action.path === 'string' && action.path.endsWith('/SKILL.md')) {
            let bytes = 0; try { bytes = statSync(action.path).size; } catch {}
            loaded.set(action.path, { name: basename(dirname(action.path)), path: action.path, group: 'skills', estimatedTokens: Math.ceil(bytes / 4), included: true, selectable: false, reason: 'Read by Claude in this session' });
          }
        }
        st[threadId] = { ...rest, turns: [...(rest.turns ?? []), record], contextSessionId: sessionId, contextFiles: [...loaded.values()] };
      });
    }
    if (activeTurns.get(threadId) === turnState) activeTurns.delete(threadId);
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
    notify("turn/activityUpdated", { threadId, turnId, status: status === "inProgress" ? "completed" : status, durationMs: now() - t0, timeToFirstTokenMs: firstTokenAt ? firstTokenAt - t0 : null });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    announceLimits(agent, notify);
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
    if (activeTurns.has(threadId) || deletingThreads.has(threadId) || deletedThreads.has(threadId)) return;
    const next = queueOf(threadId).shift();
    if (!next) return;
    if (!next.goal) notify("thread/queue/changed", { threadId });
    if (next.steer) {
      if (next.steer.cancelled) { runNext(threadId); return; }
      next.steer.phase = "dispatching";
      pendingSteers.get(threadId)?.delete(next.clientUserMessageId);
    }
    claudeTurn({ kind: next.goal ? "goal" : "queued", params: { threadId, input: next.input, clientUserMessageId: next.clientUserMessageId } }).then((r) => next.after?.(r));
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
    const helper = !!p.elpisParentThreadId;
    if (helper) {
      // Resolve this helper's shared default or deliberately requested task scope.
      const parentThreadId = p.elpisParentThreadId;
      const requested = p.elpisRequestedScope ?? ([':workspace', ':danger-full-access'].includes(p.permissions) || ["workspace-write", "danger-full-access"].includes(p.sandbox) ? "workspace-write" : "read-only");
      delete p.elpisRequestedScope;
      p.sandbox = { ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' }[p.permissions] ?? helperCeiling(requested);
      delete p.permissions;
      // A workflow's agent (WR2): linked to its run, so the lists fold it under the run.
      const run = p.elpisWorkflow && typeof p.elpisWorkflow.runId === "string" ? { workflowRunId: p.elpisWorkflow.runId, workflowAgentId: p.elpisWorkflow.agentId ?? null } : {};
      const d = { parentThreadId, model: p.model ?? null, sandbox: p.sandbox, requested, ceiling: p.sandbox, ...run };
      pendingDelegation.set(msg.id, d);
      pendingHelpers.add(d);
      // Automatic agents never put approval questions to the person. Their sandbox ceiling
      // still applies: a denied action fails instead of asking the parent chat.
      p.approvalPolicy = 'never';
      delete p.elpisParentThreadId;
    }
    delete p.elpisWorkflow;
    let pick = null;
    if (isBridged(p.model)) pick = { model: p.model, effort: p.config?.model_reasoning_effort ?? null };
    else {
      await storeChain;
      const def = (await loadStore())._default;
      engineDefault ??= engineCall("config/read", { includeLayers: false }).then((r) => r?.config?.model ?? null, () => null);
      // A saved Claude default waits while Elpis is signed out of it: the new chat gets the engine's own model.
      // A helper keeps the model its delegate named, even the engine's default (A49: gpt-6.1-sol helpers ran on Claude).
      if (!helper && def?.model && !signedOutModel(def.model) && (p.model == null || p.model === await engineDefault)) pick = def;
    }
    if (pick) {
      rememberStart(msg.id, pick);
      p.model = null;
      if (p.config) delete p.config.model_reasoning_effort;
    } else await withAgents(msg.params, helper);
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }

  // Esc-Esc "edit a previous message": revert drops a turn and every later one. Claude's turns
  // live in the bridge's store and Claude's own session, which the engine cannot see, so the
  // bridge drops them, gives Claude a fresh session seeded from the kept history, and has the
  // engine revert its own turns from the same point.
  async function forkClaudeAfter(threadId, entry, messageId) {
    const agent = agentOf(claudeModel.get(threadId));
    const saved = entry?.session;
    if (!messageId || !saved || agent?.key !== "claude" || (entry.agent ?? "claude") !== "claude"
      || (entry.claudeAccountId ?? "default") !== claudeAccounts.activeId()) return null;
    const acp = await ensureAcp(agent);
    const fork = { version: 1, messageId };
    const { sessionId } = await acp.call("session/fork", { sessionId: saved, cwd: threadCwd.get(threadId) ?? process.cwd(), mcpServers: [], _meta: { jetbrains: { air: { fork } } } });
    log(`rewind of ${threadId} forked Claude session ${saved} after ${messageId} -> ${sessionId}`);
    return sessionId ?? null;
  }
  async function revertThread(msg) {
    const { threadId, beforeTurnId } = msg.params ?? {};
    await storeChain;
    const entry = (await loadStoreSnapshot())[threadId];
    const stored = entry?.turns ?? [];
    if (!stored.length) { engine.stdin.write(JSON.stringify(msg) + "\n"); return; }
    try {
      const engineTurns = (await engineCall("thread/turns/list", { threadId, limit: 200, sortDirection: "asc", itemsView: "notLoaded" }).catch(() => ({ data: [] }))).data ?? [];
      const cutAt = (stored.find((t) => t.id === beforeTurnId) ?? engineTurns.find((t) => t.id === beforeTurnId))?.startedAt;
      if (cutAt == null) { engine.stdin.write(JSON.stringify(msg) + "\n"); return; }
      // A143: as Codex's rollback keeps the native history up to the cut, Claude keeps its own: its
      // session is forked after the last kept reply (fx and CloudRoom fork the same way), so the
      // next request resends the same prefix and the prompt cache still holds. A turn without a
      // recorded reply id (older chats) falls back to a fresh session seeded from the kept turns.
      // Saved turns start on whole seconds, so a stored turn is cut by its place, not its time.
      const at = stored.findIndex((t) => t.id === beforeTurnId);
      const kept = at >= 0 ? stored.slice(0, at) : stored.filter((t) => (t.startedAt ?? 0) < cutAt);
      const keptIds = new Set(kept.map((t) => t.id));
      const forked = await forkClaudeAfter(threadId, entry, kept.at(-1)?.claudeMessageId)
        .catch((e) => { log(`rewind fork failed, fresh session instead: ${e?.message ?? JSON.stringify(e)}`); return null; });
      await updateStore((st) => { const e = st[threadId] ?? {}; e.turns = (e.turns ?? []).filter((t) => keptIds.has(t.id)); delete e.sessions; if (forked) e.session = forked; else delete e.session; st[threadId] = e; });
      sessions.delete(threadId);
      const engineCut = engineTurns.find((t) => (t.startedAt ?? 0) >= cutAt);
      const result = engineCut
        ? await engineCall("thread/revert", { threadId, beforeTurnId: engineCut.id })
        : { thread: (await engineCall("thread/read", { threadId })).thread, turnsBackwardsCursor: null };
      log(`reverted thread ${threadId} before ${beforeTurnId} (${stored.length - kept.length} Claude turns dropped${engineCut ? ", engine reverted too" : ""})`);
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
  const structured = new BusyMap(); // hidden thread -> its Claude session
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
      refuseSignedOut(AGENTS[0]);
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
      error = { message: acpErrorMessage(e), codexErrorInfo: null, additionalDetails: null };
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
    if (!turn || turn.cancelled) return refuse();
    let waiting = pendingSteers.get(threadId);
    if (!waiting) pendingSteers.set(threadId, waiting = new Map());
    const prior = clientUserMessageId && waiting.get(clientUserMessageId);
    if (prior) { toTui({ id: msg.id, result: { turnId: prior.turnId } }); return; }
    const steer = { cancelled: false, phase: "waiting", turnId: turn.turnId };
    if (clientUserMessageId) waiting.set(clientUserMessageId, steer);
    // Acceptance leaves the message editable until actual ACP dispatch. Waiting for
    // tool completion before replying would block the TUI's cancellation request.
    toTui({ id: msg.id, result: { turnId: turn.turnId } });
    const queueForNextTurn = () => {
      if (turn.cancelled || steer.cancelled || deletedThreads.has(threadId) || deletingThreads.has(threadId)) return;
      steer.phase = "queued";
      queueOf(threadId).push({ id: randomUUID(), input, clientUserMessageId, steer });
      notify("thread/queue/changed", { threadId });
      runNext(threadId);
    };
    const deliver = async () => {
      const sessionId = await turn.ready;
      if (steer.cancelled) return;
      if (!sessionId || activeTurns.get(threadId) !== turn || turn.cancelled || turn.promptEnded) {
        queueForNextTurn();
        return;
      }
      try {
        const prompt = await toAcpPrompt(input);
        // An idle notification is only a wake-up: another tool can start in the
        // same transport read, or while attachments are prepared. Check again at
        // dispatch, with no asynchronous work between the check and the ACP call.
        while (!turn.promptEnded && !turn.cancelled && !steer.cancelled && turn.toolsBusy()) await turn.whenToolsIdle();
        if (steer.cancelled) return;
        if (activeTurns.get(threadId) !== turn || turn.cancelled || turn.promptEnded) { queueForNextTurn(); return; }
        steer.phase = "dispatching";
        turn.bufferedUpdates = [];
        const text = prompt.filter(block => block.type === "text").map(block => block.text).join("\n");
        turn.inputs?.push(text);
        const r = await turn.acp.call("_session/steering", { sessionId, prompt, _meta: { steering: { idleBehavior: "promptRequired" } } });
        if (r?.outcome === "promptRequired") { turn.inputs?.pop(); queueForNextTurn(); return; }
        waiting.delete(clientUserMessageId);
        if (r?._meta?.delivery === "nextTurn") {
          notify("warning", { threadId, message: "Gemini will read this message after its current reply finishes." });
        }
        turn.closeMessage();
        const item = { type: "userMessage", id: randomUUID(), clientId: clientUserMessageId, content: input };
        notify("item/started", { item, threadId, turnId: turn.turnId, startedAtMs: now() });
        notify("item/completed", { item, threadId, turnId: turn.turnId, completedAtMs: now() });
        turn.items.push(item);
        await updateStore(st => { if (st[threadId]?.active?.turnId === turn.turnId) { st[threadId].active.userItems.push(item); st[threadId].active.inputs = turn.inputs; } });
        addChars(threadId, "user", inputSummary(input).length);
        log(`steered Claude turn ${turn.turnId} (${r?.outcome ?? "ok"})`);
      } catch (e) {
        if (steer.phase === "dispatching") {
          steer.phase = "unconfirmed";
          notify("warning", { threadId, message: `Waiting message delivery is unconfirmed: ${e?.message ?? JSON.stringify(e)}. Reconnect before retrying it.` });
        } else {
          notify("warning", { threadId, message: `Could not prepare the waiting message: ${e?.message ?? JSON.stringify(e)}. Press Up to revise it.` });
        }
      } finally { turn.flushUpdates?.(); }
    };
    turn.steers = turn.steers.then(deliver);
    await turn.steers;
  }

  function cancelClaudeSteers(msg) {
    const { threadId, clientUserMessageIds = [] } = msg.params || {};
    if (!Array.isArray(clientUserMessageIds) || clientUserMessageIds.length > 100
      || clientUserMessageIds.some(id => typeof id !== "string" || id.length > 256)) {
      toTui({ id: msg.id, error: { code: -32600, message: "invalid clientUserMessageIds" } });
      return;
    }
    const cancelledClientUserMessageIds = cancelWaitingClaudeSteers(threadId, clientUserMessageIds);
    toTui({ id: msg.id, result: { cancelledClientUserMessageIds } });
  }

  function cancelWaitingClaudeSteers(threadId, clientUserMessageIds) {
    const cancelledClientUserMessageIds = [];
    const waiting = pendingSteers.get(threadId);
    for (const id of new Set(clientUserMessageIds)) {
      const steer = waiting?.get(id);
      if (!steer || !["waiting", "queued"].includes(steer.phase)) continue;
      steer.cancelled = true;
      waiting.delete(id);
      cancelledClientUserMessageIds.push(id);
    }
    const queue = queues.get(threadId);
    if (queue?.some(entry => entry.steer?.cancelled)) {
      queues.set(threadId, queue.filter(entry => !entry.steer?.cancelled));
      notify("thread/queue/changed", { threadId });
    }
    return cancelledClientUserMessageIds;
  }

  async function stopProvider(tid, action) {
    const running = activeTurns.get(tid);
    if (!running) return;
    running.cancelled = true;
    cancelWaitingClaudeSteers(tid, [...(pendingSteers.get(tid)?.keys() ?? [])]);
    let timer;
    try {
      const stopped = (async () => {
        const sessionId = await running.ready;
        if (sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId } });
        await running.done;
      })();
      await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The provider has not stopped yet; the chat was not ${action}.`)), 10000); })]);
    } finally { clearTimeout(timer); }
  }
  async function archiveProvider(msg) {
    const tid = msg.params.threadId;
    queueOf(tid).splice(0);
    try {
      await stopProvider(tid, "archived");
      engine.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) { pendingArchive.delete(msg.id); toTui({ id: msg.id, error: { code: -32603, message: e.message } }); }
  }
  async function deleteThread(msg) {
    const tid = msg.params.threadId;
    const ids = new Set([tid]);
    const acquired = new Set([tid]);
    deletingThreads.add(tid);
    try {
      let store;
      // Provider children are not all represented in the native spawn tree.
      const stopped = new Set();
      while (true) {
        await storeChain;
        store = await loadStore();
        let changed;
        do {
          changed = false;
          for (const [id, saved] of Object.entries(store)) {
            const parent = store._delegations?.[id]?.parentThreadId ?? saved?.parentThreadId ?? saved?.rootThreadId;
            if (!id.startsWith("_") && ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true; }
          }
          for (const [id, helper] of Object.entries(store._delegations ?? {})) {
            if (ids.has(helper.parentThreadId) && !ids.has(id)) { ids.add(id); changed = true; }
          }
          for (const c of contexts) for (const id of c.childrenOf(ids)) {
            if (!ids.has(id)) { ids.add(id); changed = true; }
          }
        } while (changed);
        for (const id of ids) if (!acquired.has(id)) {
          if (deletingThreads.has(id)) throw new Error("A child chat is already being deleted. Retry after it finishes.");
          deletingThreads.add(id); acquired.add(id);
        }
        if ([...pendingHelpers].some(helper => ids.has(helper.parentThreadId))) throw new Error("A helper is still starting. Retry deletion once it has started.");
        // Match the native store's refusal to erase history still used by a fork.
        if (Object.entries(store).some(([id, saved]) => !ids.has(id) && ids.has(saved?.forkOf?.threadId))) throw new Error(`cannot delete thread ${tid}: forked history still references it`);
        const next = [...ids].filter(id => !stopped.has(id));
        if (!next.length) break;
        await Promise.all([...contexts].flatMap(c => next.map(id => c.stopProvider(id))));
        next.forEach(id => stopped.add(id));
        // Cancellation can finish and persist a child that did not exist in the first snapshot.
      }
      // Validate/delete the root first so a native fork conflict cannot erase its helpers.
      for (const id of ids) {
        let nativeDeleted = true;
        try { await engineCall("thread/delete", { threadId: id }); }
        catch (e) {
          // Bridge-only children and retries after a persistence failure have no native row.
          if (!/thread not found|no rollout found/.test(e.message ?? "") || (id === tid && !store[id] && !store._delegations?.[id] && !deletedThreads.has(id))) throw e;
          nativeDeleted = false;
        }
        deletedThreads.add(id);
        for (const c of contexts) c.forgetThread(id);
        providerOwners.delete(id); chatAccess.delete(id); helperScope.delete(id); helperThreads.delete(id);
        if (!nativeDeleted) notify("thread/deleted", { threadId: id });
        for (const watched of subscriptions.values()) watched.delete(id);
      }
      if (!await updateStore(() => {})) throw new Error("The native chat was deleted, but bridge history could not be removed. Retry deletion.");
      toTui({ id: msg.id, result: {} });
    } catch (e) {
      // Persist cleanup even if native deletion stopped partway through a subtree.
      if ([...ids].some(id => deletedThreads.has(id))) await updateStore(() => {});
      toTui({ id: msg.id, error: Number.isInteger(e.code) ? e : { code: -32603, message: e.message ?? String(e) } });
    } finally { for (const id of acquired) deletingThreads.delete(id); }
  }
  const openingReplies = new Set();
  // WR6: a chat's workflow tool starts a run only inside a turn the person started whose own words asked for one.
  // A helper chat, a workflow's notice or Claude's reply to a background job never counts.
  async function personAskedIn(threadId) {
    const refuse = (why) => { throw Object.assign(new Error(why), { code: -32600 }); };
    await storeChain;
    const store = await loadStore();
    if (store._delegations?.[threadId] || store[threadId]?.parentThreadId) refuse("A helper chat cannot start a workflow; only a chat the person talks to can.");
    let texts = [], running = false;
    const provider = providerOwners.get(threadId)?.model() ?? claudeModel.get(threadId) ?? store[threadId]?.model;
    if (isBridged(provider)) {
      const active = store[threadId]?.active;
      running = Boolean(active) || activeTurns.has(threadId);
      texts = (active?.userItems ?? []).filter((item) => item.type === "userMessage").map((item) => textOf(item.content));
    } else {
      const turn = (await engineCall("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "full" }, 10_000))?.data?.[0];
      running = turn?.status === "inProgress";
      texts = (turn?.items ?? []).filter((item) => item.type === "userMessage").map((item) => textOf(item.content));
    }
    log(`workflow opt-in for ${threadId}: ${isBridged(provider) ? provider : "engine"} turn ${running ? "running" : "idle"}, ${texts.length} messages`);
    if (!running) refuse("Workflows start only during a message from the person.");
    if (!personAskedForWorkflow(texts)) refuse("The person did not ask for a workflow. Workflows run only when the person's own message asks for one (the keyword \"ultracode\", or words like \"use a workflow\"). Do the task without one, or ask them whether they want a workflow.");
    // Their "+500k"-style token target is the run's budget, as in the reference.
    const target = texts.join("\n").match(/(?:^|\s)\+(\d+(?:\.\d+)?)\s*([km])\b/i);
    return target ? Math.round(Number(target[1]) * (target[2].toLowerCase() === "m" ? 1e6 : 1e3)) : null;
  }
  // WR7: the protocol the app and the chats' workflow tool use.
  async function workflowRequest(msg) {
    const p = msg.params ?? {};
    const reply = (result) => toTui({ id: msg.id, result });
    const need = (key) => { if (typeof p[key] !== "string" || !p[key]) throw Object.assign(new Error(`${key} is required`), { code: -32602 }); return p[key]; };
    switch (msg.method) {
      case "workflowRun/start": {
        const threadId = need("threadId");
        const fromTool = workflowToolConns.has(ws);
        const budget = fromTool ? await personAskedIn(threadId) : (Number.isFinite(p.budget) ? p.budget : null);
        // Its agents run on the chat's own model and provider, in its folder (WR2).
        await storeChain;
        const store = await loadStore();
        let model = providerOwners.get(threadId)?.model() ?? claudeModel.get(threadId) ?? store[threadId]?.model ?? null, provider = null, effort = null;
        let cwd = threadCwd.get(threadId) ?? store[threadId]?.active?.cwd ?? store[threadId]?.cwd ?? null;
        if (isBridged(model)) effort = claudeEffort.get(threadId) ?? store[threadId]?.effort ?? null;
        else {
          const thread = (await engineCall("thread/read", { threadId, includeTurns: false }, 10_000).catch(() => null))?.thread;
          if (!thread) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: -32600 });
          model = thread.model ?? null; provider = thread.modelProvider ?? null; effort = thread.reasoningEffort ?? null; cwd ??= thread.cwd ?? null;
        }
        const started = await workflows.start({ script: p.script, scriptPath: p.scriptPath, args: p.args, resumeFromRunId: p.resumeFromRunId,
          parentThreadId: threadId, cwd: cwd ?? p.cwd ?? HOME, model, provider, effort, budget, origin: fromTool ? "chat" : "app" })
          .catch((e) => { throw Object.assign(e, { code: -32602 }); });
        log(`workflow ${started.runId} (${started.name}) started from ${fromTool ? "chat" : "the app"} ${threadId} on ${model ?? "the default model"}`);
        return reply(started);
      }
      case "workflowRun/list": return reply({ data: workflows.list({ parentThreadId: p.threadId }) });
      case "workflowRun/read": {
        const run = workflows.read(need("runId"));
        if (!run) throw Object.assign(new Error(`No workflow run ${p.runId}.`), { code: -32600 });
        return reply({ run });
      }
      case "workflowRun/stop": return reply({ run: await workflows.stop(need("runId")) });
      case "workflowRun/resume": return reply({ run: await workflows.resume(need("runId")) });
      case "workflowRun/skip": workflows.skip(need("runId"), need("agentId")); return reply({});
      default: throw Object.assign(new Error(`Unknown method ${msg.method}`), { code: -32601 });
    }
  }
  async function runWorkGraph(msg) {
    await storeChain;
    const tid = msg.params?.rootThreadId;
    const model = providerOwners.get(tid)?.model() ?? claudeModel.get(tid) ?? (await loadStore())[tid]?.model;
    if (typeof model === "string" && /^(claude|agy)\//.test(model)) {
      toTui({ id: msg.id, error: { code: -32600, message: "Workflows cannot run in Claude or Gemini subscription chats yet. Choose a conversation on a native provider; the subscription model must not be replaced by the engine's model." } });
      return;
    }
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }
  // Elpis's own sign-out of the Claude subscription, for the desktop's Settings (the terminal reads the
  // same file). `claudeSubscription/write` {signedOut} flips the switch; both answer {signedOut}.
  function claudeSubscriptionRequest(msg) {
    try {
      if (msg.method === "claudeSubscription/write") {
        setSignedOut(STATE_DIR, msg.params?.signedOut);
        log(`Claude subscription: Elpis is ${msg.params.signedOut ? "signed out" : "signed in"}`);
        recordAccounts().catch((e) => log(`accounts: ${e.message}`));
      }
      toTui({ id: msg.id, result: { signedOut: claudeSignedOut() } });
    } catch (e) { toTui({ id: msg.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: e.message ?? String(e) } }); }
  }
  async function claudeAccountsRequest(msg) {
    try {
      const params = msg.params ?? {};
      if (Object.keys(params).some(key => !["action", "id", "code"].includes(key))) throw Object.assign(new Error("Unsupported Claude account setting."), { code: -32602 });
      let extra = {};
      if (msg.method === "claudeAccounts/write") {
        if (params.action === "select") {
          if ([...contexts].some(context => context.claudeBusy())) throw Object.assign(new Error("Wait for the active Claude response to finish before switching accounts."), { code: -32600 });
          claudeAccounts.select(params.id); setSignedOut(STATE_DIR, false);
          await recordAccounts();
        } else if (params.action === "login") {
          const id = params.id ?? claudeAccounts.add().id;
          extra = await claudeAccounts.login(id);
        } else if (params.action === "code") {
          const login = claudeAccounts.logins.get(params.id);
          if (!login?.running || typeof params.code !== "string" || !/^[A-Za-z0-9_#.-]{1,4096}$/.test(params.code)) throw Object.assign(new Error("Enter the code from the Claude sign-in page."), { code: -32602 });
          login.child.stdin.write(`${params.code}\n`);
        } else throw Object.assign(new Error("Choose a Claude account action."), { code: -32602 });
      }
      toTui({ id: msg.id, result: { ...claudeAccounts.snapshot(), ...(extra.authUrl && { authUrl: extra.authUrl }) } });
    } catch (e) { toTui({ id: msg.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: e.message ?? String(e) } }); }
  }
  function handleMessage(data, recovered = false) {
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
    if (msg.method === "initialize" && msg.params?.clientInfo?.name === "elpis-workflow") workflowToolConns.add(ws);
    if (context.failed && msg.method && msg.id !== undefined) { toTui({ id: msg.id, error: { code: -32603, message: "The session backend disconnected; reopen this chat." } }); return; }
    const target = msg.params?.threadId ?? msg.params?.elpisParentThreadId;
    if (msg.method && (deletingThreads.has(target) || (deletedThreads.has(target) && msg.method !== "thread/delete"))) {
      toTui({ id: msg.id, error: { code: -32600, message: deletedThreads.has(target) ? `thread not found: ${target}` : "The chat is being deleted; wait for deletion to finish." } }); return;
    }
    if (typeof msg.method === "string" && msg.method.startsWith("workflowRun/")) {
      workflowRequest(msg).catch((e) => toTui({ id: msg.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: e.message ?? String(e) } }));
      return;
    }
    if (msg.method === "workGraph/run" || msg.method === "workGraph/runWithProviders") {
      runWorkGraph(msg).catch(e => toTui({ id: msg.id, error: Number.isInteger(e.code) ? e : { code: -32603, message: e.message ?? String(e) } }));
      return;
    }
    if (msg.method === "claudeSubscription/read" || msg.method === "claudeSubscription/write") { claudeSubscriptionRequest(msg); return; }
    if (msg.method === "claudeAccounts/read" || msg.method === "claudeAccounts/write") { void claudeAccountsRequest(msg); return; }
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
    if (msg.method && owner && owner.ws !== ws && (!owner.nativeHelper || ["thread/resume", "thread/read", "thread/turns/list", "thread/items/list", "thread/settings/update", "turn/start", "turn/steer", "turn/interrupt"].includes(msg.method))) {
      owner.dispatch(msg, ws); return;
    }
    if (pendingMirrors.has(msg.params?.threadId) && ["turn/start", "thread/settings/update", "thread/fork", "thread/revert", "thread/archive", "thread/delete"].includes(msg.method)) {
      pendingMirrors.get(msg.params.threadId).then(() => handleMessage(data, recovered));
      return;
    }
    if (!recovered && (claudeModel.has(msg.params?.threadId) || !threadSeen.has(msg.params?.threadId)) && ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list", "turn/steer"].includes(msg.method)) {
      recoverClaudeTurn(msg.params?.threadId).then(() => handleMessage(data, true), error => {
        log(`turn recovery: ${error.message}`);
        handleMessage(data, true);
      });
      return;
    }
    if (msg.method === "thread/delete") { deleteThread(msg); return; }
    if (["thread/start", "thread/fork", "thread/resume"].includes(msg.method)) {
      openingReplies.add(msg.id);
      const appMcp = appMcpConfig(msg.params?.config);
      if (appMcp && msg.method === "thread/resume") threadMcp.set(msg.params.threadId, appMcp);
      else if (appMcp) openingMcp.set(msg.id, appMcp);
    }
    if (process.env.ACP_BRIDGE_DEBUG && msg.method && (process.env.ACP_BRIDGE_DEBUG === "all" || !/^thread\/(read|turns\/list|list|loaded)/.test(msg.method))) log(`tui-> ${redactSecrets(line).slice(0, 600)}`);
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
    if (msg.method === "thread/read" && msg.params?.includeTurns) {
      (async () => {
        await storeChain;
        const historyStore = await loadStoreSnapshot();
        const tid = msg.params.threadId;
        if (historyStore[tid]?.providerHistory) {
          const result = await engineCall("thread/read", msg.params);
          const history = await providerHistory(tid, historyStore);
          result.thread.turns = history.turns;
          toTui({ id: msg.id, result });
        } else engine.stdin.write(JSON.stringify(msg) + "\n");
      })().catch(error => toTui({ id: msg.id, error: Number.isInteger(error.code) ? error : { code: -32603, message: error.message } }));
      return;
    }

    if (msg.method === "thread/loaded/list") pendingChildList.set(msg.id, null);
    if (msg.method === "thread/list" && msg.params?.ancestorThreadId && !msg.params.cursor) pendingChildList.set(msg.id, msg.params.ancestorThreadId);
    if (msg.method === "thread/list" || msg.method === "thread/read") pendingHelperMark.add(msg.id);
    if (msg.method === "model/list") pendingModelList.add(msg.id);
    if (msg.method === "thread/resume") { pendingResume.set(msg.id, msg.params?.threadId); resumeOptions.set(msg.id, msg.params ?? {}); resumeThread(msg); return; }
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
    if (msg.method === "thread/turns/list" || msg.method === "thread/items/list") {
      (async () => {
        await storeChain;
        const historyStore = await loadStoreSnapshot();
        const tid = msg.params?.threadId;
        if (claudeModel.has(tid) || (historyStore[tid]?.model || historyStore[tid]?.providerHistory) || (providerOwners.has(tid) && !providerOwners.get(tid).nativeHelper) || childIds.has(tid)) await listProviderHistory(msg, historyStore);
        else engine.stdin.write(JSON.stringify(msg) + "\n");
      })().catch(error => toTui({ id: msg.id, error: Number.isInteger(error.code) ? error : { code: -32603, message: error.message } }));
      return;
    }
    if (msg.method === "thread/turns/list" && msg.params?.threadId) pendingTurnsList.set(msg.id, msg.params);
    if (msg.method === "account/rateLimits/read") pendingLimitsRead.add(msg.id);
    if (msg.method === "thread/items/list" && msg.params?.threadId) pendingItemsList.set(msg.id, msg.params);
    const lp = msg.params ?? {};
    if (msg.method === "thread/list" && !lp.archived && lp.sortKey !== "section_position" && lp.sortDirection !== "asc"
      && lp.sectionId == null && lp.projectId == null && lp.parentThreadId == null && lp.ancestorThreadId == null) pendingThreadList.set(msg.id, lp);
    if (msg.method === "thread/settings/update") {
      const p = msg.params ?? {};
      if (ownHelpers.has(p.threadId) && !explicitChatChoices.has(p.threadId) && !permissionWrites.has(msg.id)) boundAccess(p, helperScope.get(p.threadId).ceiling, "sandboxPolicy");
      const choice = permissionWrites.get(msg.id);
      if (choice?.settings.permissions && choice.settings.permissions !== p.permissions) permissionWrites.delete(msg.id);
      if (isBridged(p.model)) { claudeModel.set(p.threadId, p.model); claimProvider(p.threadId); p.model = null; log(`thread ${p.threadId} -> ${claudeModel.get(p.threadId)}`); }
      else if (typeof p.model === "string") {
        if (activeTurns.has(p.threadId)) { toTui({ id: msg.id, error: { code: -32600, message: "Wait for the active provider turn to finish before switching this conversation to a native model." } }); return; }
        pendingNativeRoutes.set(msg.id, { threadId: p.threadId, model: p.model, effort: p.effort });
      }
      // Permissions become authoritative only on thread/settings/updated. A rejected or queued
      // request must never grant the bridge permission ahead of the engine.
      if (p.collaborationMode?.mode) {
        threadCollab.set(p.threadId, p.collaborationMode.mode);
        if (!pendingNativeRoutes.has(msg.id) && claudeModel.has(p.threadId) && p.collaborationMode.settings && !isBridged(p.collaborationMode.settings.model)) p.collaborationMode.settings.model = null;
      }
      if (!pendingNativeRoutes.has(msg.id) && p.effort && claudeModel.has(p.threadId)) {
        // Saved later in the store's queue, so it keeps its own copy: p.effort is cleared below for the engine.
        const effort = p.effort;
        claudeEffort.set(p.threadId, effort);
        updateStore((st) => { st[p.threadId] = { ...st[p.threadId], effort }; });
        // A running turn takes the new effort from its next request, not only from the next turn.
        const running = activeTurns.get(p.threadId);
        if (running?.acp && running.sessionId) running.acp.call("session/set_config_option", { sessionId: running.sessionId, configId: "effort", value: effort }).catch((e) => log(`effort ${effort}: ${e.message}`));
        p.effort = null;
      }
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
      const sendNativeTurn = () => {
        if (ownHelpers.has(tid) && msg.id !== undefined) pendingHelperTurns.set(msg.id, tid);
        engine.stdin.write(JSON.stringify(msg) + "\n");
      };
      if (ownHelpers.has(tid) && !explicitChatChoices.has(tid)) boundAccess(msg.params, helperScope.get(tid).ceiling, "sandboxPolicy");
      if (msg.params?.collaborationMode?.mode) threadCollab.set(tid, msg.params.collaborationMode.mode);
      // Its permission fields are the TUI's unconfirmed choice: a Claude turn ignores them (see
      // claudeTurn), and the engine reports what it accepts for its own turn in
      // thread/settings/updated.
      const requestedNative = typeof msg.params?.model === "string" && !isBridged(msg.params.model);
      if (requestedNative && activeTurns.has(tid)) { toTui({ id: msg.id, error: { code: -32600, message: "Wait for the active provider turn to finish before switching this conversation to a native model." } }); return; }
      if (requestedNative) {
        const go = () => {
          pendingNativeRoutes.set(msg.id, { threadId: tid, model: msg.params.model, effort: msg.params.effort });
          sendNativeTurn();
        };
        const own = ownHelpers.get(tid);
        if (own && (own.applying || own.failed)) {
          own.waiting ??= new Set(); own.waiting.add(msg.id);
          enforceHelper(tid).then(ok => {
            const pending = own.waiting.delete(msg.id);
            if (!pending) return;
            if (ok && !context.failed) go();
            else toTui({ id: msg.id, error: { code: -32600, message: "The next turn was not started: its chat's restricted permissions could not be applied." } });
          });
        } else go();
        return;
      }
      // A turn on a subscription Elpis is signed out of is refused before anything changes (hidden title
      // and recap requests are refused in structuredClaude, and queued, goal, compact and review turns in claudeTurn).
      if (!String(msg.id).startsWith("temporary-structured-turn") && signedOutModel(isBridged(msg.params?.model) ? msg.params.model : claudeModel.get(tid))) {
        toTui({ id: msg.id, error: { code: -32600, message: SIGNED_OUT_MESSAGE } }); return;
      }
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
        (own.applying ?? enforceHelper(tid)).then((ok) => { if (ok) sendNativeTurn(); });
        return;
      }
      sendNativeTurn();
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
    if (/^thread\/contextFiles\/(list|set)$/.test(msg.method) && claudeModel.has(msg.params?.threadId)) { void providerContextFiles(msg); return; }
    if (/^thread\/queue\//.test(msg.method) && claudeModel.has(msg.params?.threadId)) { queueRequest(msg); return; }
    if (msg.method === "turn/interrupt" && activeTurns.has(msg.params?.threadId)) {
      const running = activeTurns.get(msg.params.threadId);
      running.cancelled = true;
      running.endFollowup?.({ stopReason: "cancelled" });
      cancelWaitingClaudeSteers(msg.params.threadId, [...(pendingSteers.get(msg.params.threadId)?.keys() ?? [])]);
      if (running.sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId: running.sessionId } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === "turn/steer" && claudeModel.has(msg.params?.threadId)) {
      steerClaude(msg);
      return;
    }
    if (msg.method === "turn/steer/cancel" && claudeModel.has(msg.params?.threadId)) {
      cancelClaudeSteers(msg);
      return;
    }
    engine.stdin.write(line + "\n");
    // Stopping a helper also ends the commands it left running, which would otherwise finish its work.
    if (msg.method === "turn/interrupt" && owner?.nativeHelper && owner.ws === ws) engineCall("thread/backgroundTerminals/clean", { threadId: msg.params.threadId }).catch(() => {});
  }
  const engineExited = () => {
    if (context.failed || engine.closing) return;
    context.failed = true;
    const error = { code: -32603, message: "The session backend disconnected. Reopen Elpis to continue this chat." };
    for (const request of engineReqs.values()) request.reject(error);
    engineReqs.clear(); pendingHelperTurns.clear(); engineTurns.clear();
    for (const [key, start] of startingProviders) if (key.startsWith(`${connectionId}:`)) { start.resolve(); startingProviders.delete(key); }
    for (const id of new Set([...pendingStart.keys(), ...pendingResume.keys(), ...openingReplies])) toTui({ id, error });
    pendingStart.clear(); pendingResume.clear(); resumeOptions.clear(); pendingNativeRoutes.clear(); openingReplies.clear();
    for (const [id, route] of forwarded) if (route.owner === ws) { forwarded.delete(id); sendClient(route.client, { id: route.id, error }); }
    for (const [tid, owner] of providerOwners) if (owner.ws === ws) for (const client of viewers(tid)) client.close(1011, "Session backend disconnected");
    context.close(); ws.close(1011, "Session backend disconnected"); checkIdle();
  };
  engine.stdout.on("exit", engineExited);
  engine.once?.("exit", engineExited);
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(String(data)); } catch {}
    noteRequest(msg);
    if (!handover.take(msg)) void withPermissions(data);
  });
  ws.on("close", async () => {
    handover.close();
    clients.delete(ws); subscriptions.delete(ws);
    for (const relay of relayed.values()) relay.clients.delete(ws);
    for (const [id, route] of forwarded) if (route.client === ws) forwarded.delete(id);
    // Claude replaces its MCP process when it reloads a session. Its helper runtimes belong
    // to the bridge: releaseIfUnused keeps active turns, approvals and new subscribers alive.
    if (context.failed || (!process.env.ELPIS_SHARED_BRIDGE && !helperConns.has(ws))) {
      releaseHelpers();
      for (const d of [...pendingDelegation.values(), ...pendingAdopt.values()]) pendingHelpers.delete(d);
      await storeChain; context.close(); contexts.delete(context);
      for (const [tid, owner] of providerOwners) if (owner.ws === ws) providerOwners.delete(tid);
    }
    checkIdle(); log("tui disconnected");
  });
});
