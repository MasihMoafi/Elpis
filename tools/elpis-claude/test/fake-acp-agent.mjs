#!/usr/bin/env node
// A scripted ACP agent built on the official SDK, for tests of ACP clients. No model calls.
// Environment: FAKE_ACP_LOG (every request and notification it receives, as JSON lines), FAKE_ACP_NAME (its name in
// answers), FAKE_ACP_MODELS (comma-separated values of a `model` config option it offers), FAKE_ACP_BACKGROUND_RELEASE
// (a file whose creation finishes a "[background]" prompt's job).
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
    // As Claude Code: an effort applies at once, also to a running prompt.
    if (params.configId === "effort") { s.effort = params.value; return { configOptions: [modelOption(s.model)] }; }
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
  .onRequest("session/fork", ({ params }) => {
    log({ method: "session/fork", params });
    return { sessionId: `${params.sessionId}-fork` };
  })
  .onRequest("session/set_mode", () => ({}))
  .onRequest("_session/steering", params => params, async ({ params }) => {
    log({ method: "_session/steering", params });
    const s = sessions.get(params.sessionId);
    if (!s?.running) return { outcome: "promptRequired", reason: "noRunningTurn" };
    // Claude's immediate steering interrupts foreground tools. Model that consequence,
    // rather than silently accepting an unsafe steer as the older fixture did.
    if (s.rejectToolSteers && s.tool) {
      log({ interruptedTool: s.tool, error: "The user doesn't want to proceed with this tool use" });
      s.stopped = true;
    }
    s.steers.push(params.prompt.filter(b => b.type === "text").map(b => b.text).join("\n"));
    if (process.env.FAKE_ACP_STEER_DELAY) await pause(Number(process.env.FAKE_ACP_STEER_DELAY));
    return { outcome: "injected" };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    log({ method: "session/prompt", params });
    const s = sessions.get(params.sessionId);
    s.running = true;
    s.steers = [];
    s.stopped = false;
    s.cancelled = () => { s.stopped = true; };
    const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    s.rejectToolSteers = text.includes("[tool-race]") || text.includes("[tool-gap]");
    const say = (update) => client.notify("session/update", { sessionId: params.sessionId, update });
    const chunk = (messageId, body, meta) => say({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: body }, ...(meta ? { _meta: meta } : {}) });
    if (text.includes("[crash]")) { process.stderr.write("fake agent crashed on purpose\n"); await pause(10); process.exit(5); }
    if (text.includes("[refuse]")) return { stopReason: "refusal" };
    if (text.includes("[empty]")) return { stopReason: "end_turn" };
    if (text.includes("[commentary-only]")) { await chunk("c1", "Only progress.", { elpis: { phase: "commentary" } }); return { stopReason: "end_turn" }; }
    await chunk("m1", "Thinking about it.");
    s.tool = "t1";
    await say({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read notes", kind: "read", status: "in_progress" });
    log({ toolStarted: "t1" });
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
    if (text.includes("[tool-flight]")) while (!s.stopped && !fs.existsSync(process.env.FAKE_ACP_TOOL_RELEASE)) await pause(10);
    if (s.stopped) { s.running = false; return { stopReason: "cancelled" }; }
    if (s.rejectToolSteers) {
      // A single transport read can contain the end of one tool and the start of
      // the next. There is no idle slot in which an immediate steer is safe.
      const updates = [
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
        { sessionUpdate: "tool_call", toolCallId: "t2", title: "Second slow tool", kind: "execute", status: "in_progress", rawInput: { command: "second-slow-tool" }, _meta: { claudeCode: { toolName: "Bash" } } },
      ];
      if (text.includes("[tool-gap]")) {
        s.tool = null;
        await say(updates[0]);
        log({ betweenTools: true });
        while (!s.stopped && !fs.existsSync(process.env.FAKE_ACP_BETWEEN_TOOL_RELEASE)) await pause(10);
        if (s.stopped) { s.running = false; return { stopReason: "cancelled" }; }
        s.tool = "t2";
        await say(updates[1]);
      } else {
        s.tool = "t2";
        process.stdout.write(updates.map(update => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } }) + "\n").join(""));
      }
      log({ toolCompleted: "t1" });
      log({ toolStarted: "t2" });
      while (!s.stopped && !fs.existsSync(process.env.FAKE_ACP_NEXT_TOOL_RELEASE)) await pause(10);
      await say({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: s.stopped ? "failed" : "completed" });
      if (s.stopped) { s.running = false; return { stopReason: "cancelled" }; }
      log({ toolCompleted: "t2" });
    } else {
      await say({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      log({ toolCompleted: "t1" });
    }
    s.tool = null;
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
    if (text.includes("[wait]")) while (!s.stopped && !fs.existsSync(process.env.FAKE_ACP_RELEASE)) await pause(10);
    if (s.stopped) { s.running = false; return { stopReason: "cancelled" }; }
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
    // A background job that finishes after the reply: Claude reports it on its own, outside any prompt.
    if (text.includes("[background]")) void (async () => {
      while (!fs.existsSync(process.env.FAKE_ACP_BACKGROUND_RELEASE)) await pause(10);
      await chunk("bg1", "The background build finished.");
      await say({ sessionUpdate: "usage_update", used: 10, size: 1000, _meta: { "_claude/origin": { kind: "task-notification" } } });
    })();
    s.running = false;
    log({ ended: params.sessionId, answer });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", ({ params }) => { log({ method: "session/cancel", params }); const s = sessions.get(params.sessionId); if (s) s.stopped = true; s?.cancelled?.(); });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
connection.closed.then(() => { log({ closed: true }); process.exit(0); });
