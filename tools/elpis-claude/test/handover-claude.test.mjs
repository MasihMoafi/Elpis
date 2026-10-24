import { createTestTempDir, removeTestTempDir } from "./temp-root.mjs";
// A newer bundle is installed while a Claude turn works: it serves new connections within seconds, the turn finishes
// in the old bridge and reaches the desktop client, which reconnects by itself. Real launcher and bridges, scripted
// Claude (fake-acp-agent.mjs) and engine (fake-app-server.mjs); no provider calls.
// Run: node --test tools/elpis-claude/test/handover-claude.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startToken } from "../shared-runtime.mjs";
import WebSocket from "ws";

const { DesktopClient } = await import(new URL("../../../apps/elpis-desktop/bridge/client.mjs", import.meta.url));
const source = fileURLToPath(new URL("..", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(20)) if (await check()) return;
  assert.fail(label);
}

async function fixture(t) {
  const root = createTestTempDir(path.join(os.tmpdir(), "ebh-"));
  const bundle = (name) => {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    for (const file of fs.readdirSync(source).filter((file) => file.endsWith(".mjs") || ["package.json", "package-lock.json"].includes(file))) fs.copyFileSync(path.join(source, file), path.join(dir, file));
    fs.symlinkSync(path.join(source, "node_modules"), path.join(dir, "node_modules"));
    return dir;
  };
  const [first, second] = [bundle("a"), bundle("b")];
  const agentLog = path.join(root, "agent.jsonl"), release = path.join(root, "release");
  fs.mkdirSync(path.join(root, "elpis"));
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: path.join(root, "elpis"), CODEX_HOME: path.join(root, "elpis"), CODEX_AUTH_HOME: root,
    XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root, TMPDIR: root, ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
    ELPIS_ENGINE_BIN: path.join(source, "test/fake-app-server.mjs"), ACP_ADAPTER: path.join(source, "test/fake-acp-agent.mjs"),
    ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: path.join(root, "bridge.log"), FAKE_ENGINE_STATE: path.join(root, "native.json"),
    FAKE_ACP_LOG: agentLog, FAKE_ACP_MODELS: "sonnet", FAKE_ACP_NAME: "Claude", FAKE_ACP_RELEASE: release };
  const launch = async (dir) => {
    const child = spawn(process.execPath, [path.join(dir, "shared-runtime.mjs"), path.join(dir, "acp-bridge.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    await once(child, "exit");
    assert.equal(child.exitCode, 0, err);
    return out.split("\n")[0].trim().replace(/^unix:\/\//, "");
  };
  const socketPath = await launch(first);
  const dir = path.dirname(socketPath), state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "state.json"))); } catch { return {}; } };
  const old = state(), oldAlive = () => startToken(old.pid) === old.token;
  const client = await DesktopClient.connect({ socketPath, timeoutMs: 5000, reconnectDelayMs: 50, rewindHome: path.join(root, "rewind"), archiveDirectory: path.join(root, "archive") });
  const events = [], connection = []; client.on("event", (event) => { if (event.type === "message") events.push(event.data); if (event.type === "connection") connection.push(event.data.connected); });
  t.after(async () => {
    client.close();
    for (const pid of [old.pid, state().pid]) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await pause(300);
    removeTestTempDir(root);
  });
  await client.models();
  const id = (await client.createThread({ model: "claude/sonnet", cwd: root })).thread.id;
  /** Installs the newer bundle and waits until it serves; the old bridge keeps working. */
  const install = async () => {
    const installedAt = Date.now();
    await launch(second);
    await until(() => state().pid && state().pid !== old.pid, "the newer bundle serves while the Claude turn works", 10000);
    t.diagnostic(`hand-over took ${Date.now() - installedAt} ms`);
    assert.ok(oldAlive(), "the old bridge keeps the working turn");
    // The desktop is asked to reconnect and does so by itself, as the app does.
    const from = connection.length;
    await until(() => connection.slice(from).includes(false) && connection.at(-1) === true, "the desktop reconnects to the newer bridge", 10000);
  };
  return { client, events, id, agentLog, release, env, oldAlive, install, socketPath };
}

