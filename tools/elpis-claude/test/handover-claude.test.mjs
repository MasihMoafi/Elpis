import { createTestTempDir, removeTestTempDir } from "./temp-root.mjs";
// A newer bundle is installed while a Claude turn works: it serves new connections within seconds, the turn finishes
// in the old bridge and reaches the desktop client, which reconnects by itself. Real launcher and bridges, scripted
// Claude (fake-acp-agent.mjs) and engine (fake-app-server.mjs); no provider calls.
// Run: node --test tools/elpis-claude/test/handover-claude.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startToken } from "../shared-runtime.mjs";
import mockProvider from "../../../scripts/lib/mock-provider.js";
import WebSocket from "ws";

const { DesktopClient } = await import(new URL("../../../apps/elpis-desktop/bridge/client.mjs", import.meta.url));
const source = fileURLToPath(new URL("..", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(20)) if (await check()) return;
  assert.fail(label);
}

function bundle(root, name, managed) {
  const home = managed ? path.join(root, "versions", name) : null;
  const dir = home ? path.join(home, "tools/elpis-claude") : path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(source).filter((file) => file.endsWith(".mjs") || ["package.json", "package-lock.json"].includes(file))) fs.copyFileSync(path.join(source, file), path.join(dir, file));
  fs.symlinkSync(path.join(source, "node_modules"), path.join(dir, "node_modules"));
  if (!home) return { dir };
  const engine = path.join(home, "package/bin/codex");
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  fs.copyFileSync(path.join(source, "test/fake-app-server.mjs"), engine);
  fs.chmodSync(engine, 0o755);
  fs.symlinkSync(path.join(source, "node_modules"), path.join(home, "package/node_modules"));
  fs.writeFileSync(path.join(home, "package/codex-package.json"), JSON.stringify({ layoutVersion: 1, variant: "elpis", entrypoint: "bin/codex" }));
  fs.writeFileSync(path.join(home, "source.json"), JSON.stringify({ source_head: "a".repeat(40), runtime_sha256: createHash("sha256").update(fs.readFileSync(engine)).digest("hex") }));
  return { dir, engine };
}

