import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";
import { createTestTempDir,removeTestTempDir } from "../apps/elpis-desktop/tests/temp-root.cts";
import { wireObject } from "../tools/elpis-claude/bridge-wire.mts";
import type { ThreadItem } from "../codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts";
import type { CollaborationMode } from "../codex-rs/app-server-protocol/schema/typescript/CollaborationMode.ts";
import type { ThreadResumeInitialTurnsPageParams } from "../codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeInitialTurnsPageParams.ts";
import { readClientRequest } from "../tools/elpis-claude/bridge-client-protocol.mts";

const WebSocketClient: typeof WebSocket = createRequire(new URL("../tools/elpis-claude/package.json", import.meta.url))("ws");

if (process.env.BRIDGE_ENVELOPE_ENGINE === "1") {
  const send = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
  const reasoning: Extract<ThreadItem, { type: "reasoning" }> = { type: "reasoning", id: "thought", summary: ["Summary"], content: ["Native reasoning"] };
  const history = (threadId: unknown) => typeof threadId === "string" && threadId.includes("reasoning")
    ? [{ id: "native-turn", status: "completed", items: [{ ...reasoning, ...(threadId === "broken-reasoning" ? { content: [42] } : {}) }] }]
    : threadId === "broken-user" ? [{ id: "native-turn", items: [{ type: "userMessage", content: ["not input blocks"] }] }] : [];
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const msg: unknown = JSON.parse(line);
    if (!wireObject(msg) || msg.id === undefined) return;
    fs.appendFileSync(process.env.BRIDGE_ENVELOPE_TRACE ?? "", `${JSON.stringify(msg)}\n`);
    if (msg.method === "fixture/probe") {
      send({ method: "thread/name/updated", params: null });
      send({ method: "fixture/event", params: { extra: { retained: true } } });
      send({ id: msg.id, result: { opaque: ["kept", { nested: true }] } });
    } else if ((msg.method === "thread/read" || msg.method === "thread/resume") && wireObject(msg.params) && typeof msg.params.threadId === "string") {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId, cwd: msg.params.threadId === "broken" ? 42 : "/valid", recencyAt: null, turns: history(msg.params.threadId) } } });
    } else if (msg.method === "thread/turns/list") {
      send({ id: msg.id, result: { data: history(wireObject(msg.params) ? msg.params.threadId : undefined), nextCursor: null } });
    } else if (msg.method === "thread/items/list") {
      const turns = history(wireObject(msg.params) ? msg.params.threadId : undefined);
      send({ id: msg.id, result: { data: turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: null, completedAtMs: null }))), nextCursor: null } });
    } else send({ id: msg.id, result: {} });
  });
} else {
  test("client null overrides follow the native collaboration and history schemas", () => {
    const collaborationMode: CollaborationMode = { mode: "plan", settings: { model: "claude/sonnet", reasoning_effort: null, developer_instructions: null } };
    const initialTurnsPage: ThreadResumeInitialTurnsPageParams = { limit: null, sortDirection: null, itemsView: null };
    const request = (params: object) => readClientRequest({ id: "native-client", method: "thread/resume", params: { threadId: "chat", ...params } });
    assert.deepEqual(request({ collaborationMode })?.params.collaborationMode, collaborationMode);
    assert.deepEqual(request({ initialTurnsPage })?.params.initialTurnsPage, initialTurnsPage);
    assert.deepEqual(request({ collaborationMode: null })?.params, { threadId: "chat" });
    assert.equal(request({ collaborationMode: { ...collaborationMode, settings: { ...collaborationMode.settings, developer_instructions: 42 } } }), null);
    assert.equal(request({ initialTurnsPage: { ...initialTurnsPage, limit: "25" } }), null);
  });

  test("global requests and unknown engine events survive malformed neighbouring events", { timeout: 20000 }, async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), "elpis-envelope-"));
    const engine = path.join(root, "engine.mjs"), trace = path.join(root, "trace"), log = path.join(root, "bridge.log");
    fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(fileURLToPath(import.meta.url))};\n`, { mode: 0o755 });
    fs.writeFileSync(trace, "");
    fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify(Object.fromEntries(["valid", "broken", "reasoning", "broken-reasoning", "broken-user"].map(id => [id, { providerHistory: true }]))));
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
    socket = new WebSocketClient(`ws://127.0.0.1:${port}`);
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
    const reasoning = await call("thread/read", { threadId: "reasoning", includeTurns: true });
    assert.ok(wireObject(reasoning.result) && wireObject(reasoning.result.thread), JSON.stringify(reasoning));
    assert.deepEqual(reasoning.result.thread.turns, [{ id: "native-turn", status: "completed", items: [{ type: "reasoning", id: "thought", summary: ["Summary"], content: ["Native reasoning"] }] }]);
    for (const method of ["thread/turns/list", "thread/items/list"]) {
      const page = await call(method, { threadId: "reasoning", itemsView: "full" });
      assert.ok(wireObject(page.result) && Array.isArray(page.result.data), JSON.stringify(page));
      const first = page.result.data[0];
      assert.ok(wireObject(first));
      assert.deepEqual(method === "thread/items/list" ? first.item : Array.isArray(first.items) && first.items[0], { type: "reasoning", id: "thought", summary: ["Summary"], content: ["Native reasoning"] });
    }
    const resumed = await call("thread/resume", { threadId: "reasoning", initialTurnsPage: { limit: null, sortDirection: null, itemsView: null } });
    assert.ok(wireObject(resumed.result) && wireObject(resumed.result.initialTurnsPage), JSON.stringify(resumed));
    assert.ok(Array.isArray(resumed.result.initialTurnsPage.data) && resumed.result.initialTurnsPage.data.length === 1);
    for (const threadId of ["broken-reasoning", "broken-user"]) {
      const invalid = await call("thread/read", { threadId, includeTurns: true });
      assert.ok(wireObject(invalid.error) && typeof invalid.error.message === "string" && invalid.error.message.includes("Invalid engine response"), JSON.stringify(invalid));
    }
    assert.ok((await call("fixture/after", {})).result);
    assert.ok(!fs.readFileSync(trace, "utf8").includes('"method":"workflowRun/list"'));
  });
}
