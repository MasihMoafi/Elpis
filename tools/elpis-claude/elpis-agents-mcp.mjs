// MCP server the bridge gives Claude: delegate a task to another Elpis model (e.g. GPT-6.1-Sol
// on the OpenAI sign-in). Each delegation is a normal Elpis thread run by the Elpis engine,
// with Elpis's own tools, so it also appears in Elpis history.
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

const server = new McpServer({ name: "elpis-agents", version: "0.1.0" });

server.registerTool(
  "delegate",
  {
    description:
      "Run a task with another Elpis model, such as OpenAI GPT-6.1-Sol, as a separate Elpis agent. " +
      "It works in the given folder with Elpis's own tools and returns its final answer and the commands it ran. " +
      "Use it to hand a bounded subtask to a different model or to get a second opinion.",
    inputSchema: {
      task: z.string().describe("Complete instructions for the agent; it does not see this conversation."),
      model: z.string().default("gpt-6.1-sol").describe("Model id, e.g. gpt-6.1-sol, gpt-6-astra, gpt-6-luna."),
      provider: z.string().default("openai").describe("Elpis provider id: openai (sign-in), openrouter, ..."),
      effort: z.enum(["low", "medium", "high"]).default("medium"),
      cwd: z.string().optional().describe("Working folder; defaults to Claude's folder."),
      allow_writes: z.boolean().default(false).describe("Let the agent change files in the folder."),
    },
  },
  async ({ task, model, provider, effort, cwd, allow_writes }) => {
    engine ??= startEngine();
    await engine.ready;
    const folder = cwd ?? process.cwd();
    log(`delegate model=${provider}/${model} effort=${effort} writes=${allow_writes} cwd=${folder}`);
    const started = await engine.call("thread/start", {
      cwd: folder, model, modelProvider: provider, approvalPolicy: "never",
      sandbox: allow_writes ? "workspace-write" : "read-only",
      config: { model_reasoning_effort: effort },
    });
    const threadId = started.thread.id;
    await engine.call("thread/name/set", { threadId, name: `Delegated by Claude: ${task.slice(0, 60)}` }).catch(() => {});
    let text = "";
    const commands = [];
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { engine.listeners.delete(l); resolve({ status: "timeout" }); }, 15 * 60 * 1000);
      const l = (m) => {
        if (m.params?.threadId !== threadId) return;
        if (m.method === "item/agentMessage/delta") text += m.params.delta;
        if (m.method === "item/completed" && m.params.item?.type === "commandExecution") commands.push(m.params.item.command);
        if (m.method === "turn/completed") { clearTimeout(timer); engine.listeners.delete(l); resolve(m.params.turn); }
      };
      engine.listeners.add(l);
      engine.call("turn/start", { threadId, input: [{ type: "text", text: task, text_elements: [] }] })
        .catch((e) => { clearTimeout(timer); engine.listeners.delete(l); resolve({ status: "failed", error: e }); });
    });
    log(`delegate thread=${threadId} status=${result.status} chars=${text.length}`);
    const lines = [
      `Agent: ${provider}/${model} (Elpis thread ${threadId}), status: ${result.status}`,
      commands.length ? `Commands it ran: ${commands.join("; ")}` : "Commands it ran: none",
      result.error ? `Error: ${result.error.message ?? JSON.stringify(result.error)}` : "",
      "Answer:",
      text.trim() || "(no answer)",
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }], isError: result.status !== "completed" };
  },
);

await server.connect(new StdioServerTransport());
log("elpis-agents ready");
