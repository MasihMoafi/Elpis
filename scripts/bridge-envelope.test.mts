import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "../tools/elpis-claude/node_modules/ws/wrapper.mjs";
import { createTestTempDir,removeTestTempDir } from "../apps/elpis-desktop/tests/temp-root.cts";
import { wireObject } from "../tools/elpis-claude/bridge-wire.mts";

if (process.env.BRIDGE_ENVELOPE_ENGINE === "1") {
  const send = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const msg: unknown = JSON.parse(line);
    if (!wireObject(msg) || msg.id === undefined) return;
    fs.appendFileSync(process.env.BRIDGE_ENVELOPE_TRACE ?? "", `${JSON.stringify(msg)}\n`);
    if (msg.method === "fixture/probe") {
      send({ method: "thread/name/updated", params: null });
      send({ method: "fixture/event", params: { extra: { retained: true } } });
      send({ id: msg.id, result: { opaque: ["kept", { nested: true }] } });
    } else if (msg.method === "thread/read" && wireObject(msg.params) && typeof msg.params.threadId === "string") {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId, cwd: msg.params.threadId === "broken" ? 42 : "/valid", recencyAt: null, turns: [] } } });
    } else if (msg.method === "thread/turns/list") {
      send({ id: msg.id, result: { data: [], nextCursor: null } });
    } else send({ id: msg.id, result: {} });
  });
} else {
  test("global requests and unknown engine events survive malformed neighbouring events", { timeout: 20000 }, async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), "elpis-envelope-"));
    const engine = path.join(root, "engine.mjs"), trace = path.join(root, "trace"), log = path.join(root, "bridge.log");
    fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(fileURLToPath(import.meta.url))};\n`, { mode: 0o755 });
    fs.writeFileSync(trace, "");
    fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({ valid: { providerHistory: true }, broken: { providerHistory: true } }));
    const bridge = process.env.ELPIS_ENVELOPE_TEST_BRIDGE ?? fileURLToPath(new URL("../tools/elpis-claude/acp-bridge.mts", import.meta.url));
    const child = spawn(process.execPath, [bridge], { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: {
      PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
      ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: log,
      ACP_BRIDGE_NO_AGENTS: "1", ELPIS_NO_AGY: "1", PORT: "0", BRIDGE_ENVELOPE_ENGINE: "1", BRIDGE_ENVELOPE_TRACE: trace,
    } });
    let stderr = "", socket: WebSocket | undefined;
    child.stderr.on("data", chunk => { stderr += chunk; });
    t.after(async () => {
      socket?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited; clearTimeout(timer);
      }
      removeTestTempDir(root);
    });
    const until = async (ready: () => boolean) => {
      const deadline = Date.now() + 7000;
      while (!ready()) { assert.ok(Date.now() < deadline, stderr); await pause(10); }
    };
    await until(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, "utf8")));
    const port = /LISTENING (\d+)/.exec(fs.readFileSync(log, "utf8"))?.[1];
    assert.ok(port);
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(socket, "open");
    const pending = new Map<number, (value: Record<string, unknown>) => void>(), events: Record<string, unknown>[] = [];
    let id = 0;
    socket.on("message", data => {
      const msg: unknown = JSON.parse(String(data));
      if (!wireObject(msg)) return;
      const resolve = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (resolve && typeof msg.id === "number") { pending.delete(msg.id); resolve(msg); }
      else events.push(msg);
    });
    const call = (method: string, params: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out: ${stderr}`)); }, 4000);
      pending.set(next, value => { clearTimeout(timer); resolve(value); });
      socket?.send(JSON.stringify({ id: next, method, params }));
    });
    assert.ok((await call("initialize", { clientInfo: { name: "fixture", version: "1" } })).result);
    const workflows = await call("workflowRun/list", { threadId: null });
    assert.ok(wireObject(workflows.result) && Array.isArray(workflows.result.data));
    const reply = await call("fixture/probe", { marker: "global" });
    assert.deepEqual(reply.result, { opaque: ["kept", { nested: true }] });
    assert.ok(events.some(event => event.method === "thread/name/updated" && event.params === null));
    assert.ok(events.some(event => event.method === "fixture/event" && wireObject(event.params) && wireObject(event.params.extra) && event.params.extra.retained === true));
    const valid = await call("thread/read", { threadId: "valid", includeTurns: true, cwd: null, approvalPolicy: null, sandboxPolicy: null });
    assert.ok(wireObject(valid.result) && wireObject(valid.result.thread) && valid.result.thread.id === "valid");
    const invalid = await call("thread/read", { threadId: "broken", includeTurns: true });
    assert.ok(wireObject(invalid.error) && typeof invalid.error.message === "string" && invalid.error.message.includes("Invalid engine response"));
    assert.ok((await call("fixture/after", {})).result);
    assert.ok(!fs.readFileSync(trace, "utf8").includes('"method":"workflowRun/list"'));
  });
}
