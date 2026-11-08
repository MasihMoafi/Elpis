import { createTestTempDir, removeTestTempDir } from './temp-root.mts';
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import WebSocket from "ws";
import { connect } from "node:net";

type Message = {
  id?: string | number;
  method?: string;
  error?: unknown;
  result?: { outcome?: { optionId?: string } };
  params?: { reason?: string; delta?: string; modeId?: string; tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number };
    mcpServers?: { name: string }[]; _meta?: { claudeCode?: { options?: { tools?: string[]; env?: Record<string, string> } }; systemPrompt?: { append?: string } } };
};
type Trace = Message & { role?: string; selection?: { allowed?: boolean } };

const self = fileURLToPath(import.meta.url);
const role = process.env.APPROVAL_FIXTURE_ROLE;
if (role) {
  const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
  const trace = process.env.APPROVAL_TRACE;
  assert.ok(trace !== undefined);
  const record = (msg: object) => fs.appendFileSync(trace, JSON.stringify({ role, ...msg }) + "\n");
  if (role === "agy" && process.argv.includes("models")) {
    process.stdout.write("fixture\tFixture Gemini\n");
    process.exit(0);
  }
  if (role === "agy") send({ event: "init", conversation_id: `fixture-${process.pid}` });
  readline.createInterface({ input: process.stdin }).on("line", async line => {
    const msg: Message = JSON.parse(line); record(msg);
    if (role === "agy") {
      if (!process.env.ELPIS_AGY_GATE) {
        record({ selection: { allowed: true } });
        send({ event: "result", result: {} });
        return;
      }
      const socket = connect(process.env.ELPIS_AGY_GATE);
      await once(socket, "connect");
      socket.write(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "echo review-fixture" } } }) + "\n");
      let reply = "";
      socket.on("data", data => { reply += data; });
      await once(socket, "end");
      record({ selection: JSON.parse(reply) });
      send({ event: "step_update", agent_state: { context_window_usage: {
        estimated_tokens_used: 238336, max_context_tokens: 256000,
      } }, step_update: { step_type: "agent_response", text_delta: "fixture", usage: { input_tokens: 2800, output_tokens: 60 } } });
      send({ event: "result", result: {} });
      return;
    }
    if (role === "acp" && msg.id === "permission") {
      const promptId = process.env.APPROVAL_PROMPT_ID;
      assert.ok(promptId !== undefined);
      send({ id: JSON.parse(promptId), result: { stopReason: "end_turn" } }); return;
    }
    if (msg.id === undefined) return;
    let result = {};
    if (role === "engine") {
      if (process.env.APPROVAL_READ_ONLY === "1" && msg.method === "config/read") result = { config: { approval_policy: "never", default_permissions: ":read-only" } };
      // Full access is what a new chat gets by default (apps/elpis-desktop bridge/client.mts createThread).
      if (msg.method === "thread/resume") result = { thread: { id: "chat", cwd: process.env.HOME, turns: [] }, model: "gpt-test", ...(process.env.APPROVAL_FULL === "1"
        ? { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" } }
        : { approvalPolicy: "on-request", approvalsReviewer: process.env.APPROVAL_REVIEWER, sandbox: { type: "workspaceWrite" } }) };
      if (process.env.APPROVAL_READ_ONLY === "1" && msg.method === "thread/resume") Object.assign(result, { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly" }, activePermissionProfile: { id: ":read-only" } });
      if (msg.method === "thread/read") result = { thread: { id: "chat", cwd: process.env.HOME, turns: [] } };
      if (process.env.APPROVAL_MOTHER === "1" && msg.method === "thread/elpisInstructions/read") result = { developerInstructions: "engine fallback instructions" };
      if (msg.method === "thread/turns/list") result = { data: [], nextCursor: null };
      if (msg.method === "thread/approval/review") {
        if (process.env.APPROVAL_DECISION === "error") { send({ id: msg.id, error: { code: -32603, message: "review fixture unavailable" } }); return; }
        result = { decision: process.env.APPROVAL_DECISION, rationale: "fixture guardian rationale" };
      }
    } else {
      if (["session/new", "session/load"].includes(msg.method ?? "")) result = { sessionId: "session" };
      if (msg.method === "session/prompt") {
        const options = process.env.APPROVAL_PLAN === "1"
          ? [{ kind: "allow_once", optionId: "exit-plan-default" }, { kind: "reject_once", optionId: "reject" }]
          : [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "reject" }];
        send({ id: "permission", method: "session/request_permission", params: { sessionId: "session", toolCall: { toolCallId: "tool", title: "echo review-fixture" }, options } });
        // The adapter receives the bridge's selected option before finishing the turn.
        process.env.APPROVAL_PROMPT_ID = JSON.stringify(msg.id);
        return;
      }
    }
    send({ id: msg.id, result });
  });
} else {
  for (const label of ["full", "approved", "denied", "error", "malformed", "plan", "manual", "mother", "agy-full", "agy-approved", "agy-denied", "agy-error", "agy-read-only"]) {
    const agy = label.startsWith("agy-"), scenario = label.replace(/^agy-/, "");
    test(`bridged permission review: ${label}`, { timeout: 15000 }, async t => {
      const root = createTestTempDir(path.join(os.tmpdir(), "elpis-approval-"));
      const trace = path.join(root, "trace"), log = path.join(root, "log");
      fs.writeFileSync(trace, "");
      fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({ chat: { model: agy ? "agy/fixture" : "claude/haiku", turns: [] } }));
      const wrapper = (name: string, fixtureRole: string) => {
        const target = path.join(root, name);
        fs.writeFileSync(target, `#!${process.execPath}\nprocess.env.APPROVAL_FIXTURE_ROLE=${JSON.stringify(fixtureRole)}; await import(${JSON.stringify(self)});\n`, { mode: 0o755 });
        return target;
      };
      const engine = wrapper("engine.mjs", "engine"), adapter = wrapper("adapter.mjs", "acp");
      const agyBin = wrapper("agy.mjs", "agy");
      const child = spawn(process.execPath, [process.env.APPROVAL_TEST_BRIDGE ?? fileURLToPath(new URL("../acp-bridge.mts", import.meta.url))], {
        cwd: root, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
          ELPIS_ENGINE_BIN: engine, ACP_ADAPTER: adapter, ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: log,
          ELPIS_NO_AGY: agy ? "" : "1", AGY_BIN: agyBin, AGY_DEFAULT_MODEL: "fixture", ACP_BRIDGE_NO_AGENTS: "1", PORT: "0", APPROVAL_TRACE: trace,
          APPROVAL_REVIEWER: scenario === "manual" ? "user" : "auto_review", APPROVAL_PLAN: scenario === "plan" ? "1" : "0", APPROVAL_FULL: scenario === "full" ? "1" : "0",
          APPROVAL_MOTHER: scenario === "mother" ? "1" : "0", GH_TOKEN: "fixture-gh-token", GITHUB_TOKEN: "fixture-github-token",
          APPROVAL_READ_ONLY: scenario === "read-only" ? "1" : "0",
          APPROVAL_DECISION: scenario === "malformed" ? "unexpected" : scenario },
      });
      let stderr = "", socket: WebSocket | undefined;
      child.stderr.on("data", data => { stderr += data; });
      t.after(async () => {
        socket?.close();
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit"); child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
          await exited; clearTimeout(timer);
        }
        removeTestTempDir(root);
      });
      const until = async (predicate: () => unknown, label: string) => {
        const deadline = Date.now() + 8000;
        while (!predicate()) { assert.ok(Date.now() < deadline, `${label}: ${stderr}\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-1500) : ""}`); await pause(10); }
      };
      await until(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, "utf8")), "startup");
      const match = fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/);
      assert.ok(match?.[1]);
      const connection = socket = new WebSocket(`ws://127.0.0.1:${match[1]}`);
      await once(connection, "open");
      const seen: Message[] = [], pending = new Map<string | number, (message: Message) => void>(); let seq = 0;
      connection.on("message", data => {
        const msg: Message = JSON.parse(String(data)); seen.push(msg);
        if (msg.method && msg.id !== undefined) connection.send(JSON.stringify({ id: msg.id, result: { decision: "accept" } }));
        else if (msg.id !== undefined) { const resolve = pending.get(msg.id); if (resolve) { resolve(msg); pending.delete(msg.id); } }
      });
      const call = (method: string, params: object) => new Promise<Message>(resolve => { const id = ++seq; pending.set(id, resolve); connection.send(JSON.stringify({ id, method, params })); });
      await call("initialize", { clientInfo: { name: "approval_fixture", version: "1" }, capabilities: { experimentalApi: true } });
      const config = scenario === "mother" ? {
        "mcp_servers.elpis_mother": { command: "fixture-mother", args: [], env: {} },
        "shell_environment_policy.set": { ELPIS_MOTHER_ROLE: "orchestrator", MOTHER_TEST_VALUE: "kept" },
      } : undefined;
      assert.ifError((await call("thread/resume", { threadId: "chat", excludeTurns: true, ...(config ? { config } : {}) })).error);
      const collaborationMode = scenario === "mother" ? { settings: { developer_instructions: "Mother-owned instructions" } } : undefined;
      assert.ifError((await call("turn/start", { threadId: "chat", input: [{ type: "text", text: "Do the fixture" }], ...(collaborationMode ? { collaborationMode } : {}) })).error);
      const records = (): Trace[] => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      await until(() => records().some(row => agy ? row.role === "agy" && row.selection : row.role === "acp" && row.id === "permission" && row.result), "permission result");
      if (agy) await until(() => seen.some(row => row.method === "thread/tokenUsage/updated" && row.params?.tokenUsage?.last?.totalTokens === 238336), "Gemini context usage");
      const rows = records(), review = rows.filter(row => row.method === "thread/approval/review");
      if (scenario === "mother") {
        const session = rows.find(row => row.role === "acp" && row.method === "session/new");
        assert.ok(session, "Mother session reached the provider adapter");
        const params = session.params;
        assert.ok(params?.mcpServers);
        const options = params._meta?.claudeCode?.options, prompt = params._meta?.systemPrompt?.append;
        assert.ok(options && prompt !== undefined);
        assert.deepEqual(params.mcpServers.map(server => server.name), ["elpis_mother"]);
        assert.deepEqual(options.tools, []);
        assert.deepEqual(options.env, { ELPIS_MOTHER_ROLE: "orchestrator", MOTHER_TEST_VALUE: "kept", GH_TOKEN: "", GITHUB_TOKEN: "" });
        assert.match(prompt, /Mother-owned instructions/);
        assert.doesNotMatch(prompt, /engine fallback instructions/);
      }
      const asks = seen.filter(row => row.method === "item/commandExecution/requestApproval");
      assert.equal(review.length, ["plan", "manual", "full", "read-only"].includes(scenario) ? 0 : 1);
      assert.equal(asks.length, ["approved", "denied", "full", "read-only"].includes(scenario) ? 0 : 1, "Full access and scoped never-ask modes never ask the person");
      if (agy) {
        const selection = rows.find(row => row.role === "agy" && row.selection)?.selection;
        assert.ok(selection);
        assert.equal(selection.allowed, !["denied", "read-only"].includes(scenario));
      }
      else {
        const selection = rows.find(row => row.role === "acp" && row.id === "permission" && row.result)?.result?.outcome;
        assert.ok(selection);
        assert.equal(selection.optionId, scenario === "denied" ? "reject" : scenario === "plan" ? "exit-plan-default" : "allow");
      }
      if (review.length) assert.deepEqual(review[0]?.params, { threadId: "chat", command: "echo review-fixture", cwd: root, reason: `${agy ? "Gemini" : "Claude"} wants to run: echo review-fixture` });
      if (scenario === "error") { const reason = asks[0]?.params?.reason; assert.ok(reason); assert.match(reason, /review fixture unavailable/); }
      if (scenario === "denied") assert.ok(seen.some(row => row.method === "item/agentMessage/delta" && row.params?.delta?.includes("fixture guardian rationale")));
      if (agy) {
        const context = seen.find(row => row.method === "thread/tokenUsage/updated" && row.params?.tokenUsage?.last?.totalTokens === 238336)?.params?.tokenUsage;
        assert.equal(context?.last?.totalTokens, 238336, "Gemini usage is its current request context, not the step sum");
        assert.equal(context?.modelContextWindow, 256000, "Gemini's reported context window reaches the desktop");
      }
      // Full access uses the normal permission hook, answered by Elpis without asking the person.
      const modes: Record<string, string> = { mother: "bypassPermissions", manual: "acceptEdits", full: "default" };
      if (!agy) assert.ok(rows.some(row => row.method === "session/set_mode" && row.params?.modeId === (modes[scenario] ?? "auto")));
    });
  }
}
