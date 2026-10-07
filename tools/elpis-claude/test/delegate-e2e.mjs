// End-to-end check of the elpis-agents MCP server: Claude can continue, steer and stop a
// delegated Elpis agent. Uses the real engine and GPT on the OpenAI sign-in.
// Run: node test/delegate-e2e.mjs [followup] [steer] [resume] [stop]. Exit code 0 only if all pass.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exitCode = 1; };
const pass = (msg) => console.log(`PASS ${msg}`);
const client = new Client({ name: "delegate-e2e", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "elpis-agents-mcp.mjs")],
  env: { ...process.env, ELPIS_AGENTS_LOG: "/tmp/acp-bridge/delegate-e2e.log" },
}));
const cwd = mkdtempSync(join(tmpdir(), "delegate-e2e-"));
const base = { model: process.env.E2E_MODEL ?? "gpt-6.1-sol", effort: "low", cwd };
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};
const threadOf = (text) => text.match(/Elpis thread ([0-9a-f-]{36})/)?.[1];
const until = async (threadId, done, ms = 240000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 2000))) {
    const s = await call("delegate_status", { thread_id: threadId });
    if (done(s.text)) return s.text;
  }
  return null;
};

const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ["followup", "steer", "resume", "stop"];
for (const s of scenarios) {
  if (s === "followup") {
    const word = `KIWI-${Math.floor(Math.random() * 9000 + 1000)}`;
    const first = await call("delegate", { ...base, task: `Remember the code word ${word}. Reply only: OK` });
    const threadId = threadOf(first.text);
    if (!threadId) { fail(`followup: no thread id in ${first.text}`); continue; }
    const second = await call("delegate", { ...base, thread_id: threadId, task: "What was the code word? Reply with it only." });
    if (threadOf(second.text) !== threadId) fail(`followup: answered in another thread: ${second.text}`);
    else if (!second.text.includes(word)) fail(`followup: agent forgot ${word}: ${second.text}`);
    else pass(`followup remembers ${word} in thread ${threadId}`);
  }
  if (s === "steer") {
    const started = await call("delegate", { ...base, wait: false, task: "Run the shell command `sleep 25`, then reply only: FIRST-PLAN" });
    const threadId = threadOf(started.text);
    if (!threadId) { fail(`steer: no thread id in ${started.text}`); continue; }
    if (!(await until(threadId, (t) => /status: running/.test(t) && /sleep 25|Commands it ran/.test(t), 60000))) {
      await new Promise((r) => setTimeout(r, 5000));
    }
    const steered = await call("delegate_steer", { thread_id: threadId, message: "Change of plan: after the command finishes, reply only: STEERED-PLAN" });
    if (steered.isError) { fail(`steer: ${steered.text}`); continue; }
    const final = await until(threadId, (t) => !/status: running/.test(t));
    if (!final) fail("steer: turn never finished");
    else if (!final.includes("STEERED-PLAN")) fail(`steer: steer ignored: ${final}`);
    else pass(`steer redirected a running agent (thread ${threadId})`);
  }
  if (s === "resume") {
    // A later Claude session runs a fresh MCP server after the first one exited; the thread must
    // still accept follow-ups.
    const word = `PLUM-${Math.floor(Math.random() * 9000 + 1000)}`;
    const ask = async (args) => {
      const c = new Client({ name: "delegate-e2e-resume", version: "0.1.0" });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "elpis-agents-mcp.mjs")], env: process.env }));
      const r = await c.callTool({ name: "delegate", arguments: args });
      await c.close();
      return r.content.map((x) => x.text).join("\n");
    };
    const threadId = threadOf(await ask({ ...base, task: `Remember the code word ${word}. Reply only: OK` }));
    const text = await ask({ ...base, thread_id: threadId, task: "What was the code word? Reply with it only." });
    if (!text.includes(word)) fail(`resume: a new server lost ${word}: ${text}`);
    else pass(`resume: a new server continued thread ${threadId}`);
  }
  if (s === "stop") {
    const started = await call("delegate", { ...base, wait: false, task: "Run the shell command `sleep 120`, then reply only: TOO-LATE" });
    const threadId = threadOf(started.text);
    if (!threadId) { fail(`stop: no thread id in ${started.text}`); continue; }
    await new Promise((r) => setTimeout(r, 8000));
    const stopped = await call("delegate_stop", { thread_id: threadId });
    if (stopped.isError) { fail(`stop: ${stopped.text}`); continue; }
    const final = await until(threadId, (t) => !/status: running/.test(t), 30000);
    if (!final) fail("stop: still running 30s after stop");
    else if (final.includes("TOO-LATE")) fail(`stop: agent finished anyway: ${final}`);
    else pass(`stop interrupted a running agent (thread ${threadId})`);
  }
}
await client.close();
