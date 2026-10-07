// MCP server the bridge gives Claude: delegate a task to another Elpis model (e.g. GPT-6.1-Sol
// on the OpenAI sign-in), then follow it up, steer it mid-turn or stop it. Each delegation is a
// normal Elpis thread run by the Elpis engine, with Elpis's own tools, so it also appears in
// Elpis history (and `elpis resume <thread id>` opens it).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.ELPIS_AGENTS_LOG ?? "/tmp/acp-bridge/elpis-agents.log";
const log = (s) => { try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${s}\n`); } catch {} };
const ENGINE = process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;

let engine = null;
function startEngine() {
  const proc = spawn(ENGINE, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); continue; }
      if (m.id !== undefined && m.method) proc.stdin.write(JSON.stringify({ id: m.id, result: { decision: "decline" } }) + "\n");
      for (const l of listeners) l(m);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `agents-${++seq}`;
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const ready = call("initialize", { clientInfo: { name: "elpis-agents", title: null, version: "0.1.0" }, capabilities: { experimentalApi: true } })
    .then(() => proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n"));
  return { proc, call, listeners, ready };
}

const server = new McpServer({ name: "elpis-agents", version: "0.2.0" });

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
      engine.listeners.delete(l);
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
    engine.listeners.add(l);
    engine.call("turn/start", { threadId, input: [{ type: "text", text: task, text_elements: [] }] })
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

server.registerTool(
  "delegate",
  {
    description:
      "Run a task with another Elpis model, such as OpenAI GPT-6.1-Sol, as a separate Elpis agent. " +
      "It works in the given folder with Elpis's own tools and returns its final answer and the commands it ran. " +
      "Pass thread_id to send a follow-up to an earlier agent; it keeps that conversation. " +
      "Pass wait=false to return at once and follow it with delegate_status, delegate_steer and delegate_stop.",
    inputSchema: {
      task: z.string().describe("Complete instructions for the agent; it does not see this conversation."),
      thread_id: z.string().optional().describe("Continue this earlier delegated thread instead of starting a new one."),
      wait: z.boolean().default(true).describe("Wait for the answer (true) or return the thread id at once (false)."),
      model: z.string().default("gpt-6.1-sol").describe("Model id, e.g. gpt-6.1-sol, gpt-6-astra, gpt-6-luna."),
      provider: z.string().default("openai").describe("Elpis provider id: openai (sign-in), openrouter, ..."),
      effort: z.enum(["low", "medium", "high"]).default("medium"),
      cwd: z.string().optional().describe("Working folder; defaults to Claude's folder."),
      allow_writes: z.boolean().default(false).describe("Let the agent change files in the folder."),
    },
  },
  async ({ task, thread_id, wait, model, provider, effort, cwd, allow_writes }) => {
    engine ??= startEngine();
    await engine.ready;
    let threadId = thread_id;
    if (threadId) {
      if (runs.get(threadId)?.status === "running") {
        return { content: [{ type: "text", text: `Thread ${threadId} is still working; use delegate_steer or delegate_stop.` }], isError: true };
      }
      if (!runs.has(threadId)) {
        // A thread from an earlier server process: load it back into this engine.
        try {
          await engine.call("thread/resume", { threadId });
        } catch (e) {
          return { content: [{ type: "text", text: `Could not reopen thread ${threadId}: ${e.message ?? JSON.stringify(e)}` }], isError: true };
        }
        runs.set(threadId, { label: "resumed agent" });
      }
      log(`delegate follow-up thread=${threadId}`);
    } else {
      const folder = cwd ?? process.cwd();
      log(`delegate model=${provider}/${model} effort=${effort} writes=${allow_writes} cwd=${folder}`);
      const started = await engine.call("thread/start", {
        cwd: folder, model, modelProvider: provider, approvalPolicy: "never",
        sandbox: allow_writes ? "workspace-write" : "read-only",
        config: { model_reasoning_effort: effort },
      });
      threadId = started.thread.id;
      await engine.call("thread/name/set", { threadId, name: `Delegated by Claude: ${task.slice(0, 60)}` }).catch(() => {});
      runs.set(threadId, { label: `${provider}/${model}` });
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
    await engine.call("turn/steer", { threadId: thread_id, expectedTurnId: turnId, input: [{ type: "text", text: message, text_elements: [] }] });
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
    await engine.call("turn/interrupt", { threadId: thread_id, turnId });
    log(`delegate stop thread=${thread_id}`);
    await Promise.race([run.done, new Promise((r) => setTimeout(r, 15000))]);
    return { content: [{ type: "text", text: report(thread_id) }] };
  },
);

await server.connect(new StdioServerTransport());
log("elpis-agents ready");
