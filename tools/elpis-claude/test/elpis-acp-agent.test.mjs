// The Elpis ACP agent (elpis-acp-agent.mjs) driven by the official ACP SDK client, on a scripted app-server
// (fake-app-server.mjs as ELPIS_ENGINE_BIN). No model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const AGENT = fileURLToPath(new URL("../elpis-acp-agent.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(10)) { const value = check(); if (value) return value; }
  throw new Error(`timed out waiting for ${what}`);
}

function start(t, { args = ["--model", "luna-test", "--provider", "openai"], answer, command } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-acp-agent-"));
  const engineLog = path.join(dir, "engine.jsonl");
  const launch = command ? command(dir) : { argv: [process.execPath, AGENT, ...args], env: { ELPIS_ENGINE_BIN: ENGINE } };
  const [program, ...argv] = launch.argv;
  const child = spawn(program, argv, { cwd: dir, env: { ...process.env, FAKE_ENGINE_LOG: engineLog, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = once(child, "exit");
  const events = []; // session/update and permission requests, in arrival order
  const state = { answer: answer ?? (() => ({ outcome: { outcome: "selected", optionId: "allow_once" } })) };
  const conn = client({ name: "acp-agent-test" })
    .onNotification("session/update", ({ params }) => { events.push({ kind: "update", ...params }); })
    .onRequest("session/request_permission", async ({ params }) => { events.push({ kind: "permission", ...params }); return state.answer(params); })
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  t.after(() => { conn.close(); child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  const engine = () => (fs.existsSync(engineLog) ? fs.readFileSync(engineLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const updates = (kind) => events.filter((e) => e.kind === "update" && (!kind || e.update.sessionUpdate === kind)).map((e) => e.update);
  const text = (kind = "agent_message_chunk") => updates(kind).map((u) => u.content.text).join("");
  const open = async (meta) => {
    const init = await conn.agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const session = await conn.agent.request("session/new", { cwd: dir, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
    return { init, sessionId: session.sessionId };
  };
  const prompt = (sessionId, text) => conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { dir, child, conn, events, state, engine, updates, text, open, prompt, exited, stderr: () => stderr };
}

test("initialize and session/new start an Elpis thread with the chosen model and instructions", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { init, sessionId } = await a.open({ systemPrompt: { append: "Be brief and exact." } });
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.name, "elpis");
  assert.equal(init.agentCapabilities.loadSession, false);
  const started = await until(() => a.engine().find((m) => m.method === "thread/start"), "thread/start");
  assert.deepEqual(
    { cwd: started.params.cwd, model: started.params.model, modelProvider: started.params.modelProvider, approvalPolicy: started.params.approvalPolicy, sandbox: started.params.sandbox, developerInstructions: started.params.developerInstructions },
    { cwd: a.dir, model: "luna-test", modelProvider: "openai", approvalPolicy: "on-request", sandbox: "workspace-write", developerInstructions: "Be brief and exact." },
  );
  assert.ok(a.engine().some((m) => m.method === "initialized"), "the engine connection completes its own handshake");
  assert.match(sessionId, /^[0-9a-f-]{36}$/, "the ACP session is the Elpis thread");
  await assert.rejects(a.conn.agent.request("session/prompt", { sessionId: "not-a-session", prompt: [{ type: "text", text: "x" }] }), /Unknown session/);
  // Closing stdin ends the agent and its engine cleanly.
  a.child.stdin.end();
  const [code] = await a.exited;
  assert.equal(code, 0);
});

test("a turn streams as session updates: reasoning, commentary marked, then the final answer", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  const result = await a.prompt(sessionId, "[commentary] Unique seed 7f3a");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(a.text("agent_thought_chunk"), "Thinking briefly.");
  const chunks = a.updates("agent_message_chunk");
  assert.ok(chunks.length >= 4, "deltas stream as separate chunks");
  const byMessage = (id) => chunks.filter((c) => c.messageId === id);
  assert.equal(byMessage("note-1").map((c) => c.content.text).join(""), "Looking around first.");
  assert.ok(byMessage("note-1").every((c) => c._meta?.elpis?.phase === "commentary"));
  assert.equal(byMessage("answer-1").map((c) => c.content.text).join(""), "Answer from luna-test: [commentary] Unique seed 7f3a");
  assert.ok(byMessage("answer-1").every((c) => c._meta?.elpis?.phase !== "commentary"));
  const turn = a.engine().find((m) => m.method === "turn/start");
  assert.equal(turn.params.threadId, sessionId);
  assert.deepEqual(turn.params.input, [{ type: "text", text: "[commentary] Unique seed 7f3a", text_elements: [] }]);
});

test("an engine approval becomes session/request_permission; the chosen option is the engine's decision", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  const allowed = await a.prompt(sessionId, "[command] allow it");
  assert.equal(allowed.stopReason, "end_turn");
  const permission = a.events.find((e) => e.kind === "permission");
  assert.equal(permission.sessionId, sessionId);
  assert.equal(permission.toolCall.toolCallId, "cmd-1");
  assert.equal(permission.toolCall.kind, "execute");
  assert.match(permission.toolCall.title, /touch approved\.txt/);
  assert.deepEqual(permission.options.map((o) => [o.optionId, o.kind]), [["allow_once", "allow_once"], ["allow_always", "allow_always"], ["reject_once", "reject_once"]]);
  const pending = a.events.findIndex((e) => e.kind === "update" && e.update.toolCallId === "cmd-1" && e.update.status === "pending");
  assert.ok(pending >= 0 && pending < a.events.indexOf(permission), "the tool call is announced before permission is asked");
  assert.ok(a.updates("tool_call_update").some((u) => u.toolCallId === "cmd-1" && u.status === "completed"));
  assert.deepEqual(a.engine().filter((m) => "decision" in m).map((m) => m.decision), ["accept"]);
  assert.match(a.text(), /decision accept/);

  a.state.answer = () => ({ outcome: { outcome: "selected", optionId: "reject_once" } });
  const before = a.events.length;
  const rejected = await a.prompt(sessionId, "[command] reject it");
  assert.equal(rejected.stopReason, "end_turn");
  assert.deepEqual(a.engine().filter((m) => "decision" in m).map((m) => m.decision), ["accept", "decline"]);
  assert.ok(a.events.slice(before).some((e) => e.kind === "update" && e.update.toolCallId === "cmd-1" && e.update.status === "failed"), "a rejected call is shown failed");
  assert.equal(a.events.slice(before).some((e) => e.kind === "update" && e.update.toolCallId === "cmd-1" && e.update.status === "completed"), false);

  a.state.answer = () => ({ outcome: { outcome: "selected", optionId: "made-up" } });
  await a.prompt(sessionId, "[command] unknown option");
  assert.equal(a.engine().filter((m) => "decision" in m).at(-1).decision, "decline", "an unknown option fails closed");
});

test("session/cancel interrupts the running turn and the prompt ends cancelled", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  const running = a.prompt(sessionId, "[hang] wait for me");
  await until(() => a.text("agent_thought_chunk"), "the turn to start");
  await assert.rejects(a.prompt(sessionId, "second"), /already in progress/);
  await a.conn.agent.notify("session/cancel", { sessionId });
  assert.equal((await running).stopReason, "cancelled");
  const turnId = a.engine().find((m) => m.method === "turn/start") && a.engine().find((m) => m.method === "turn/interrupt")?.params.turnId;
  assert.match(turnId ?? "", /^turn-/, "the engine was asked to interrupt the turn");
  // The session takes a new prompt afterwards.
  assert.equal((await a.prompt(sessionId, "again")).stopReason, "end_turn");
});

test("cancelling while permission is pending answers the engine with cancel", { timeout: 20000 }, async (t) => {
  let release;
  const a = start(t, { answer: () => new Promise((resolve) => { release = resolve; }) });
  const { sessionId } = await a.open();
  const running = a.prompt(sessionId, "[command] then wait");
  await until(() => a.events.some((e) => e.kind === "permission"), "the permission request");
  await a.conn.agent.notify("session/cancel", { sessionId });
  // ACP: after session/cancel the client answers pending permission requests with `cancelled`.
  release({ outcome: { outcome: "cancelled" } });
  assert.equal((await running).stopReason, "cancelled");
  await until(() => a.engine().some((m) => m.decision === "cancel"), "the engine to receive cancel");
  assert.equal(a.engine().some((m) => m.decision === "accept"), false);
});

test("a crashed engine fails the prompt and ends the agent with an error", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  await assert.rejects(a.prompt(sessionId, "[crash]"), /Elpis engine exited/);
  const [code] = await a.exited;
  assert.notEqual(code, 0);
});

test("a failed engine turn is a JSON-RPC error with the engine's reason", { timeout: 20000 }, async (t) => {
  const a = start(t);
  const { sessionId } = await a.open();
  await assert.rejects(a.prompt(sessionId, "[fail]"), /Fake engine failure/);
});

test("`elpis acp` through the installed wrapper is the Elpis ACP agent on the real engine path", { timeout: 20000 }, async (t) => {
  // The wrapper's layout: ~/.local/lib/elpis-next/elpis-next (the engine) and its bridge folder under ~/Desktop/p.
  const a = start(t, {
    command: (dir) => {
      const home = path.join(dir, "home");
      fs.mkdirSync(path.join(home, ".local/lib/elpis-next"), { recursive: true });
      fs.symlinkSync(ENGINE, path.join(home, ".local/lib/elpis-next/elpis-next"));
      fs.mkdirSync(path.join(home, "Desktop/p/Elpis-wt-acp/tools"), { recursive: true });
      fs.symlinkSync(path.dirname(AGENT), path.join(home, "Desktop/p/Elpis-wt-acp/tools/elpis-claude"));
      // ELPIS_ENGINE_BIN is the wrapper's to set, from HOME; an inherited one must not decide the engine.
      return { argv: ["bash", path.join(path.dirname(AGENT), "elpis-wrapper"), "acp", "--model", "wrapped-model"], env: { HOME: home, ELPIS_ENGINE_BIN: "/nonexistent/elpis" } };
    },
  });
  const { sessionId } = await a.open();
  assert.equal((await a.prompt(sessionId, "through the wrapper")).stopReason, "end_turn");
  assert.equal(a.text(), "Answer from wrapped-model: through the wrapper");
});
