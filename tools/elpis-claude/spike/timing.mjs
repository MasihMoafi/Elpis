// Minimal ACP client: proves Claude Code runs on the subscription, uses its
// own tools, and routes permission requests to the client (the future Elpis).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const cwd = "/tmp/acp-probe";
mkdirSync(cwd, { recursive: true });
const agent = spawn("node", ["../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"], {
  env: { ...process.env, CLAUDE_CODE_EXECUTABLE: `${process.env.HOME}/.local/bin/claude` },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const seen = { updates: {}, permissions: [], tools: [] };
const send = (msg) => agent.stdin.write(JSON.stringify(msg) + "\n");
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

let buf = "";
let reply = "";
agent.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    } else if (msg.method === "session/update") {
      const u = msg.params.update;
      seen.updates[u.sessionUpdate] = (seen.updates[u.sessionUpdate] ?? 0) + 1;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") reply += u.content.text;
      if (u.sessionUpdate === "tool_call") seen.tools.push(u.title);
    } else if (msg.method === "session/request_permission") {
      seen.permissions.push(msg.params.toolCall?.title);
      const allow = msg.params.options.find((o) => o.kind === "allow_once") ?? msg.params.options[0];
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
    }
  }
});

const timer = setTimeout(() => { console.log("TIMEOUT", JSON.stringify(seen)); process.exit(2); }, 180_000);
try {
  const init = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  console.log("initialize: protocol", init.protocolVersion, "auth methods", (init.authMethods ?? []).map((m) => m.id).join(","));
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log("session:", sessionId);
  for (const [n, text] of [[1, "Reply with exactly: ONE"], [2, "Reply with exactly: TWO"], [3, "Reply with exactly: THREE"]]) {
    reply = ""; const t0 = Date.now(); let first = 0;
    const tick = setInterval(() => { if (!first && reply) first = Date.now() - t0; }, 5);
    const r = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    clearInterval(tick);
    const pids = (await import("node:child_process")).execSync("pgrep -c -f '[c]laude.*--input-format' || true").toString().trim();
    console.log(`turn ${n}: ${Date.now() - t0} ms total, first text ~${first} ms, reply=${reply.trim()}, stop=${r.stopReason}, live claude procs=${pids}`);
  }
  console.log("tools:", JSON.stringify(seen.tools), "permissions asked:", JSON.stringify(seen.permissions));
  console.log("update kinds:", JSON.stringify(seen.updates));
} catch (e) {
  console.log("ERROR", JSON.stringify(e), JSON.stringify(seen));
} finally {
  clearTimeout(timer);
  agent.kill();
}
