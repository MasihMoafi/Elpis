#!/usr/bin/env node
// A scripted stand-in for `elpis app-server` (stdio JSON-RPC), used as ELPIS_ENGINE_BIN in tests. No model calls.
// Every message it receives is appended to $FAKE_ENGINE_LOG. A turn answers `Answer from <model>: <input>` in two
// deltas; markers in the input change the turn:
//   [commentary]       a commentary message first
//   [command]          asks to run a command and reports the decision it got (approval request first)
//   [hang]             waits for turn/interrupt
//   [fail]             the turn fails
//   [crash]            the process exits with code 3 after accepting the turn
import fs from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv[2] !== "app-server") { process.stderr.write("fake engine: only app-server\n"); process.exit(2); }
const log = (entry) => { if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(entry) + "\n"); };
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });
const threads = new Map(); // id -> { model }
const waiting = new Map(); // our request id -> resolve
const turns = new Map(); // turn id -> { interrupt }
let seq = 0;
const ask = (method, params) => new Promise((resolve) => { const id = `engine-${++seq}`; waiting.set(id, resolve); send({ id, method, params }); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(threadId, turn, text) {
  const thread = threads.get(threadId);
  let interrupted = false;
  const stopped = new Promise((resolve) => turns.set(turn.id, { interrupt: () => { interrupted = true; resolve(); } }));
  const finish = (status, extra = {}) => {
    turns.delete(turn.id);
    notify("turn/completed", { threadId, turn: { ...turn, status, items: [], error: null, ...extra } });
  };
  notify("turn/started", { threadId, turn });
  const message = async (id, body, phase) => {
    notify("item/started", { threadId, turnId: turn.id, item: { type: "agentMessage", id, text: "", phase } });
    const half = Math.ceil(body.length / 2);
    for (const delta of [body.slice(0, half), body.slice(half)]) { notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: id, delta }); await pause(5); }
    notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id, text: body, phase } });
  };
  if (text.includes("[crash]")) { await pause(20); process.exit(3); }
  if (text.includes("[fail]")) return finish("failed", { error: { message: "Fake engine failure" } });
  if (text.includes("[commentary]")) await message("note-1", "Looking around first.", "commentary");
  notify("item/reasoning/summaryTextDelta", { threadId, turnId: turn.id, itemId: "think-1", delta: "Thinking briefly.", summaryIndex: 0 });
  let decision = null;
  if (text.includes("[command]")) {
    const asked = ask("item/commandExecution/requestApproval", { threadId, turnId: turn.id, itemId: "cmd-1", startedAtMs: Date.now(), command: "touch approved.txt", cwd: "/work", reason: "Needs to write" })
      .then((r) => { const d = r?.decision ?? `error:${JSON.stringify(r)}`; log({ decision: d }); return d; });
    decision = await Promise.race([asked, stopped.then(() => null)]);
    if (interrupted || decision === "cancel") return finish("interrupted");
    const ran = decision === "accept" || decision === "acceptForSession";
    const item = { type: "commandExecution", id: "cmd-1", command: "touch approved.txt", cwd: "/work", processId: null, source: "agent", status: ran ? "inProgress" : "declined", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    if (ran) {
      notify("item/started", { threadId, turnId: turn.id, item });
      notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: "completed", aggregatedOutput: "done\n", exitCode: 0, durationMs: 3 } });
    } else notify("item/completed", { threadId, turnId: turn.id, item });
  }
  if (text.includes("[hang]")) { await stopped; return finish("interrupted"); }
  if (interrupted) return finish("interrupted");
  await message("answer-1", `Answer from ${thread.model}: ${decision ? `decision ${decision}. ` : ""}${text}`, "final_answer");
  finish(interrupted ? "interrupted" : "completed");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  log(msg);
  if (msg.id !== undefined && !msg.method) { const resolve = waiting.get(msg.id); waiting.delete(msg.id); resolve?.(msg.error ? { decision: `error:${msg.error.message}` } : msg.result); return; }
  if (msg.id === undefined) return;
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize": return send({ id: msg.id, result: { userAgent: "fake-engine/0" } });
    case "thread/start": {
      const id = randomUUID();
      threads.set(id, { model: p.model ?? "default-model" });
      return send({ id: msg.id, result: { thread: { id, cwd: p.cwd }, model: p.model ?? "default-model", modelProvider: p.modelProvider ?? "openai" } });
    }
    case "turn/start": {
      if (!threads.has(p.threadId)) return send({ id: msg.id, error: { code: -32600, message: "no such thread" } });
      const turn = { id: `turn-${randomUUID()}`, status: "inProgress", items: [] };
      send({ id: msg.id, result: { turn } });
      const text = (p.input ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      runTurn(p.threadId, turn, text);
      return;
    }
    case "turn/interrupt": { turns.get(p.turnId)?.interrupt(); return send({ id: msg.id, result: {} }); }
    default: return send({ id: msg.id, error: { code: -32601, message: `fake engine: ${msg.method}` } });
  }
}
