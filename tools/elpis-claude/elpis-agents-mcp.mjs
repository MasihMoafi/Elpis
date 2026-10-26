// MCP server the bridge gives Claude: hand a task to a helper agent on any model Elpis runs (GPT on
// the OpenAI sign-in, Gemini on the Antigravity sign-in, Claude on the subscription), then follow
// it up, steer it mid-turn or stop it. list_models says what each model is for. Each helper is a
// normal Elpis thread, so it appears in Elpis history (`elpis resume <thread id>` opens it).
import { spawn } from "node:child_process";
import { appendLog } from "./log-redaction.mjs";
import { connectAppServer } from "./app-server-connection.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.ELPIS_AGENTS_LOG ?? "/tmp/acp-bridge/elpis-agents.log";
const log = (s) => { try { appendLog(LOG, s); } catch {} };
const ENGINE = process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;

// Set by the bridge: helpers start through it, so any model it serves can be one, and each
// records the chat that started it. Without a bridge, helpers run on the Elpis engine alone.
const BRIDGE = process.env.ELPIS_BRIDGE_URL;
const PARENT = process.env.ELPIS_PARENT_THREAD ?? null;
const bridgedModel = (m) => /^(claude|agy)\//.test(m ?? "");

const connect = (name) => connectAppServer({ url: BRIDGE, engineBin: ENGINE, ...(name && { name }) });

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

// The engine hides every MCP tool behind tool_search for models that have it (GPT-5.5 and later); what a search can
// find is listed by each server's instructions, so they name the workflow tool and when to load it (24 Oct review:
// a chat on gpt-5.5 answered "ultracode: …" with no workflow tool in sight). Claude Code puts them in its prompt too.
const WORKFLOW_TOOL = process.env.ELPIS_WORKFLOW_TOOL === "1" && Boolean(BRIDGE);
const server = new McpServer({ name: "elpis-agents", version: "0.3.0" }, WORKFLOW_TOOL ? { instructions:
  "Has the `workflow` tool: it runs a workflow, a JavaScript script that orchestrates many helper agents in the Elpis runtime until it finishes. " +
  "Use it when the person's own message asks for a workflow: the keyword \"ultracode\", or words like \"use a workflow\", \"run a workflow\" or \"fan out agents\". " +
  "If it is not among your tools, search for \"workflow\" first." } : undefined);

// One entry per delegated thread this server has run: its active turn and what it produced.
const runs = new Map();

function report(threadId, run = runs.get(threadId)) {
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
// Read a helper from Elpis without resuming it or adding it to this server's owned runs.
async function storedRun(threadId, connection) {
  const conn = connection ?? connect();
  try {
    await conn.ready;
    const thread = (await conn.call("thread/read", { threadId, includeTurns: false }))?.thread;
    if (!thread || !(thread.parentThreadId || thread.source?.subAgent?.thread_spawn)) return null;
    const turn = (await conn.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "full" }))?.data?.[0];
    const status = thread.status?.type === "active" || turn?.status === "inProgress" ? "running"
      : turn?.status ?? (thread.status?.type === "systemError" ? "failed" : "completed");
    const items = turn?.items ?? [];
    return {
      label: thread.model ?? "helper", status,
      parentThreadId: thread.parentThreadId ?? thread.source?.subAgent?.thread_spawn?.parent_thread_id,
      turnId: status === "running" ? turn?.id ?? null : null,
      commands: items.filter((item) => item.type === "commandExecution").map((item) => item.command),
      text: items.filter((item) => item.type === "agentMessage").map((item) => item.text ?? "").join(""),
      error: turn?.error ?? null,
    };
  } finally { if (!connection) conn.close(); }
}

