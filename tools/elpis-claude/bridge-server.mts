import type { AskForApproval } from '../../codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts';
import { createHostLifecycle } from './bridge-host-lifecycle.mts';
import { createProviderCatalog } from './bridge-provider-catalog.mts';
import { attachBridgeConnection } from "./bridge-connection.mts";
import { createBridgeStore } from "./bridge-store.mts";
import { wireObject } from "./bridge-wire.mts";
import { writeJson } from "./bridge-json.mts";
import type { RequestId, BridgeClient, BridgeMessage, HelperScope, ProviderOwner, RelayReply, Relay, BridgeContext, McpConfig, SavedHelper, EngineThread, Ceiling } from "./bridge-types.mts";
// Elpis TUI <-ws-> bridge <-stdio-> real `elpis app-server` (everything else)
//                         \-stdio-> claude-agent-acp (chat turns -> Claude)
import { createBridgeServer, bridgeUrl } from "./shared-runtime.mts";

import { ClaudeAccounts } from "./claude-accounts.mts";
import { WorkflowRunner, noticeText } from "./workflow-runner.mts";
import { bridgeExecutor } from "./workflow-agents.mts";
import { connectAppServer } from "./app-server-connection.mts";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendLog } from "./log-redaction.mts";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PermissionChoices } from './permission-choices.mts';

const HOME = process.env.HOME as string;
const permissionChoices = new PermissionChoices(process.env.ELPIS_HOME || join(HOME, '.elpis-next'));
const LOG = process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/bridge.log";
let logFailureReported = false;
const log = (s: string) => {
  try { appendLog(LOG, s); }
  catch (error) {
    if (logFailureReported) return;
    logFailureReported = true;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const detail = typeof code === "string" ? ` (${code})` : "";
    process.stderr.write(`[acp-bridge] could not write bridge log${detail}\n`);
  }
};
const ADAPTER = process.env.ACP_ADAPTER ?? new URL("./context-agent.mts", import.meta.url).pathname;
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
const AGENTS_MCP = new URL("./elpis-agents-mcp.mts", import.meta.url).pathname;
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
const mcpServersFor = (subagents: boolean, parentThreadId: string | null, memoryCwd: string | null, workflow = false) => {
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
const appMcpConfig = (config: Record<string, unknown> | null | undefined) => {
  const entries: McpConfig = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!key.startsWith("mcp_servers.") || key === "mcp_servers.elpis-agents" || !wireObject(value)
      || typeof value.command !== "string" || (value.args !== undefined && !Array.isArray(value.args))
      || (value.env !== undefined && !wireObject(value.env))) continue;
    entries[key] = { ...value, command: value.command, ...(Array.isArray(value.args) ? { args: value.args } : {}), ...(wireObject(value.env) ? { env: value.env } : {}) };
  }
  return Object.keys(entries).length ? entries : null;
};
const acpServersFrom = (config: McpConfig | null | undefined, threadId: string) => Object.entries(config ?? {}).map(([key, s]) => ({
  name: key.slice("mcp_servers.".length), command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [],
  env: [...Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value: String(value) })), { name: "ELPIS_THREAD_ID", value: threadId }],
}));
const ELPIS_HOME = process.env.ELPIS_HOME || `${HOME}/.elpis-next`;
const STORE = process.env.ACP_BRIDGE_STORE ?? `${ELPIS_HOME}/elpis-claude/sessions.json`;
const deletingThreads = new Set<string>();
const archivingThreads = new Set<string>();
const deletedThreads = new Set<string>();
const { loadStore, loadStoreSnapshot, updateStore, storeChain } = createBridgeStore(STORE, deletedThreads, log);
const STATE_DIR = STORE.slice(0, STORE.lastIndexOf("/"));
const claudeAccounts = new ClaudeAccounts({ home: HOME, dir: STATE_DIR, defaultConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), claudeBin: process.env.CLAUDE_CODE_EXECUTABLE ?? join(HOME, ".local/bin/claude") });
const { AGENTS, agentOf, signedOutModel, refuseSignedOut, acpErrorMessage, RECONNECT_MS, connectionDropped, RECONNECT_NOTE, readJson, nameModel, announceLimits, addSubscriptionLimits, claudeSignedOut } = createProviderCatalog({ HOME, STATE_DIR, CLAUDE, ADAPTER, claudeAccounts, log });

