#!/usr/bin/env node
// A scripted ACP agent built on the official SDK, for tests of ACP clients. No model calls.
// Environment: FAKE_ACP_LOG (every request and notification it receives, as JSON lines), FAKE_ACP_NAME (its name in
// answers), FAKE_ACP_MODELS (comma-separated values of a `model` config option it offers).
// A prompt is answered `<name>(<model>) answered: <prompt text>` after a progress message and a tool call; markers in
// the prompt change that: [permission] asks permission first, [hang] waits for session/cancel, [ignore-cancel] never
// ends, [crash] exits with code 5, [empty] answers nothing, [commentary-only] answers only Elpis commentary,
// [refuse] stops with `refusal`.
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";

const name = process.env.FAKE_ACP_NAME ?? "fake";
const models = (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean);
const log = (entry) => { if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + "\n"); };
const sessions = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const modelOption = (current) => ({ id: "model", name: "Model", type: "select", currentValue: current, options: models.map((value) => ({ value, name: value })) });

const app = agent({ name: "fake-acp-agent" })
  .onRequest("initialize", ({ params }) => { log({ method: "initialize", params }); return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake-acp-agent", version: "0" } }; })
  .onRequest("session/new", ({ params }) => {
    log({ method: "session/new", params });
    const sessionId = `${name}-session-${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: params.cwd, model: models[0] ?? "default", cancelled: null, running: false, steers: [] });
    return { sessionId, ...(models.length ? { configOptions: [modelOption(models[0])] } : {}) };
  })
  .onRequest("session/set_config_option", ({ params }) => {
    log({ method: "session/set_config_option", params });
    const s = sessions.get(params.sessionId);
    if (params.configId !== "model" || !models.includes(params.value)) throw new Error(`unknown option ${params.configId}=${params.value}`);
    s.model = params.value;
    return { configOptions: [modelOption(s.model)] };
  })
  .onRequest("session/load", ({ params }) => {
    log({ method: "session/load", params });
    if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, { cwd: params.cwd, model: models[0] ?? "default", cancelled: null, running: false, steers: [] });
    const s = sessions.get(params.sessionId);
    return { ...(models.length ? { configOptions: [modelOption(s.model)] } : {}) };
  })
  .onRequest("session/set_mode", () => ({}))
  .onRequest("_session/steering", params => params, async ({ params }) => {
    log({ method: "_session/steering", params });
    const s = sessions.get(params.sessionId);
    if (!s?.running) return { outcome: "promptRequired", reason: "noRunningTurn" };
    s.steers.push(params.prompt.filter(b => b.type === "text").map(b => b.text).join("\n"));
    if (process.env.FAKE_ACP_STEER_DELAY) await pause(Number(process.env.FAKE_ACP_STEER_DELAY));
    return { outcome: "injected" };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    log({ method: "session/prompt", params });
    const s = sessions.get(params.sessionId);
    s.running = true;
    s.steers = [];
    const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const say = (update) => client.notify("session/update", { sessionId: params.sessionId, update });
    const chunk = (messageId, body, meta) => say({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: body }, ...(meta ? { _meta: meta } : {}) });
    if (text.includes("[crash]")) { process.stderr.write("fake agent crashed on purpose\n"); await pause(10); process.exit(5); }
    if (text.includes("[refuse]")) return { stopReason: "refusal" };
    if (text.includes("[empty]")) return { stopReason: "end_turn" };
    if (text.includes("[commentary-only]")) { await chunk("c1", "Only progress.", { elpis: { phase: "commentary" } }); return { stopReason: "end_turn" }; }
    await chunk("m1", "Thinking about it.");
    await say({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read notes", kind: "read", status: "in_progress" });
    let permission = "";
    if (text.includes("[permission]")) {
      const answer = await client.request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t1", title: "Write notes.txt", kind: "edit", status: "pending" },
        options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }],
      });
      log({ permission: answer.outcome });
      permission = `permission: ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}. `;
      if (answer.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
    }
    if (text.includes("[tool-flight]")) while (!fs.existsSync(process.env.FAKE_ACP_TOOL_RELEASE)) await pause(10);
    await say({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    if (text.includes("[ignore-cancel]")) await new Promise(() => {});
    if (text.includes("[hang]")) { await new Promise((resolve) => { s.cancelled = resolve; }); return { stopReason: "cancelled" }; }
    if (process.env.FAKE_ACP_WRITE) {
      const { file, text } = JSON.parse(process.env.FAKE_ACP_WRITE);
      fs.writeFileSync(file, text);
    }
    let checked;
    if (process.env.FAKE_ACP_EXPECT) {
      const { file, text } = JSON.parse(process.env.FAKE_ACP_EXPECT);
      const passed = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
      checked = JSON.stringify({ passed, summary: passed ? `Read planted result: ${text}` : 'The planted result did not arrive' });
    }
    if (text.includes("[wait]")) while (!fs.existsSync(process.env.FAKE_ACP_RELEASE)) await pause(10);
    const answer = checked ?? process.env.FAKE_ACP_ANSWER ?? `${name}(${s.model}) answered: ${permission}${[text, ...s.steers].join("\n")}`;
    if (text.includes("[record-only]")) {
      const project = s.cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const directory = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude"), "projects", project);
      fs.mkdirSync(directory, { recursive: true });
      const timestamp = new Date().toISOString();
      const records = [...[text, ...s.steers].map(text => ({ type: "user", timestamp, message: { role: "user", content: [{ type: "text", text }] } })),
        { type: "assistant", timestamp, uuid: "saved-final", message: { id: "saved-final", role: "assistant", content: [{ type: "text", text: answer }], stop_reason: "end_turn" } }];
      fs.appendFileSync(path.join(directory, `${params.sessionId}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
      log({ ended: params.sessionId, answer });
      s.running = false;
      await new Promise(resolve => { s.cancelled = resolve; });
      return { stopReason: "cancelled" };
    }
    await chunk("m2", answer.slice(0, 10));
    await chunk("m2", answer.slice(10));
    s.running = false;
    log({ ended: params.sessionId, answer });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", ({ params }) => { log({ method: "session/cancel", params }); sessions.get(params.sessionId)?.cancelled?.(); });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
connection.closed.then(() => { log({ closed: true }); process.exit(0); });