// A replacement MCP process controls the helper through its existing bridge runtime. Reading
// its current turn does not acquire another writer or cache a status that can go stale.
async function withRun(threadId, extra, action) {
  const own = runs.get(threadId);
  if (own) return action(own);
  const conn = connect();
  try {
    const run = await storedRun(threadId, conn);
    const parent = PARENT ?? extra?._meta?.threadId;
    if (!run || !parent || run.parentThreadId !== parent) {
      return { content: [{ type: "text", text: `Thread ${threadId} is not a delegated helper of this chat.` }], isError: true };
    }
    return await action({ ...run, conn, recovered: true });
  } finally { conn.close(); }
}

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
        effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional().describe("Reasoning effort, if the model has levels; omit for its default."),
        cwd: z.string().optional().describe("Working folder; defaults to Claude's folder."),
        allow_writes: z.boolean().default(true).describe("Let the agent change files in the folder (the default); false keeps it read-only."),
      },
    },
    async ({ task, thread_id, wait, model, provider, effort, cwd, allow_writes }, extra) => {
      // A Claude chat's server is started for that chat; an engine chat's names its thread in each call (A37).
      const parent = PARENT ?? extra?._meta?.threadId ?? null;
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
            if (BRIDGE) {
              const run = await storedRun(threadId, conn);
              if (!run || !parent || run.parentThreadId !== parent) throw new Error("This thread is not a delegated helper of this chat.");
              if (run.status === "running") {
                conn.close();
                return { content: [{ type: "text", text: `Thread ${threadId} is still working; use delegate_steer or delegate_stop.` }], isError: true };
              }
            }
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
        let started;
        try {
          await conn.ready;
          started = await conn.call("thread/start", {
            cwd: folder, model, ...(bridgedModel(model) ? {} : { modelProvider: provider }), approvalPolicy: "never",
            sandbox: allow_writes ? "workspace-write" : "read-only",
            ...(effort && { config: { model_reasoning_effort: effort } }),
            ...(BRIDGE && parent && { elpisParentThreadId: parent }),
          });
        } catch (error) {
          conn.close();
          return { content: [{ type: "text", text: `Could not start helper: ${error.message ?? JSON.stringify(error)}` }], isError: true };
        }
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
    async ({ thread_id }) => {
      if (runs.has(thread_id)) return { content: [{ type: "text", text: report(thread_id) }] };
      let run;
      try { run = await storedRun(thread_id); }
      catch (error) {
        return { content: [{ type: "text", text: `Could not read helper ${thread_id}: ${error.message ?? JSON.stringify(error)}` }], isError: true };
      }
      return run
        ? { content: [{ type: "text", text: report(thread_id, run) }] }
        : { content: [{ type: "text", text: `Thread ${thread_id} is not a delegated helper.` }], isError: true };
    },
  );

  server.registerTool(
    "delegate_steer",
    {
      description: "Send a correction to a delegated agent while it is still working; it takes effect in the running turn.",
      inputSchema: { thread_id: threadArg, message: z.string().describe("What the agent should do differently.") },
    },
    async ({ thread_id, message }, extra) => withRun(thread_id, extra, async (run) => {
      const turnId = await activeTurn(run);
      if (!turnId) {
        return { content: [{ type: "text", text: `Thread ${thread_id} is not working now (${run.status}); send a follow-up with delegate and thread_id.` }], isError: true };
      }
      await run.conn.call("turn/steer", { threadId: thread_id, expectedTurnId: turnId, input: [{ type: "text", text: message, text_elements: [] }] });
      log(`delegate steer thread=${thread_id}`);
      return { content: [{ type: "text", text: `Steered thread ${thread_id}. Check it with delegate_status.` }] };
    }),
  );

  server.registerTool(
    "delegate_stop",
    { description: "Stop a delegated agent's running turn.", inputSchema: { thread_id: threadArg } },
    async ({ thread_id }, extra) => withRun(thread_id, extra, async (run) => {
      const turnId = await activeTurn(run);
      if (!turnId) {
        return { content: [{ type: "text", text: `Thread ${thread_id} is not working now (${run.status}).` }] };
      }
      await run.conn.call("turn/interrupt", { threadId: thread_id, turnId });
      log(`delegate stop thread=${thread_id}`);
      if (run.recovered) {
        let stopped;
        const deadline = Date.now() + 15000;
        do {
          stopped = await storedRun(thread_id, run.conn);
          if (stopped?.status !== "running") break;
          await new Promise((r) => setTimeout(r, 50));
        } while (Date.now() < deadline);
        return { content: [{ type: "text", text: report(thread_id, stopped ?? run) }] };
      }
      let timer;
      await Promise.race([run.done, new Promise((r) => { timer = setTimeout(r, 15000); })]);
      clearTimeout(timer);
      return { content: [{ type: "text", text: report(thread_id) }] };
    }),
  );
}