async function fixture(t, { directMode = null, locks = false } = {}) {
  const base = directMode ? path.join(os.homedir(), ".cache/elpis-tests") : os.tmpdir();
  if (directMode) fs.mkdirSync(base, { recursive: true });
  const root = createTestTempDir(path.join(base, "ebh-"));
  const [firstBundle, secondBundle] = [bundle(root, "a", directMode), bundle(root, "b", directMode)];
  const [first, second] = [firstBundle.dir, secondBundle.dir];
  const agentLog = path.join(root, "agent.jsonl"), release = path.join(root, "release");
  fs.mkdirSync(path.join(root, "elpis"));
  // A124_ENGINE=/absolute/native/binary runs the real engine, kept offline: it must never call a model here.
  const carrier = new mockProvider.Provider(); await carrier.start(); t.after(() => carrier.close());
  fs.writeFileSync(path.join(root, "elpis", "config.toml"), `model="gpt-5.5"\nmodel_provider="carrier"\nmodel_catalog_json=${JSON.stringify(path.resolve(source, "../../codex-rs/models-manager/models.json"))}\n[features]\ncode_mode=false\n[model_providers.carrier]\nname="offline carrier"\nbase_url=${JSON.stringify(carrier.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: path.join(root, "elpis"), CODEX_HOME: path.join(root, "elpis"), CODEX_AUTH_HOME: root,
    XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root, TMPDIR: root, ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
    ELPIS_ENGINE_BIN: firstBundle.engine ?? process.env.A124_ENGINE ?? path.join(source, "test/fake-app-server.mjs"), ACP_ADAPTER: path.join(source, "test/fake-acp-agent.mjs"),
    ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: path.join(root, "bridge.log"), FAKE_ENGINE_STATE: path.join(root, "native.json"),
    FAKE_ACP_LOG: agentLog, FAKE_ACP_MODELS: "sonnet", FAKE_ACP_NAME: "Claude", FAKE_ACP_RELEASE: release };
  if (locks) env.FAKE_ENGINE_LOCKS = path.join(root, "locks");
  const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  if (directMode && directMode !== "reverse") for (const name of proxyNames) env[name] = /^no_proxy$/i.test(name) ? "localhost,127.0.0.1,::1,example.invalid" : "http://127.0.0.1:9";
  if (directMode) { env.NODE_USE_ENV_PROXY = "1"; env.AGY_DEFAULT_MODEL = "old-fixture"; }
  const nextEnv = { ...env, ...(secondBundle.engine ? { ELPIS_ENGINE_BIN: secondBundle.engine } : {}) };
  if (directMode === "positive" || directMode === "mixed") for (const name of proxyNames) delete nextEnv[name];
  if (directMode === "nonproxy" || directMode === "mixed") nextEnv.AGY_DEFAULT_MODEL = "changed-fixture";
  if (directMode === "reverse") for (const name of proxyNames) nextEnv[name] = /^no_proxy$/i.test(name) ? "localhost,127.0.0.1,::1,example.invalid" : "http://127.0.0.1:9";
  const launchResult = async (dir, launchEnv = env) => {
    const child = spawn(process.execPath, [path.join(dir, "shared-runtime.mjs"), path.join(dir, "acp-bridge.mjs")], { env: launchEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    await once(child, "exit");
    return { code: child.exitCode, out, err };
  };
  const launch = async (dir, launchEnv = env) => {
    const { code, out, err } = await launchResult(dir, launchEnv);
    assert.equal(code, 0, err);
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
    if (directMode) assert.equal(spawnSync("gio", ["trash", root]).status, 0);
    else removeTestTempDir(root);
  });
  await client.models();
  const id = (await client.createThread({ model: "claude/sonnet", cwd: root })).thread.id;
  /** Installs the newer bundle and waits until it serves; the old bridge keeps working. */
  const install = async () => {
    const installedAt = Date.now();
    const from = connection.length;
    await launch(second, nextEnv);
    await until(() => state().pid && state().pid !== old.pid, "the newer bundle serves while the Claude turn works", 10000);
    t.diagnostic(`hand-over took ${Date.now() - installedAt} ms`);
    assert.ok(oldAlive(), "the old bridge keeps the working turn");
    // The desktop is asked to reconnect and does so by itself, as the app does.
    await until(() => connection.slice(from).includes(false) && connection.at(-1) === true, "the desktop reconnects to the newer bridge", 10000);
  };
  return { client, events, id, agentLog, release, env, old, oldAlive, install, socketPath, state, root, launchResult, second, nextEnv, proxyNames };
}

test("direct handover keeps a running turn and starts the new engine without proxy variables", { timeout: 60000 }, async (t) => {
  const { client, events, id, agentLog, release, old, oldAlive, install, socketPath, state, proxyNames } = await fixture(t, { directMode: "positive" });
  const { turn } = await client.send(id, { text: "[wait] a long task" });
  await until(() => lines(agentLog).some((entry) => entry.method === "session/prompt"), "the old turn works");
  await install();
  assert.ok(oldAlive(), "old work is still running");
  const oldEnv = fs.readFileSync(`/proc/${old.pid}/environ`).toString().split("\0").map(item => item.split("=", 1)[0]);
  assert.deepEqual(proxyNames.filter(name => oldEnv.includes(name)), proxyNames, "the old process retains its own environment");
  const current = state();
  const bridgeEnv = fs.readFileSync(`/proc/${current.pid}/environ`).toString().split("\0").map(item => item.split("=", 1)[0]);
  assert.deepEqual(proxyNames.filter(name => bridgeEnv.includes(name)), [], "new bridge is direct");
  let newEngine;
  const runtime = path.dirname(socketPath);
  assert.equal(fs.existsSync(path.join(runtime, "successor-direct")), false, "the consumed marker is removed");
  await until(() => {
    for (const entry of fs.readdirSync(runtime).filter(name => name.startsWith("engine-"))) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(runtime, entry, "engine.json"), "utf8"));
        if (record.bridgePid === current.pid) { newEngine = record.pid; return true; }
      } catch {}
    }
    return false;
  }, "the new bridge starts its own engine", 10000);
  const engineEnv = fs.readFileSync(`/proc/${newEngine}/environ`).toString().split("\0").map(item => item.split("=", 1)[0]);
  assert.deepEqual(proxyNames.filter(name => engineEnv.includes(name)), [], "new engine is direct");
  assert.equal((await client.resume(id, {})).activeTurnId, turn.id, "the running parent remains reachable through the drain");
  fs.writeFileSync(release, "");
  await until(() => events.some(event => event.method === "turn/completed" && event.params.turn.id === turn.id), "the old turn finishes", 10000);
  assert.equal(events.filter(event => event.method === "turn/completed" && event.params.turn.id === turn.id).length, 1);
  await until(() => !oldAlive(), "old bridge exits after its turn", 10000);
});

for (const mode of ["nonproxy", "mixed", "reverse"]) {
  test(`direct handover rejects ${mode} configuration changes`, { timeout: 60000 }, async (t) => {
    const { oldAlive, launchResult, second, nextEnv, state, socketPath } = await fixture(t, { directMode: mode });
    const before = state().pid;
    const result = await launchResult(second, nextEnv);
    assert.notEqual(result.code, 0, "the normal configuration guard rejects this change");
    assert.match(result.err, /different configuration|configuration also differs/);
    assert.equal(state().pid, before);
    assert.ok(oldAlive());
    assert.equal(fs.existsSync(path.join(path.dirname(socketPath), "successor")), false);
  });
}

test("mixed configuration changes do not stop an unattached bridge", { timeout: 60000 }, async (t) => {
  const { client, oldAlive, launchResult, second, nextEnv, state, socketPath } = await fixture(t, { directMode: "mixed" });
  const before = state().pid;
  client.close();
  await until(() => !spawnSync("ss", ["-xHn", "state", "connected", "src", socketPath], { encoding: "utf8" }).stdout.trim(), "the viewer disconnects");
  const result = await launchResult(second, nextEnv);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /configuration also differs/);
  assert.equal(state().pid, before);
  assert.ok(oldAlive(), "the old bridge was not stopped");
});

for (const mode of ["symlink", "public", "wrong-target"]) {
  test(`direct handover rejects a ${mode} marker`, { timeout: 15000 }, async (t) => {
    const base = path.join(os.homedir(), ".cache/elpis-tests");
    fs.mkdirSync(base, { recursive: true });
    const root = createTestTempDir(path.join(base, "edh-"));
    t.after(() => assert.equal(spawnSync("gio", ["trash", root]).status, 0));
    const old = bundle(root, "a", true), next = bundle(root, "b", true);
    const home = path.join(root, "elpis");
    fs.mkdirSync(home);
    const key = createHash("sha256").update(fs.realpathSync(home)).digest("hex").slice(0, 16);
    const runtime = path.join(root, "elpis-bridge", key);
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const target = path.join(next.dir, "acp-bridge.mjs"), marker = path.join(runtime, "successor-direct");
    fs.writeFileSync(path.join(runtime, "successor"), target, { mode: 0o600 });
    if (mode === "symlink") {
      const file = path.join(root, "marker-target");
      fs.writeFileSync(file, target, { mode: 0o600 });
      fs.symlinkSync(file, marker);
    } else {
      fs.writeFileSync(marker, mode === "wrong-target" ? path.join(root, "other") : target, { mode: 0o600 });
      if (mode === "public") fs.chmodSync(marker, 0o644);
    }
    const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: home, XDG_RUNTIME_DIR: root, ELPIS_ENGINE_BIN: old.engine };
    const child = spawn(process.execPath, [path.join(next.dir, "shared-runtime.mjs"), target], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    await once(child, "exit");
    assert.notEqual(child.exitCode, 0);
    assert.match(stderr, /direct handover marker is invalid/i);
    assert.equal(fs.existsSync(path.join(runtime, "state.json")), false, "no bridge started");
  });
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

test("an idle chat held by the old engine is served through the old bridge, not refused by the newer engine", { timeout: 60000 }, async (t) => {
  const { client, id, agentLog, release, install, state, old } = await fixture(t, { locks: true });
  const idle = (await client.createThread({ model: "luna-test", cwd: process.cwd() })).thread.id;
  await client.send(id, { text: "[wait] a long task" });
  await until(() => lines(agentLog).some((entry) => entry.method === "session/prompt"), "the old turn works");
  await install();
  const resumed = await client.resume(idle, {});
  assert.equal(resumed.thread.id, idle, "the idle chat opens in the newer bridge without a writer conflict");
  assert.notEqual(state().pid, old.pid);
  fs.writeFileSync(release, "");
});
