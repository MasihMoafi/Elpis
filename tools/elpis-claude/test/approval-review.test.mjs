import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';
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
import WebSocket from "../node_modules/ws/wrapper.mjs";
import { connect } from "node:net";

const self = fileURLToPath(import.meta.url);
const role = process.env.APPROVAL_FIXTURE_ROLE;
if (role) {
  const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
  const record = msg => fs.appendFileSync(process.env.APPROVAL_TRACE, JSON.stringify({ role, ...msg }) + "\n");
  if (role === "agy" && process.argv.includes("models")) {
    process.stdout.write("fixture\tFixture Gemini\n");
    process.exit(0);
  }
  if (role === "agy") send({ event: "init", conversation_id: `fixture-${process.pid}` });
  readline.createInterface({ input: process.stdin }).on("line", async line => {
    const msg = JSON.parse(line); record(msg);
    if (role === "agy") {
      const socket = connect(process.env.ELPIS_AGY_GATE);
      await once(socket, "connect");
      socket.write(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "echo review-fixture" } } }) + "\n");
      let reply = "";
      socket.on("data", data => { reply += data; });
      await once(socket, "end");
      record({ selection: JSON.parse(reply) });
      send({ event: "result", result: {} });
      return;
    }
    if (role === "acp" && msg.id === "permission") {
      send({ id: JSON.parse(process.env.APPROVAL_PROMPT_ID), result: { stopReason: "end_turn" } }); return;
    }
    if (msg.id === undefined) return;
    let result = {};
    if (role === "engine") {
      // Full access is what a new chat gets by default (apps/elpis-desktop bridge/client.mjs createThread).
      if (msg.method === "thread/resume") result = { thread: { id: "chat", cwd: process.env.HOME, turns: [] }, model: "gpt-test", ...(process.env.APPROVAL_FULL === "1"
        ? { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" } }
        : { approvalPolicy: "on-request", approvalsReviewer: process.env.APPROVAL_REVIEWER, sandbox: { type: "workspaceWrite" } }) };
      if (msg.method === "thread/read") result = { thread: { id: "chat", cwd: process.env.HOME, turns: [] } };
      if (msg.method === "thread/turns/list") result = { data: [], nextCursor: null };
      if (msg.method === "thread/approval/review") {
        if (process.env.APPROVAL_DECISION === "error") { send({ id: msg.id, error: { code: -32603, message: "review fixture unavailable" } }); return; }
        result = { decision: process.env.APPROVAL_DECISION, rationale: "fixture guardian rationale" };
      }
    } else {
      if (["session/new", "session/load"].includes(msg.method)) result = { sessionId: "session" };
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
  for (const label of ["full", "approved", "denied", "error", "malformed", "plan", "manual", "agy-approved", "agy-denied", "agy-error"]) {
    const agy = label.startsWith("agy-"), scenario = label.replace(/^agy-/, "");
    test(`bridged permission review: ${label}`, { timeout: 15000 }, async t => {
      const root = createTestTempDir(path.join(os.tmpdir(), "elpis-approval-"));
      const trace = path.join(root, "trace"), log = path.join(root, "log");
      fs.writeFileSync(trace, "");
      fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({ chat: { model: agy ? "agy/fixture" : "claude/haiku", turns: [] } }));
      const wrapper = (name, fixtureRole) => {
        const target = path.join(root, name);
        fs.writeFileSync(target, `#!${process.execPath}\nprocess.env.APPROVAL_FIXTURE_ROLE=${JSON.stringify(fixtureRole)}; await import(${JSON.stringify(self)});\n`, { mode: 0o755 });
        return target;
      };
      const engine = wrapper("engine.mjs", "engine"), adapter = wrapper("adapter.mjs", "acp");
      const agyBin = wrapper("agy.mjs", "agy");
      const child = spawn(process.execPath, [process.env.APPROVAL_TEST_BRIDGE ?? fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url))], {
        cwd: root, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
          ELPIS_ENGINE_BIN: engine, ACP_ADAPTER: adapter, ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: log,
          ELPIS_NO_AGY: agy ? "" : "1", AGY_BIN: agyBin, AGY_DEFAULT_MODEL: "fixture", ACP_BRIDGE_NO_AGENTS: "1", PORT: "0", APPROVAL_TRACE: trace,
          APPROVAL_REVIEWER: scenario === "manual" ? "user" : "auto_review", APPROVAL_PLAN: scenario === "plan" ? "1" : "0", APPROVAL_FULL: scenario === "full" ? "1" : "0",
          APPROVAL_DECISION: scenario === "malformed" ? "unexpected" : scenario },
      });
      let stderr = "", socket;
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
      const until = async (predicate, label) => {
        const deadline = Date.now() + 8000;
        while (!predicate()) { assert.ok(Date.now() < deadline, `${label}: ${stderr}\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-1500) : ""}`); await pause(10); }
      };
      await until(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, "utf8")), "startup");
      socket = new WebSocket(`ws://127.0.0.1:${fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/)[1]}`);
      await once(socket, "open");
      const seen = [], pending = new Map(); let seq = 0;
      socket.on("message", data => {
        const msg = JSON.parse(String(data)); seen.push(msg);
        if (msg.method && msg.id !== undefined) socket.send(JSON.stringify({ id: msg.id, result: { decision: "accept" } }));
        else if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      });
      const call = (method, params) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
      await call("initialize", { clientInfo: { name: "approval_fixture", version: "1" }, capabilities: { experimentalApi: true } });
      assert.ifError((await call("thread/resume", { threadId: "chat", excludeTurns: true })).error);
      assert.ifError((await call("turn/start", { threadId: "chat", input: [{ type: "text", text: "Do the fixture" }] })).error);
      const records = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      await until(() => records().some(row => agy ? row.role === "agy" && row.selection : row.role === "acp" && row.id === "permission" && row.result), "permission result");
      const rows = records(), review = rows.filter(row => row.method === "thread/approval/review");
      const asks = seen.filter(row => row.method === "item/commandExecution/requestApproval");
      assert.equal(review.length, ["plan", "manual", "full"].includes(scenario) ? 0 : 1);
      assert.equal(asks.length, ["approved", "denied", "full"].includes(scenario) ? 0 : 1, "Full access never asks the person");
      if (agy) assert.equal(rows.find(row => row.role === "agy" && row.selection).selection.allowed, scenario !== "denied");
      else {
        const selection = rows.find(row => row.role === "acp" && row.id === "permission" && row.result).result.outcome;
        assert.equal(selection.optionId, scenario === "denied" ? "reject" : scenario === "plan" ? "exit-plan-default" : "allow");
      }
      if (review.length) assert.deepEqual(review[0].params, { threadId: "chat", command: "echo review-fixture", cwd: root, reason: `${agy ? "Gemini" : "Claude"} wants to run: echo review-fixture` });
      if (scenario === "error") assert.match(asks[0].params.reason, /review fixture unavailable/);
      if (scenario === "denied") assert.ok(seen.some(row => row.method === "item/agentMessage/delta" && row.params.delta.includes("fixture guardian rationale")));
      // Full access is Claude Code's bypassPermissions (it has no sandbox of its own to keep).
      if (!agy) assert.ok(rows.some(row => row.method === "session/set_mode" && row.params.modeId === ({ manual: "acceptEdits", full: "bypassPermissions" }[scenario] ?? "auto")));
    });
  }
}
