// MCP server the bridge gives Claude: hand a task to a helper agent on any model Elpis runs (GPT on
// the OpenAI sign-in, Gemini on the Antigravity sign-in, Claude on the subscription), then follow
// it up, steer it mid-turn or stop it. list_models says what each model is for. Each helper is a
// normal Elpis thread, so it appears in Elpis history (`elpis resume <thread id>` opens it).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import WebSocket from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.ELPIS_AGENTS_LOG ?? "/tmp/acp-bridge/elpis-agents.log";
const log = (s) => { try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${s}\n`); } catch {} };
const ENGINE = process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;

// Set by the bridge: helpers start through it, so any model it serves can be one, and each
// records the chat that started it. Without a bridge, helpers run on the Elpis engine alone.
const BRIDGE = process.env.ELPIS_BRIDGE_URL;
const PARENT = process.env.ELPIS_PARENT_THREAD ?? null;
const bridgedModel = (m) => /^(claude|agy)\//.test(m ?? "");

// One app-server connection, to the bridge (WebSocket) or the engine (stdio). A helper never asks
// for approval: there is nobody to answer, so every request is declined.
function connect() {
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  let send, close, opened;
  const onMessage = (m) => {
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); return; }
    if (m.id !== undefined && m.method) send({ id: m.id, result: { decision: "decline" } });
    for (const l of listeners) l(m);
  };
  if (BRIDGE) {
    const ws = new WebSocket(BRIDGE);
    opened = new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.on("message", (d) => onMessage(JSON.parse(d.toString())));
    send = (o) => ws.send(JSON.stringify(o));
    close = () => ws.close();
  } else {
    const proc = spawn(ENGINE, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onMessage(JSON.parse(line)); }
    });
    send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    close = () => proc.kill();
    opened = Promise.resolve();
  }
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `agents-${++seq}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const ready = opened
    .then(() => call("initialize", { clientInfo: { name: "elpis-agents", title: null, version: "0.3.0" }, capabilities: { experimentalApi: true } }))
    .then(() => send({ method: "initialized" }));
  return { call, listeners, ready, close };
}

// What each model is for, grouped by where it runs, from the app server's own model list.
let catalogConn = null;
async function modelCatalog() {
  catalogConn ??= connect();
  await catalogConn.ready;
  const list = (await catalogConn.call("model/list", { cursor: null, limit: null, includeHidden: false }))?.data ?? [];
  const groups = [
    ["Elpis engine (your OpenAI sign-in; provider openai)", (m) => !bridgedModel(m.id)],
    ["Antigravity (your Google sign-in)", (m) => m.id.startsWith("agy/")],
    ["Claude subscription", (m) => m.id.startsWith("claude/")],
  ];
  const lines = [];
  for (const [title, has] of groups) {
    const ms = list.filter(has);
    if (!ms.length) continue;
    lines.push(`${title}:`);
    for (const m of ms) {
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e) => e !== "default");
      lines.push(`  ${m.id}: ${m.description ?? m.displayName}${efforts.length ? ` (effort ${efforts.join("/")})` : ""}`);
    }
  }
  return lines.join("\n") || "No models listed.";
}

const server = new McpServer({ name: "elpis-agents", version: "0.3.0" });

// One entry per delegated thread this server has run: its active turn and what it produced.
const runs = new Map();

function report(threadId) {
  const run = runs.get(threadId);
  return [
    `Agent: ${run.label} (Elpis thread ${threadId}), status: ${run.status}`,
    run.commands.length ? `Commands it ran: ${run.commands.join("; ")}` : "Commands it ran: none",
    run.error ? `Error: ${run.error.message ?? JSON.stringify(run.error)}` : "",
    "Answer:",
    run.text.trim() || (run.status === "running" ? "(still working)" : "(no answer)"),
  ].filter(Boolean).join("\n");
}

// Start a turn on a thread and resolve when it ends; `run` collects its output meanwhile.
function startTurn(threadId, task) {
  const run = runs.get(threadId);
  Object.assign(run, { status: "running", text: "", commands: [], error: null, turnId: null });
  run.done = new Promise((resolve) => {
    const finish = (status, error) => {
      clearTimeout(timer);
      run.conn.listeners.delete(l);
      Object.assign(run, { status, error: error ?? null, turnId: null });
      log(`delegate thread=${threadId} status=${status} chars=${run.text.length}`);
      resolve();
    };
    const timer = setTimeout(() => finish("timeout"), 30 * 60 * 1000);
    const l = (m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === "turn/started") run.turnId = m.params.turn?.id ?? run.turnId;
      if (m.method === "item/agentMessage/delta") run.text += m.params.delta;
      if (m.method === "item/completed" && m.params.item?.type === "commandExecution") run.commands.push(m.params.item.command);
      if (m.method === "turn/completed") finish(m.params.turn?.status ?? "completed", m.params.turn?.error);
    };
    run.conn.listeners.add(l);
    run.conn.call("turn/start", { threadId, input: [{ type: "text", text: task, text_elements: [] }] })
      .then((r) => { run.turnId ??= r?.turn?.id ?? null; })
      .catch((e) => finish("failed", e));
  });
}

