import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mts";

const source = fileURLToPath(new URL("..", import.meta.url));
const SHARED_RUNTIME = path.join(source, "shared-runtime.mts");
const BRIDGE = path.join(source, "acp-bridge.mts");
const FAKE_ENGINE = path.join(source, "test/fake-app-server.mts");

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function runLauncher(args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(process.execPath, [SHARED_RUNTIME, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.on("data", chunk => { stdout += chunk; });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  await once(proc, "exit");
  return { code: proc.exitCode, stdout, stderr };
}

function makeFixture(t: TestContext, prefix: string) {
  const root = createTestTempDir(path.join(os.homedir(), ".cache", "elpis-tests", prefix));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-sr-"));
  const elpisHome = path.join(root, "elpis");
  const stateDir = path.join(elpisHome, "elpis-claude");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(elpisHome, "config.toml"), 'model="gpt-5.5"\nmodel_provider="offline"\n');
  fs.writeFileSync(path.join(stateDir, "catalog.json"), JSON.stringify({ at: Date.now(), models: [{ value: "sonnet", name: "Sonnet" }], efforts: {}, fallback: { levels: [], current: null }, modes: ["default"] }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    ELPIS_HOME: elpisHome,
    CODEX_HOME: elpisHome,
    CODEX_AUTH_HOME: root,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: root,
    TMPDIR: runtimeDir,
    ELPIS_ENGINE_BIN: FAKE_ENGINE,
    ELPIS_SHARED_BRIDGE: "1",
    ELPIS_NO_AGY: "1",
    ACP_ADAPTER: path.join(source, "test/fake-acp-agent.mts"),
    ACP_BRIDGE_STORE: path.join(stateDir, "sessions.json"),
    ACP_BRIDGE_LOG: path.join(root, "bridge.log"),
    ACP_BRIDGE_NO_AGENTS: "1",
    FAKE_ENGINE_STATE: path.join(root, "native.json"),
    FAKE_ENGINE_LOG: path.join(root, "engine.jsonl"),
  };
  const bridgeDir = () => {
    const parent = path.join(runtimeDir, "elpis-bridge");
    const entries = fs.existsSync(parent) ? fs.readdirSync(parent) : [];
    return entries[0] ? path.join(parent, entries[0]) : null;
  };
  t.after(async () => {
    const dir = bridgeDir();
    if (dir) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { pid?: number };
        if (state.pid && alive(state.pid)) process.kill(state.pid, "SIGKILL");
      } catch {}
    }
    await pause(100);
    removeTestTempDir(root);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { root, runtimeDir, elpisHome, env, bridgeDir };
}

test("hung bridge with unreachable socket is automatically stopped and replaced", { timeout: 15_000 }, async t => {
  const { env, bridgeDir } = makeFixture(t, "hung-bridge-");
  const initial = await runLauncher([BRIDGE], env);
  assert.equal(initial.code, 0, initial.stderr);
  const dir = bridgeDir();
  assert.ok(dir);
  const hung = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { try { if (hung.pid && alive(hung.pid)) process.kill(hung.pid, "SIGKILL"); } catch {} });
  assert.ok(hung.pid);

  // Stop the real bridge and simulate a hung process holding state.json with no listening socket.
  const origState = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { pid: number };
  process.kill(origState.pid, "SIGKILL");
  for (let i = 0; i < 40 && alive(origState.pid); i++) await pause(25);
  fs.rmSync(path.join(dir, "bridge.sock"), { force: true });
  const stat = fs.readFileSync(`/proc/${hung.pid}/stat`, "utf8");
  const token = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ pid: hung.pid, token, identity: "hung", script: BRIDGE, engine: FAKE_ENGINE, socket: path.join(dir, "bridge.sock") }));

  const recovered = await runLauncher([BRIDGE], { ...env, ELPIS_BRIDGE_WAIT_MS: "300" });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.match(recovered.stderr, /stopping unresponsive Elpis bridge/);
  assert.equal(alive(hung.pid), false, "hung bridge process should be terminated");
  const nextState = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { pid: number };
  assert.notEqual(nextState.pid, hung.pid);
  assert.equal(alive(nextState.pid), true);
});

test("handover flag is a no-op when idle, allows proxy-only version handover, and hands over attached bridge", { timeout: 25_000 }, async t => {
  const { root, env, bridgeDir } = makeFixture(t, "live-handover-");
  // No running bridge: --handover exits cleanly without starting anything.
  const empty = await runLauncher(["--handover", BRIDGE], env);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, "");

  // Start v1 bridge from an isolated copy.
  const v1Dir = path.join(root, "v1");
  const v2Dir = path.join(root, "v2");
  for (const d of [v1Dir, v2Dir]) {
    fs.mkdirSync(d, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (entry === "test" || entry === "node_modules") continue;
      const src = path.join(source, entry);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(d, entry));
    }
    fs.symlinkSync(path.join(source, "node_modules"), path.join(d, "node_modules"));
  }
  fs.appendFileSync(path.join(v2Dir, "acp-bridge.mts"), "\n// v2\n");
  const v1Bridge = path.join(v1Dir, "acp-bridge.mts");
  const v2Bridge = path.join(v2Dir, "acp-bridge.mts");

  const startV1 = await runLauncher([v1Bridge], env);
  assert.equal(startV1.code, 0, startV1.stderr);
  const sock = startV1.stdout.split("\n")[0]!.trim().replace(/^unix:\/\//, "");
  const dir = bridgeDir();
  assert.ok(dir);
  const v1Pid = (JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { pid: number }).pid;

  // Keep a client connected (simulating an open TUI window) with NODE_USE_ENV_PROXY differing on handover.
  const ws = new WebSocket(`ws+unix://${sock}:/`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  t.after(() => { try { ws.close(); } catch {} });
  ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "handover-test", version: "1" }, capabilities: { experimentalApi: true } } }));
  await pause(150);

  const v2Launcher = path.join(v2Dir, "shared-runtime.mts");
  const hand = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const proc = spawn(process.execPath, [v2Launcher, "--handover", v2Bridge], { env: { ...env, NODE_USE_ENV_PROXY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", c => { stdout += c; });
    proc.stderr.on("data", c => { stderr += c; });
    proc.on("exit", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(hand.code, 0, hand.stderr);

  const deadline = Date.now() + 10_000;
  let v2Pid = 0;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { pid: number; script: string };
      if (state.script === fs.realpathSync(v2Bridge) && alive(state.pid)) {
        v2Pid = state.pid;
        break;
      }
    } catch {}
    await pause(50);
  }
  assert.ok(v2Pid && v2Pid !== v1Pid, "v2 bridge should take over from v1");

  // Also verify proxy-only version join works on launch without error.
  const joinV2 = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const proc = spawn(process.execPath, [v2Launcher, v2Bridge], { env: { ...env, NODE_USE_ENV_PROXY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", c => { stdout += c; });
    proc.stderr.on("data", c => { stderr += c; });
    proc.on("exit", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(joinV2.code, 0, joinV2.stderr);
  assert.equal(joinV2.stdout.trim(), `unix://${sock}`);
});