test("a Claude turn working during an install finishes in the old bridge; the newer one serves within seconds", { timeout: 60000 }, async (t) => {
  const { client, events, id, agentLog, release, env, oldAlive, install } = await fixture(t);
  const { turn } = await client.send(id, { text: "[wait] a long task" });
  await until(() => lines(agentLog).some((e) => e.method === "session/prompt"), "the Claude turn works");
  await install();
  // The desktop reconnects by itself and follows the working chat through the newer bridge.
  assert.equal((await client.resume(id, {})).activeTurnId, turn.id, "the reconnected desktop sees the working turn");
  await client.steer(id, { text: "also this", expectedTurnId: turn.id });
  await until(() => lines(agentLog).some((e) => e.method === "_session/steering"), "a message sent during the hand-over reaches the working turn");
  fs.writeFileSync(release, "");
  await until(() => events.some((e) => e.method === "turn/completed" && e.params.turn.id === turn.id), "the turn's end reaches the desktop", 10000);
  assert.equal(events.filter((e) => e.method === "turn/completed" && e.params.turn.id === turn.id).length, 1, "its end arrives once");
  await until(() => !oldAlive(), "the old bridge exits once its turn is done", 10000);
  // The chat goes on in the newer bridge, with the old turn kept.
  await until(() => client.connected, "the desktop is connected to the newer bridge", 10000);
  const next = await client.send(id, { text: "after the hand-over" });
  await until(() => events.some((e) => e.method === "turn/completed" && e.params.turn.id === next.turn.id), "the next turn runs in the newer bridge", 10000);
  const saved = JSON.parse(fs.readFileSync(env.ACP_BRIDGE_STORE, "utf8"))[id].turns.flatMap((row) => row.items).filter((item) => item.type === "userMessage").map((item) => item.content[0].text);
  assert.deepEqual(saved, ["[wait] a long task", "also this", "after the hand-over"]);
});

test("an approval pending at the install reaches the reconnected desktop and its answer reaches the working turn", { timeout: 60000 }, async (t) => {
  const { client, events, id, agentLog, oldAlive, install } = await fixture(t);
  const approvals = []; client.on("event", (event) => { if (event.type === "approval") approvals.push(event.data); });
  const { turn } = await client.send(id, { text: "[permission] write the notes" });
  await until(() => approvals.length === 1, "Claude asks before the install");
  await install();
  assert.equal((await client.resume(id, {})).activeTurnId, turn.id, "the reconnected desktop sees the working turn");
  await until(() => approvals.length >= 2, "the pending question is asked again through the newer bridge", 5000);
  client.answerApproval(approvals.at(-1).id, { decision: "accept" });
  await until(() => lines(agentLog).some((e) => e.permission?.optionId === "allow_once"), "the answer reaches the working turn");
  await until(() => events.some((e) => e.method === "turn/completed" && e.params.turn.id === turn.id), "the turn's end reaches the desktop", 10000);
  await until(() => !oldAlive(), "the old bridge exits once its turn is done", 10000);
});

test("a helper working at the install stays connected to the old bridge; its status reads as running through the newer one", { timeout: 60000 }, async (t) => {
  const { client, release, oldAlive, install, socketPath } = await fixture(t);
  // As elpis-agents (the delegate tool): one connection per helper, which never reconnects.
  const helper = new WebSocket(`ws+unix://${socketPath}:/`); await once(helper, "open");
  const frames = []; helper.on("message", (data) => frames.push(JSON.parse(String(data))));
  let seq = 0;
  const call = async (method, params) => { const id = `h-${++seq}`; helper.send(JSON.stringify({ id, method, params })); await until(() => frames.some((m) => m.id === id), `${method} reply`); return frames.find((m) => m.id === id); };
  await call("initialize", { clientInfo: { name: "elpis-agents", version: "0.3.0" }, capabilities: { experimentalApi: true } });
  const helperId = (await call("thread/start", { model: "claude/sonnet", cwd: path.dirname(socketPath), approvalPolicy: "never", sandbox: "read-only" })).result.thread.id;
  const started = await call("turn/start", { threadId: helperId, input: [{ type: "text", text: "[wait] helper task", text_elements: [] }] });
  assert.ok(started.result?.turn?.id, JSON.stringify(started));
  await install();
  assert.equal(helper.readyState, WebSocket.OPEN, "the helper's connection is kept");
  const status = await client.readThreadMetadata(helperId);
  assert.equal(status.status?.type, "active", "delegate_status reads the helper as running through the newer bridge");
  fs.writeFileSync(release, "");
  await until(() => frames.some((m) => m.method === "turn/completed" && m.params.threadId === helperId), "the helper's end reaches its own connection", 10000);
  await until(() => !oldAlive(), "the old bridge exits once the helper is done", 10000);
  // The desktop reconnects once more (the helper's chat moved) and then reads it from the newer bridge as done.
  await until(async () => client.connected && (await client.readThreadMetadata(helperId).catch(() => null))?.status?.type === "idle", "afterwards the newer bridge reads it as done", 10000);
});