// Smart Prune for Claude chats: the proxy `elpis claude` runs (`elpis claude --serve`), started
// once and shared. It shrinks large tool results before Anthropic sees them; a Claude chat's
// requests go through it while that chat's Smart Prune switch is on.
let pruneProxy: Promise<string | null> | null = null;
function smartPruneProxy() {
  pruneProxy ??= new Promise<string | null>((resolve) => {
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
  const out: Record<string, { email: string; plan?: string | null }> = {};
  const { email, plan } = claudeAccounts.account();
  if (email && !claudeSignedOut()) out.claude = { email, plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null };
  const agyLog = await readFile(`${HOME}/.gemini/antigravity-cli/cli.log`, "utf8").catch(() => "");
  const agyEmail = [...agyLog.matchAll(/authenticated successfully as (\S+)/g)].at(-1)?.[1];
  if (agyEmail) out.agy = { email: agyEmail };
  await writeJson(ACCOUNTS, out);
}
recordAccounts().catch((e) => log(`accounts: ${e.message}`));

const wss = createBridgeServer();
wss.on("listening", () => { const address = wss.address() as import("node:net").AddressInfo | string; log(`LISTENING ${typeof address === "string" ? address : address.port}`); checkIdle(); });

// A helper runs on its delegate tool's own connection, so the TUIs hear of it only through the
// bridge: its start (with its parent) and its status changes go to every other connection.
const clients = new Set<BridgeClient>();
const helperThreads = new Set<string>();
// A helper asks the user like its chat: its approval requests go from the delegate tool's
// connection to a TUI's, and the answer comes back. The delegate tool names itself
// "elpis-agents" in initialize; every other connection is a TUI.
const helperConns = new WeakSet<BridgeClient>();
const workflowToolConns = new WeakSet<BridgeClient>(); // a chat's workflow tool: its launches need the person's request (WR6)
const relayed = new Map<RequestId, Relay>(); // id sent to the TUI -> answers the helper's request
const chatAccess = new Map<string, { policy: AskForApproval | undefined; profile: string | undefined }>(); // confirmed approval policy and profile for automatic tool decisions
const TOOL_APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const automaticThreads = new Set<string>(), blockedAutomaticThreads = new Set<string>();
const explicitChatChoices = new Set<string>();
// Automatic helpers follow the shared default. An explicitly requested read-only
// delegate scope remains scoped; a user choice for the helper itself wins. The
// connections that hold a helper apply changes together, including private engines.
const helperScope = new Map<string, HelperScope>(); // helper thread id -> { parentThreadId, requested, ceiling, owners }
const pendingHelpers = new Set<{ parentThreadId: string }>(); // a parent cannot be deleted while one of its helpers is starting
const AUTHORITY = { plan: 0, default: 0, acceptEdits: 1, auto: 2, bypassPermissions: 3 };
// Elpis's built-in profiles with no sandbox: Full Access and Bypass permissions (the engine's
// `:bypass-permissions`, which also lifts its own refusals).
const UNSANDBOXED = [":danger-full-access", ":bypass-permissions"];
const fullFor = (threadId: string) => UNSANDBOXED.includes(chatAccess.get(threadId)?.profile as string) && (explicitChatChoices.has(threadId) || [undefined, "danger-full-access"].includes(helperScope.get(threadId)?.ceiling));
// A helper's own choice and the shared default determine its access, independently
// of a permission choice for the parent chat. Automatic access never selects Bypass.
const CEILINGS: Ceiling[] = ["read-only", "workspace-write", "danger-full-access"];
const lowest = (...ceilings: [Ceiling, ...Ceiling[]]) => CEILINGS[Math.min(...ceilings.map((c) => Math.max(0, CEILINGS.indexOf(c))))] as Ceiling;
const helperCeiling = (requested: string) => requested === 'workspace-write' ? 'danger-full-access' : 'read-only';
// Explicit delegate scopes stay bounded; automatic writers are reconciled with the
// current default before reopening or taking another turn.
const ceilingOf = (threadId: string, d: SavedHelper) => explicitChatChoices.has(threadId) ? 'danger-full-access' : lowest(d.ceiling ?? 'read-only', helperScope.get(threadId)?.ceiling ?? "danger-full-access", helperCeiling(d.requested ?? 'read-only'));
// Provider turns live in this bridge, while native turns live in the shared engine.
// A provider thread has one runtime owner. Other terminals subscribe to that runtime;
// their requests and replies keep their own ids, including when both clients use id 1.
const providerOwners = new Map<string, ProviderOwner>();
const subscriptions = new Map<BridgeClient, Set<string>>(); // physical client -> threads it opened
// A completed callback may be the last thing keeping a detached context alive. Defer the
// check until its current cleanup (including any new queued work) has finished.
class BusyMap<K, V> extends Map<K, V> {
  override delete(key: K) { const changed = super.delete(key); if (changed) queueMicrotask(checkIdle); return changed; }
  override clear() { const changed = this.size; super.clear(); if (changed) queueMicrotask(checkIdle); }
}
const forwarded = new BusyMap<RequestId, { client: BridgeClient; id: RequestId; owner: BridgeClient }>(); // bridge id -> original client and request id
const startingProviders = new Map<string, { ready: Promise<void>; resolve: () => void }>(); // start response must name the model before its notification
const contexts = new Set<BridgeContext>();
const sendClient = (client: BridgeClient, msg: object) => { if (client.readyState === 1) client.sendWire(JSON.stringify(msg)); };
const viewers = (threadId: string | undefined, includeHelpers = false) => [...clients].filter((c) => c.readyState === 1 && (includeHelpers || !helperConns.has(c)) && subscriptions.get(c)?.has(threadId as string));
function relayToTui(msg: BridgeMessage, answer: (reply: RelayReply) => void, origin: BridgeClient, toolPermission = false) {
  let threadId = msg.params?.threadId;
  while (helperScope.get(threadId as string)?.parentThreadId) threadId = (helperScope.get(threadId as string) as HelperScope).parentThreadId;
  if (!threadId) return false;
  const watching = new Set(viewers(threadId));
  const pending = msg.id !== undefined && [...relayed.values()].find(relay => relay.origin === origin && relay.upstreamId === msg.id && relay.message.method === msg.method);
  if (pending) {
    for (const client of watching) { pending.clients.add(client); sendClient(client, pending.message); }
    return true;
  }
  const id = `relay-${randomUUID()}`;
  relayed.set(id, { answer, origin, upstreamId: msg.id, toolPermission, clients: watching, message: { ...msg, id } as Relay["message"], threadId });
  for (const client of watching) sendClient(client, { ...msg, id });
  return true;
}
function settleRelay(id: RequestId, reply?: RelayReply) {
  const relay = relayed.get(id);
  if (!relay) return;
  relayed.delete(id);
  for (const client of relay.clients) sendClient(client, { method: 'serverRequest/resolved', params: { threadId: relay.message.params.threadId, requestId: id } });
  if (reply !== undefined) relay.answer(reply);
}
function cancelRelays(origin: BridgeClient, threadId?: string, turnId?: string) {
  for (const [id, relay] of relayed) {
    if (relay.origin !== origin || (threadId && relay.message.params?.threadId !== threadId) || (turnId && relay.message.params?.turnId !== turnId)) continue;
    settleRelay(id, { error: { code: -32603, message: "The requesting turn ended." } });
  }
}
function flushApprovals(client: BridgeClient, threadId: string) {
  if (helperConns.has(client) || !subscriptions.get(client)?.has(threadId)) return;
  for (const relay of relayed.values()) if (relay.threadId === threadId && !relay.clients.has(client)) {
    relay.clients.add(client); sendClient(client, relay.message);
  }
}
function decorateThread(thread: { id?: string } | null | undefined) {
  if (!thread?.id) return;
  providerOwners.get(thread.id)?.decorate(thread as EngineThread);
}
const runtime = createHostLifecycle({ HOME, wss, clients, contexts, helperConns, sendClient, storeChain, log, workflows: () => workflows, noticesDue: () => noticesDue.size });
const { checkIdle, clearIdle, startDrain } = runtime;

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
const noticesDue = new Set<string>();
const errorText = (e: unknown) => (e as { message?: string } | null | undefined)?.message ?? JSON.stringify(e);
async function deliverNotice(run: NonNullable<ReturnType<WorkflowRunner["pending"]>>) {
  if (!run.parentThreadId || run.notice?.state !== "pending" || noticesDue.has(run.id) || runtime.stopping) return;
  noticesDue.add(run.id);
  const threadId = run.parentThreadId;
  const later = (why: string) => { workflows.markNotice(run.id, { state: "pending", waiting: why }); log(`workflow ${run.id}: notice waits until chat ${threadId} is back (${why})`); };
  let conn: ReturnType<typeof connectAppServer> | null = null;
  try {
    while (!runtime.stopping) {
      if (!conn || conn.closed) {
        conn = connectAppServer({ url: bridgeUrl(wss), name: "elpis-workflow-runner" });
        await conn.ready;
        const refused = await conn.call("thread/resume", { threadId }).then(() => null, (e) => e);
        if (refused && /is archived/i.test(String(errorText(refused)))) return later("archived");
        if (refused && /not found/i.test(String(errorText(refused)))) { workflows.markNotice(run.id, { state: "undeliverable", why: "the chat was deleted" }); return; }
        if (refused) log(`workflow ${run.id}: notice: reopen ${threadId}: ${errorText(refused)}`);
      }
      const read = await conn.call("thread/read", { threadId, includeTurns: false }).catch((e) => ({ error: e }));
      if ("thread" in read && read.thread?.status?.type === "active") { await new Promise((r) => setTimeout(r, 2000)); continue; }
      const connection = conn;
      let answered: Parameters<typeof connection.listeners.add>[0] | undefined;
      const done = new Promise<void>((resolve) => { answered = (m) => { if (m.method === "turn/completed" && (m.params as { threadId?: string } | undefined)?.threadId === threadId) resolve(); }; connection.listeners.add(answered); });
      try {
        const started = await conn.call("turn/start", { threadId, input: [{ type: "text", text: noticeText(run), text_elements: [] }] });
        workflows.markNotice(run.id, { state: "delivered", waiting: null, turnId: started?.turn?.id ?? null, at: now() });
        log(`workflow ${run.id}: notice delivered to ${threadId}`);
      } catch (e) {
        if (answered) conn.listeners.delete(answered);
        log(`workflow ${run.id}: notice to ${threadId} waits: ${errorText(e)}`);
        // Reopened next time, so a chat archived or deleted meanwhile is told apart from a busy one.
        if (/not found|is archived/i.test(String(errorText(e)))) { conn.close(); conn = null; }
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
function chatBack(threadId: string) {
  for (const summary of workflows.list({ parentThreadId: threadId })) if (summary.notice === "pending") { const run = workflows.pending(summary.id); if (run) void deliverNotice(run); }
}
workflows.on("ended", (run) => { void deliverNotice(run); });
// After a restart, and while a handed-over runtime lets its runs go: runs nobody owns continue here.
const recoverWorkflows = () => { if (!runtime.stopping && !runtime.draining) { try { workflows.recover(); } catch (e) { log(`workflow recovery: ${(e as Error).message}`); } } };
wss.on("listening", recoverWorkflows);
setInterval(recoverWorkflows, 5000).unref();
// A newer installation that joined this bridge left its bridge's path here (shared-runtime.mts). This bridge starts
// that one and hands it every connection (startDrain); the open terminals and the desktop app reconnect to it.
const successorFile = process.env.ELPIS_SHARED_BRIDGE && process.env.ELPIS_BRIDGE_SOCKET && join(dirname(process.env.ELPIS_BRIDGE_SOCKET), "successor");
if (successorFile) setInterval(() => {
  if (runtime.stopping || runtime.draining) return;
  let successor; try { successor = readFileSync(successorFile, "utf8").trim(); } catch { return; }
  if (successor) void startDrain(successor);
}, 2000).unref();
export type BridgeEnvironment = {
  HOME: typeof HOME;
  permissionChoices: typeof permissionChoices;
  log: typeof log;
  now: typeof now;
  REVIEW_RULES: typeof REVIEW_RULES;
  REVIEW_FORMAT: typeof REVIEW_FORMAT;
  STRUCTURED_MODEL: typeof STRUCTURED_MODEL;
  STRUCTURED_SYSTEM: typeof STRUCTURED_SYSTEM;
  SUBAGENT_TOOLS: typeof SUBAGENT_TOOLS;
  SUBAGENTS_DISABLED: typeof SUBAGENTS_DISABLED;
  AUTONOMOUS_ORIGINS: typeof AUTONOMOUS_ORIGINS;
  REPLY_UPDATES: typeof REPLY_UPDATES;
  engineAgentsConfig: typeof engineAgentsConfig;
  mcpServersFor: typeof mcpServersFor;
  appMcpConfig: typeof appMcpConfig;
  acpServersFrom: typeof acpServersFrom;
  deletingThreads: typeof deletingThreads;
  archivingThreads: typeof archivingThreads;
  deletedThreads: typeof deletedThreads;
  loadStore: typeof loadStore;
  loadStoreSnapshot: typeof loadStoreSnapshot;
  updateStore: typeof updateStore;
  storeChain: typeof storeChain;
  STATE_DIR: typeof STATE_DIR;
  claudeAccounts: typeof claudeAccounts;
  claudeSignedOut: typeof claudeSignedOut;
  AGENTS: typeof AGENTS;
  agentOf: typeof agentOf;
  signedOutModel: typeof signedOutModel;
  refuseSignedOut: typeof refuseSignedOut;
  acpErrorMessage: typeof acpErrorMessage;
  RECONNECT_MS: typeof RECONNECT_MS;
  connectionDropped: typeof connectionDropped;
  RECONNECT_NOTE: typeof RECONNECT_NOTE;
  readJson: typeof readJson;
  nameModel: typeof nameModel;
  announceLimits: typeof announceLimits;
  addSubscriptionLimits: typeof addSubscriptionLimits;
  smartPruneProxy: typeof smartPruneProxy;
  recordAccounts: typeof recordAccounts;
  clients: typeof clients;
  helperThreads: typeof helperThreads;
  helperConns: typeof helperConns;
  workflowToolConns: typeof workflowToolConns;
  relayed: typeof relayed;
  chatAccess: typeof chatAccess;
  TOOL_APPROVALS: typeof TOOL_APPROVALS;
  automaticThreads: typeof automaticThreads;
  blockedAutomaticThreads: typeof blockedAutomaticThreads;
  explicitChatChoices: typeof explicitChatChoices;
  helperScope: typeof helperScope;
  pendingHelpers: typeof pendingHelpers;
  AUTHORITY: typeof AUTHORITY;
  UNSANDBOXED: typeof UNSANDBOXED;
  fullFor: typeof fullFor;
  lowest: typeof lowest;
  helperCeiling: typeof helperCeiling;
  ceilingOf: typeof ceilingOf;
  providerOwners: typeof providerOwners;
  subscriptions: typeof subscriptions;
  BusyMap: typeof BusyMap;
  forwarded: typeof forwarded;
  startingProviders: typeof startingProviders;
  contexts: typeof contexts;
  sendClient: typeof sendClient;
  viewers: typeof viewers;
  relayToTui: typeof relayToTui;
  settleRelay: typeof settleRelay;
  cancelRelays: typeof cancelRelays;
  flushApprovals: typeof flushApprovals;
  decorateThread: typeof decorateThread;
  stopping: boolean;
  checkIdle: typeof checkIdle;
  workflows: typeof workflows;
  chatBack: typeof chatBack;
  clearIdle: typeof clearIdle;
};

export function startBridge() {
  wss.on("connection", socket => attachBridgeConnection(socket, {
    HOME, permissionChoices, log, now, REVIEW_RULES, REVIEW_FORMAT, STRUCTURED_MODEL, STRUCTURED_SYSTEM, SUBAGENT_TOOLS, SUBAGENTS_DISABLED, AUTONOMOUS_ORIGINS, REPLY_UPDATES, engineAgentsConfig, mcpServersFor, appMcpConfig, acpServersFrom, deletingThreads, archivingThreads, deletedThreads, loadStore, loadStoreSnapshot, updateStore, storeChain, STATE_DIR, claudeAccounts, claudeSignedOut, AGENTS, agentOf, signedOutModel, refuseSignedOut, acpErrorMessage, RECONNECT_MS, connectionDropped, RECONNECT_NOTE, readJson, nameModel, announceLimits, addSubscriptionLimits, smartPruneProxy, recordAccounts, clients, helperThreads, helperConns, workflowToolConns, relayed, chatAccess, TOOL_APPROVALS, automaticThreads, blockedAutomaticThreads, explicitChatChoices, helperScope, pendingHelpers, AUTHORITY, UNSANDBOXED, fullFor, lowest, helperCeiling, ceilingOf, providerOwners, subscriptions, BusyMap, forwarded, startingProviders, contexts, sendClient, viewers, relayToTui, settleRelay, cancelRelays, flushApprovals, decorateThread, stopping: runtime.stopping, checkIdle, workflows, chatBack, clearIdle
  }));
}