// A turn's id arrives just after it starts; wait briefly for it so an early steer or stop works.
async function activeTurn(run) {
  for (let i = 0; i < 50 && run.status === "running" && !run.turnId; i++) await new Promise((r) => setTimeout(r, 200));
  return run.status === "running" ? run.turnId : null;
}

const threadArg = z.string().describe("Elpis thread id returned by delegate.");
const known = (thread_id) => runs.has(thread_id)
  ? null
  : { content: [{ type: "text", text: `Unknown thread ${thread_id}: delegate with thread_id to reopen it.` }], isError: true };

// Helpers on other models: offered when the chat may delegate.
if (process.env.ELPIS_AGENT_TOOLS !== "0") {
  server.registerTool(
    "list_models",
    { description: "List every model you can hand a task to with delegate, grouped by where it runs, each with what it is for and its effort levels. Call it before choosing a helper.", inputSchema: {} },
    async () => {
      log("list_models");
      return { content: [{ type: "text", text: await modelCatalog() }] };
    },
  );

  server.registerTool(
    "delegate",
    {
      description:
        "Hand a task to a helper agent on another model, chosen to fit the task: a fast model for easy work, the strongest for hard work " +
        "(call list_models to see them all with what each is for). Helpers can be OpenAI GPT models, Gemini via Antigravity (agy/...) " +
        "or Claude (claude/...). It works in the given folder with its own tools and returns its final answer and the commands it ran. " +
        "Pass thread_id to send a follow-up to an earlier helper; it keeps that conversation. " +
        "Pass wait=false to return at once and follow it with delegate_status, delegate_steer and delegate_stop.",
      inputSchema: {
        task: z.string().describe("Complete instructions for the agent; it does not see this conversation."),
        thread_id: z.string().optional().describe("Continue this earlier delegated thread instead of starting a new one."),
        wait: z.boolean().default(true).describe("Wait for the answer (true) or return the thread id at once (false)."),
        model: z.string().default("gpt-6.1-sol").describe("A model id from list_models, e.g. gpt-6-luna, gpt-6-astra, agy/gemini-3.8-flash-high, claude/haiku."),
        provider: z.string().default("openai").describe("Only for engine models: openai (sign-in) or another configured Elpis provider."),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort, if the model has levels; omit for its default."),
        cwd: z.string().optional().describe("Working folder; defaults to Claude's folder."),
        allow_writes: z.boolean().default(false).describe("Let the agent change files in the folder."),
      },
    },
    async ({ task, thread_id, wait, model, provider, effort, cwd, allow_writes }) => {
      let threadId = thread_id;
      if (threadId) {
        if (runs.get(threadId)?.status === "running") {
          return { content: [{ type: "text", text: `Thread ${threadId} is still working; use delegate_steer or delegate_stop.` }], isError: true };
        }
        if (!runs.has(threadId)) {
          // A thread from an earlier server process: load it back.
          const conn = connect();
          try {
            await conn.ready;
            await conn.call("thread/resume", { threadId });
          } catch (e) {
            conn.close();
            return { content: [{ type: "text", text: `Could not reopen thread ${threadId}: ${e.message ?? JSON.stringify(e)}` }], isError: true };
          }
          runs.set(threadId, { label: "resumed agent", conn });
        }
        log(`delegate follow-up thread=${threadId}`);
      } else {
        if (bridgedModel(model) && !BRIDGE) {
          return { content: [{ type: "text", text: `${model} runs only through the Elpis Claude bridge; pick an engine model from list_models.` }], isError: true };
        }
        const folder = cwd ?? process.cwd();
        const label = bridgedModel(model) ? model : `${provider}/${model}`;
        log(`delegate model=${label} effort=${effort ?? "default"} writes=${allow_writes} cwd=${folder}`);
        // Each helper has its own connection, so helpers on the same model can run side by side.
        const conn = connect();
        await conn.ready;
        const started = await conn.call("thread/start", {
          cwd: folder, model, ...(bridgedModel(model) ? {} : { modelProvider: provider }), approvalPolicy: "never",
          sandbox: allow_writes ? "workspace-write" : "read-only",
          ...(effort && { config: { model_reasoning_effort: effort } }),
          ...(BRIDGE && PARENT && { elpisParentThreadId: PARENT }),
        });
        threadId = started.thread.id;
        // Titled by its task: the agent list already shows it under the chat that started it.
        const firstLine = task.trim().split("\n")[0];
        const title = firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 80).replace(/\s+\S*$/, "")}…`;
        await conn.call("thread/name/set", { threadId, name: title }).catch(() => {});
        runs.set(threadId, { label, conn });
      }
      startTurn(threadId, task);
      if (wait) await runs.get(threadId).done;
      const run = runs.get(threadId);
      return { content: [{ type: "text", text: report(threadId) }], isError: !["running", "completed"].includes(run.status) };
    },
  );

  server.registerTool(
    "delegate_status",
    { description: "Show a delegated agent's status, the commands it ran and its answer so far.", inputSchema: { thread_id: threadArg } },
    async ({ thread_id }) => known(thread_id) ?? { content: [{ type: "text", text: report(thread_id) }] },
  );

  server.registerTool(
    "delegate_steer",
    {
      description: "Send a correction to a delegated agent while it is still working; it takes effect in the running turn.",
      inputSchema: { thread_id: threadArg, message: z.string().describe("What the agent should do differently.") },
    },
    async ({ thread_id, message }) => {
      const unknown = known(thread_id);
      if (unknown) return unknown;
      const run = runs.get(thread_id);
      const turnId = await activeTurn(run);
      if (!turnId) {
        return { content: [{ type: "text", text: `Thread ${thread_id} is not working now (${run.status}); send a follow-up with delegate and thread_id.` }], isError: true };
      }
      await run.conn.call("turn/steer", { threadId: thread_id, expectedTurnId: turnId, input: [{ type: "text", text: message, text_elements: [] }] });
      log(`delegate steer thread=${thread_id}`);
      return { content: [{ type: "text", text: `Steered thread ${thread_id}. Check it with delegate_status.` }] };
    },
  );

  server.registerTool(
    "delegate_stop",
    { description: "Stop a delegated agent's running turn.", inputSchema: { thread_id: threadArg } },
    async ({ thread_id }) => {
      const unknown = known(thread_id);
      if (unknown) return unknown;
      const run = runs.get(thread_id);
      const turnId = await activeTurn(run);
      if (!turnId) {
        return { content: [{ type: "text", text: `Thread ${thread_id} is not working now (${run.status}).` }] };
      }
      await run.conn.call("turn/interrupt", { threadId: thread_id, turnId });
      log(`delegate stop thread=${thread_id}`);
      await Promise.race([run.done, new Promise((r) => setTimeout(r, 15000))]);
      return { content: [{ type: "text", text: report(thread_id) }] };
    },
  );
}

// Elpis's durable memory, saved by the engine's own guarded save (`elpis memory-save`): offered
// to a chat the user started, in a workspace where saving is on, as the engine offers it.
const MEMORY_CWD = process.env.ELPIS_MEMORY_CWD ?? null;
function memorySave(request) {
  return new Promise((resolve) => {
    const child = spawn(ENGINE, ["memory-save"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ error: e.message }));
    child.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve({ error: err.trim() || out.trim() || "elpis memory-save gave no answer" }); } });
    child.stdin.end(JSON.stringify({ cwd: MEMORY_CWD, threadId: PARENT, turnId: `bridge-${Date.now()}`, ...request }));
  });
}
const memoryTool = MEMORY_CWD && PARENT ? await memorySave({ checkOnly: true }) : null;
if (memoryTool?.enabled && memoryTool.description) {
  server.registerTool(
    "save_memory",
    {
      description: memoryTool.description,
      inputSchema: {
        memory_edits: z.array(z.object({ old_text: z.string().nullable(), new_text: z.string().nullable() })).describe(memoryTool.memoryEditsDescription),
        checkpoint: z.string().nullable().describe(memoryTool.checkpointDescription),
      },
    },
    async ({ memory_edits, checkpoint }) => {
      const r = await memorySave({ memoryEdits: memory_edits, checkpoint });
      log(`save_memory thread=${PARENT} ${JSON.stringify(r)}`);
      if (r.error || !r.enabled) return { content: [{ type: "text", text: `Memory save failed: ${r.error ?? "saving is off for this workspace"}` }], isError: true };
      const saved = r.memoryChanged || r.checkpointChanged;
      return { content: [{ type: "text", text: saved ? `Durable context saved (memory_changed=${r.memoryChanged}, checkpoint_changed=${r.checkpointChanged}).` : "No durable context changes requested; existing files were preserved." }] };
    },
  );
}

await server.connect(new StdioServerTransport());
log("elpis-agents ready");
