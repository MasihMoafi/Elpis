// End-to-end check of the bridge, acting as the Elpis TUI over the app-server protocol.
// Uses the real engine and Claude (subscription). Run: node test/bridge-e2e.mjs [scenario...]
// Scenarios: text, image. Exit code 0 only if every scenario passes.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const here = new URL("..", import.meta.url).pathname;
const port = 47000 + Math.floor(Math.random() * 900);
const bridge = spawn("node", [process.env.E2E_BRIDGE ?? join(here, "acp-bridge.mjs")], {
  env: { ...process.env, PORT: String(port), NODE_USE_ENV_PROXY: "1", ACP_BRIDGE_LOG: process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/e2e.log" },
  stdio: "ignore",
});
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exitCode = 1; };
await new Promise((r) => setTimeout(r, 800));

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
let seq = 0;
const pending = new Map();
const listeners = new Set();
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.id !== undefined && m.method) ws.send(JSON.stringify({ id: m.id, result: { decision: "accept" } }));
  for (const l of listeners) l(m);
});
const call = (method, params) => new Promise((r) => { const id = `e2e-${++seq}`; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const turn = (threadId, input, timeoutMs = 120000) => new Promise((resolve) => {
  let text = "";
  const l = (m) => {
    if (m.method === "item/agentMessage/delta" && m.params.threadId === threadId) text += m.params.delta;
    if (m.method === "turn/completed" && m.params.threadId === threadId) { listeners.delete(l); resolve({ text, status: m.params.turn.status, error: m.params.turn.error }); }
  };
  listeners.add(l);
  setTimeout(() => { listeners.delete(l); resolve({ text, status: "timeout" }); }, timeoutMs);
  call("turn/start", { threadId, input });
});

const init = await call("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0.160.0" }, capabilities: { experimentalApi: true } });
if (init.error) fail(`initialize: ${JSON.stringify(init.error)}`);
ws.send(JSON.stringify({ method: "initialized" }));
const models = await call("model/list", { cursor: null, limit: null, includeHidden: true });
if (!models.result?.data?.some((m) => m.id === "claude/opus")) fail("model/list has no claude/opus");

const dir = mkdtempSync(join(tmpdir(), "elpis-e2e-"));
const started = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
const threadId = started.result?.thread?.id;
if (!threadId) { fail(`thread/start: ${JSON.stringify(started.error ?? started)}`); process.exit(1); }
await call("thread/settings/update", { threadId, model: "claude/opus", effort: "low" });

const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ["text", "image"];
for (const s of scenarios) {
  if (s === "text") {
    const word = `KIWI-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = await turn(threadId, [{ type: "text", text: `Reply with exactly: ${word}`, text_elements: [] }]);
    r.text.includes(word) && r.status === "completed" ? console.log(`PASS text (${word})`) : fail(`text: ${JSON.stringify(r)}`);
  } else if (s === "interrupt") {
    const t0 = Date.now();
    let turnId = null;
    const firstDelta = new Promise((r) => { const l = (m) => { if (m.method === "item/agentMessage/delta" && m.params.threadId === threadId) { listeners.delete(l); r(); } }; listeners.add(l); });
    const idL = (m) => { if (m.method === "turn/started" && m.params.threadId === threadId) { turnId = m.params.turn.id; listeners.delete(idL); } };
    listeners.add(idL);
    const done = turn(threadId, [{ type: "text", text: "Write the numbers from 1 to 400, one per line, with a short word after each.", text_elements: [] }], 180000);
    await firstDelta;
    const ir = await call("turn/interrupt", { threadId, turnId });
    const r = await done;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    r.status === "interrupted" && !ir.error ? console.log(`PASS interrupt (stopped after ${secs}s, ${r.text.length} chars)`) : fail(`interrupt: status=${r.status} after ${secs}s, interrupt reply ${JSON.stringify(ir)}`);
    const after = await turn(threadId, [{ type: "text", text: "Reply with exactly: AFTER-STOP", text_elements: [] }]);
    after.text.includes("AFTER-STOP") ? console.log("PASS turn after interrupt") : fail(`turn after interrupt: ${JSON.stringify(after)}`);
  } else if (s === "image") {
    const word = process.env.E2E_IMAGE_WORD;
    const path = process.env.E2E_IMAGE_PATH;
    if (!word || !path) { fail("image: set E2E_IMAGE_PATH and E2E_IMAGE_WORD"); continue; }
    const r = await turn(threadId, [
      { type: "text", text: "What word is written in this image? Reply with only the word.", text_elements: [] },
      { type: "localImage", path },
    ]);
    r.text.includes(word) ? console.log(`PASS image (${word})`) : fail(`image: ${JSON.stringify(r)}`);
  }
}
writeFileSync(join(dir, ".done"), "");
ws.close();
bridge.kill();
process.exit();