// Workflows that run until they finish (SPEC WR1): the script runs in the Elpis runtime, not in this process, so it
// continues after this chat's turn, the window or the app closes, and resumes after a restart. Opt-in, as in Claude
// Code: the runtime starts it only when the person asked for a workflow in their own message.
if (WORKFLOW_TOOL) {
  server.registerTool(
    "workflow",
    {
      description:
        "Run a workflow: a JavaScript script that orchestrates many helper agents deterministically (fan out, verify, synthesize). " +
        "ONLY use it when the person explicitly asked for a workflow in their own message (the keyword \"ultracode\", or words like " +
        "\"use a workflow\" / \"run a workflow\"); a task that would merely benefit does not count, and the runtime refuses otherwise. " +
        "It returns at once with a run id and the saved script's path; the run continues in the background, and when it ends this chat " +
        "gets a <workflow-notification> with the script's return value. Do not wait or poll for it.\n\n" +
        "Script format: it must begin with `export const meta = { name: 'kebab-name', description: 'one line', phases: [{ title: 'Scan', detail: '...' }] }` " +
        "(a PURE literal: no variables, calls, spreads or interpolation), then a plain JavaScript body (no TypeScript) with top-level await and `return value`.\n" +
        "Hooks: agent(prompt, {label, phase, schema, model, effort, isolation: 'worktree'}) -> Promise of the agent's final text, or, with schema " +
        "(JSON Schema, {type:'object', properties} at the root, required among properties), the validated object; null if the agent failed after its retries or was skipped. " +
        "Each agent is a new helper chat that does not see this conversation: give it complete instructions. model defaults to this chat's model; effort 'low'..'max'. " +
        "parallel(thunks) is a barrier (a throwing thunk gives null); pipeline(items, stage1, stage2, ...) runs each item through the stages with no barrier " +
        "(each stage gets (prevResult, item, index)); prefer pipeline. phase(title), log(message), args (this call's args, verbatim JSON), " +
        "budget {total, spent(), remaining()}, workflow(name or {scriptPath}, args) runs another workflow inline (one level). " +
        "Date.now(), Math.random() and new Date() without arguments throw (they would break resume): pass timestamps through args. No filesystem or Node APIs. " +
        "Limits: min(16, CPUs-2) agents at once (the rest queue), 1000 agents per run, 4096 items per parallel/pipeline call.\n\n" +
        "To change a workflow, edit the saved script and launch {scriptPath, resumeFromRunId}: the unchanged prefix of agent() calls returns the old run's results at once; " +
        "the first edited or new call and everything after it run live. Same script and args: every call is cached.",
      inputSchema: {
        script: z.string().optional().describe("The workflow script: `export const meta = {...}` followed by the body. Pass it inline."),
        args: z.any().optional().describe("Any JSON value, passed to the script as `args` verbatim (pass arrays and objects as JSON, not as a string)."),
        scriptPath: z.string().optional().describe("Run a saved script file instead of `script` (the path an earlier launch returned, after editing it)."),
        resumeFromRunId: z.string().optional().describe("Reuse that run's journal: unchanged agent() calls return their results at once."),
      },
    },
    async ({ script, args, scriptPath, resumeFromRunId }, extra) => {
      const threadId = PARENT ?? extra?._meta?.threadId ?? null;
      const conn = connect("elpis-workflow");
      try {
        await conn.ready;
        const r = await conn.call("workflowRun/start", { threadId, script, args, scriptPath, resumeFromRunId, cwd: process.cwd() });
        log(`workflow ${r.runId} started by ${threadId}`);
        return { content: [{ type: "text", text: `Workflow "${r.name}" is running in the background as ${r.runId}.\nScript saved at ${r.scriptPath} (edit it and launch {scriptPath, resumeFromRunId: "${r.runId}"} to change it).\nThis chat gets a <workflow-notification> with its result when it ends; do not wait or poll.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `The workflow did not start: ${e.message ?? JSON.stringify(e)}` }], isError: true };
      } finally { conn.close(); }
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
