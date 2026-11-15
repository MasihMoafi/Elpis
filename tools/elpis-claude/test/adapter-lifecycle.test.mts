import { createTestTempDir, removeTestTempDir } from "./temp-root.mts";
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

const source = fileURLToPath(new URL("..", import.meta.url));
const ENGINE = path.join(source, "test/fake-app-server.mts");
const SHARED_RUNTIME = path.join(source, "shared-runtime.mts");
const BRIDGE = path.join(source, "acp-bridge.mts");
const FAKE_ACP = path.join(source, "test/fake-acp-agent.mts");
const FAKE_AGY = path.join(source, "test/fake-agy.cts");

type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type TrackedProcess = { pid: number; ppid: number; cmdline: string };

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until<T>(check: () => T | Promise<T>, label: string, ms = 8000): Promise<Exclude<T, false | 0 | "" | null | undefined>> {
  for (const end = Date.now() + ms; Date.now() < end; await pause(25)) {
    const value = await check();
    if (value) return value as Exclude<T, false | 0 | "" | null | undefined>;
  }
  assert.fail(`Timed out waiting for: ${label}`);
}

function taggedProcesses(tag: string): TrackedProcess[] {
  const out: TrackedProcess[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!env.includes(`ELPIS_TEST_TAG=${tag}\0`)) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
      out.push({ pid, ppid, cmdline });
    } catch {}
  }
  return out;
}

function adapterCounts(tag: string, claudeMarker = "fake-acp-agent") {
  const procs = taggedProcesses(tag);
  const claude = procs.filter(p => p.cmdline.includes(claudeMarker) && !p.cmdline.includes("acp-bridge"));
  const agyAcp = procs.filter(p => p.cmdline.includes("agy-acp.mts"));
  const agyWorker = procs.filter(p => p.cmdline.includes("fake-agy") || p.cmdline.includes("agy-slow-worker"));
  return { procs, claude, agyAcp, agyWorker };
}

class RpcClient {
  ws: WebSocket;
  nextId = 1;
  pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  notifications: RpcMessage[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as RpcMessage;
      if (msg.id !== undefined && !msg.method) {
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else slot.resolve(msg.result ?? {});
        return;
      }
      this.notifications.push(msg);
    });
    ws.on("close", () => {
      for (const [, slot] of this.pending) slot.reject(new Error("socket closed"));
      this.pending.clear();
    });
  }

  static async connect(socketPath: string): Promise<RpcClient> {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const client = new RpcClient(ws);
    await client.request("initialize", {
      clientInfo: { name: "adapter-lifecycle-test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    return client;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitTurn(threadId: string, ms = 8000): Promise<RpcMessage> {
    let completed: RpcMessage | undefined;
    await until(() => {
      const idx = this.notifications.findIndex(n => n.method === "turn/completed" && n.params?.threadId === threadId);
      if (idx < 0) return false;
      completed = this.notifications.splice(idx, 1)[0];
      return true;
    }, `turn/completed for ${threadId}`, ms);
    return completed as RpcMessage;
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, "close");
    this.ws.close();
    await closed;
  }
}

async function setupFixture(t: TestContext, opts: { preCache?: boolean; acpAdapter?: string; extraEnv?: Record<string, string> } = {}) {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-alc-"));
  const tag = `${path.basename(root)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const elpisHome = path.join(root, "elpis");
  const stateDir = path.join(elpisHome, "elpis-claude");
  const runtimeDir = path.join(root, "run");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { mode: 0o700 });

  const agyExe = path.join(root, "fake-agy");
  fs.copyFileSync(FAKE_AGY, agyExe);
  fs.chmodSync(agyExe, 0o755);

  const agentLog = path.join(root, "acp.jsonl");
  const agyLog = path.join(root, "agy.jsonl");
  const engineLog = path.join(root, "engine.jsonl");
  const release = path.join(root, "release");

  if (opts.preCache) {
    fs.writeFileSync(path.join(stateDir, "catalog.json"), JSON.stringify({
      at: Date.now(),
      models: [{
        value: "sonnet",
        name: "Sonnet",
        description: "Cached Claude test model",
      }],
      efforts: {
        sonnet: {
          levels: [{ reasoningEffort: "medium", description: "Medium" }],
          current: "medium",
        },
      },
      fallback: { levels: [], current: null },
      modes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    }));
    fs.writeFileSync(path.join(stateDir, "catalog-agy.json"), JSON.stringify({
      at: Date.now(),
      models: [{
        value: "gemini-3.8-flash-medium",
        name: "Gemini 3.8 Flash",
        description: "Cached Agy test model",
      }],
      efforts: {},
      fallback: { levels: [], current: null },
      modes: ["default", "plan", "bypassPermissions"],
    }));
  }

  fs.writeFileSync(path.join(elpisHome, "config.toml"), [
    'model="gpt-5.5"',
    'model_provider="offline"',
    `model_catalog_json=${JSON.stringify(path.resolve(source, "../../codex-rs/models-manager/models.json"))}`,
    "[features]",
    "code_mode=false",
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    ELPIS_HOME: elpisHome,
    CODEX_HOME: elpisHome,
    CODEX_AUTH_HOME: root,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: root,
    TMPDIR: root,
    ELPIS_TEST_TAG: tag,
    ELPIS_ENGINE_BIN: ENGINE,
    ELPIS_SHARED_BRIDGE: "1",
    ELPIS_BRIDGE_IDLE_MS: "60000",
    ACP_ADAPTER: opts.acpAdapter ?? FAKE_ACP,
    AGY_BIN: agyExe,
    ACP_BRIDGE_STORE: path.join(stateDir, "sessions.json"),
    ACP_BRIDGE_LOG: path.join(root, "bridge.log"),
    ACP_BRIDGE_NO_AGENTS: "1",
    FAKE_ENGINE_STATE: path.join(root, "native.json"),
    FAKE_ENGINE_LOG: engineLog,
    FAKE_ACP_LOG: agentLog,
    FAKE_ACP_MODELS: "sonnet",
    FAKE_ACP_NAME: "Claude",
    FAKE_ACP_RELEASE: release,
    FAKE_AGY_LOG: agyLog,
    ...opts.extraEnv,
  };

  const launch = spawn(process.execPath, [SHARED_RUNTIME, BRIDGE], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  launch.stdout.on("data", d => { out += d; });
  launch.stderr.on("data", d => { err += d; });
  await once(launch, "exit");
  assert.equal(launch.exitCode, 0, err);
  const socketPath = out.split("\n")[0]?.trim().replace(/^unix:\/\//, "") ?? "";
  assert.ok(socketPath, "expected bridge socket path");
  const bridgeStateFile = path.join(path.dirname(socketPath), "state.json");

  t.after(async () => {
    try {
      const state = JSON.parse(fs.readFileSync(bridgeStateFile, "utf8")) as { pid?: number };
      if (state.pid) process.kill(state.pid, "SIGTERM");
    } catch {}
    await pause(150);
    for (const proc of taggedProcesses(tag)) {
      try { process.kill(proc.pid, "SIGKILL"); } catch {}
    }
    await pause(100);
    removeTestTempDir(root);
  });

  return { root, tag, stateDir, socketPath, agentLog, agyLog, release, env };
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

test("cached catalogs: multiple Codex terminals and model/list start zero provider adapters", { timeout: 30000 }, async (t) => {
  const { root, tag, socketPath, agentLog, agyLog } = await setupFixture(t, { preCache: true });

  const clients = await Promise.all([
    RpcClient.connect(socketPath),
    RpcClient.connect(socketPath),
    RpcClient.connect(socketPath),
  ]);
  t.after(() => Promise.all(clients.map(c => c.close())));

  for (const client of clients) {
    const modelsRes = await client.request("model/list", {});
    const ids = ((modelsRes.data ?? []) as { id: string }[]).map(m => m.id);
    assert.ok(ids.includes("claude/sonnet"), "cached Claude model returned");
    assert.ok(ids.includes("agy/gemini-3.8-flash-medium"), "cached Agy model returned");

    const started = await client.request("thread/start", { model: "gpt-5.5", cwd: root });
    const tid = (started.thread as { id: string }).id;
    await client.request("turn/start", { threadId: tid, input: [{ type: "text", text: "native turn" }] });
    await client.waitTurn(tid);
  }

  await pause(150);
  const counts = adapterCounts(tag);
  assert.equal(counts.claude.length, 0, "expected 0 Claude adapters");
  assert.equal(counts.agyAcp.length, 0, "expected 0 Agy ACP adapters");
  assert.equal(counts.agyWorker.length, 0, "expected 0 Agy workers");
  assert.equal(readJsonl(agentLog).length, 0, "fake Claude adapter never spawned");
  assert.equal(readJsonl(agyLog).length, 0, "fake Agy binary never spawned");
});

test("cold discovery deduplicates across connections, deletes scratch session, and kills adapters", { timeout: 30000 }, async (t) => {
  const { tag, stateDir, socketPath, agentLog } = await setupFixture(t, { preCache: false });

  const c1 = await RpcClient.connect(socketPath);
  const c2 = await RpcClient.connect(socketPath);
  t.after(async () => { await c1.close(); await c2.close(); });

  const [m1, m2] = await Promise.all([c1.request("model/list", {}), c2.request("model/list", {})]);
  for (const res of [m1, m2]) {
    const ids = ((res.data ?? []) as { id: string }[]).map(m => m.id);
    assert.ok(ids.includes("claude/sonnet"), "cold discovery populated Claude");
    assert.ok(ids.includes("agy/gemini-3.8-flash-medium"), "cold discovery populated Agy");
  }

  assert.ok(fs.existsSync(path.join(stateDir, "catalog.json")));
  assert.ok(fs.existsSync(path.join(stateDir, "catalog-agy.json")));

  const acpEntries = readJsonl(agentLog);
  const creates = acpEntries.filter(e => e.method === "session/new");
  assert.equal(creates.length, 1, "only one deduplicated scratch discovery session created");

  await until(() => {
    const c = adapterCounts(tag);
    return c.claude.length === 0 && c.agyAcp.length === 0 && c.agyWorker.length === 0;
  }, "temporary discovery adapters close and exit promptly");
});

test("starts only the requested provider and releases on switch, unsubscribe, archive, and delete", { timeout: 35000 }, async (t) => {
  const { root, tag, socketPath } = await setupFixture(t, { preCache: true });

  const client = await RpcClient.connect(socketPath);
  t.after(() => client.close());

  // 1. Claude turn starts ONLY Claude adapter
  const claudeThread = await client.request("thread/start", { model: "claude/sonnet", cwd: root });
  const cTid = (claudeThread.thread as { id: string }).id;
  await client.request("turn/start", { threadId: cTid, input: [{ type: "text", text: "hi claude" }] });
  await client.waitTurn(cTid);

  let counts = adapterCounts(tag);
  assert.equal(counts.claude.length, 1, "Claude adapter running while subscribed");
  assert.equal(counts.agyAcp.length, 0, "Agy adapter still not started");

  // 2. Switching idle thread from Claude to Agy releases Claude adapter before running Agy turn
  await client.request("thread/settings/update", { threadId: cTid, model: "agy/gemini-3.8-flash-medium" });
  await until(() => adapterCounts(tag).claude.length === 0, "Claude adapter released on provider switch");
  assert.equal(adapterCounts(tag).agyAcp.length, 0, "Agy adapter waits for first turn");

  await client.request("turn/start", { threadId: cTid, input: [{ type: "text", text: "hi agy" }] });
  await client.waitTurn(cTid);
  counts = adapterCounts(tag);
  assert.equal(counts.agyAcp.length, 1, "Agy adapter running after Agy turn");
  assert.equal(counts.claude.length, 0, "Claude stays off");

  // 3. Unsubscribing from idle Agy thread releases Agy adapter
  await client.request("thread/unsubscribe", { threadId: cTid });
  await until(() => {
    const c = adapterCounts(tag);
    return c.agyAcp.length === 0 && c.agyWorker.length === 0;
  }, "Agy adapter released on unsubscribe");

  // 4. Switching idle Claude thread back to native releases Claude adapter
  await client.request("thread/resume", { threadId: cTid });
  await client.request("thread/settings/update", { threadId: cTid, model: "claude/sonnet" });
  await client.request("turn/start", { threadId: cTid, input: [{ type: "text", text: "back to claude" }] });
  await client.waitTurn(cTid);
  assert.equal(adapterCounts(tag).claude.length, 1);

  await client.request("thread/settings/update", { threadId: cTid, model: "gpt-5.5" });
  await until(() => adapterCounts(tag).claude.length === 0, "Claude adapter released on native switch");

  // 5. Archiving releases idle Claude adapter
  const archiveStart = await client.request("thread/start", { model: "claude/sonnet", cwd: root });
  const aTid = (archiveStart.thread as { id: string }).id;
  await client.request("turn/start", { threadId: aTid, input: [{ type: "text", text: "archive me" }] });
  await client.waitTurn(aTid);
  assert.equal(adapterCounts(tag).claude.length, 1);
  await client.request("thread/archive", { threadId: aTid });
  await until(() => adapterCounts(tag).claude.length === 0, "Claude adapter released on thread/archive");

  // 6. Deleting releases idle Claude adapter
  const delStart = await client.request("thread/start", { model: "claude/sonnet", cwd: root });
  const dTid = (delStart.thread as { id: string }).id;
  await client.request("turn/start", { threadId: dTid, input: [{ type: "text", text: "delete me" }] });
  await client.waitTurn(dTid);
  assert.equal(adapterCounts(tag).claude.length, 1);
  await client.request("thread/delete", { threadId: dTid });
  await until(() => adapterCounts(tag).claude.length === 0, "Claude adapter released on thread/delete");
});

test("desktop disconnect cleans desktop-only adapters while preserving terminal work and shared sessions", { timeout: 35000 }, async (t) => {
  const { root, tag, socketPath, agentLog, release } = await setupFixture(t, { preCache: true });

  const terminal = await RpcClient.connect(socketPath);
  const desktop = await RpcClient.connect(socketPath);
  t.after(() => terminal.close());

  // Terminal runs a native Codex thread
  const nativeThread = await terminal.request("thread/start", { model: "gpt-5.5", cwd: root });
  const nativeId = (nativeThread.thread as { id: string }).id;
  await terminal.request("turn/start", { threadId: nativeId, input: [{ type: "text", text: "terminal native 1" }] });
  await terminal.waitTurn(nativeId);

  // Desktop opens a desktop-only Claude thread and disconnects -> adapter is released, terminal survives
  const deskThread = await desktop.request("thread/start", { model: "claude/sonnet", cwd: root });
  const deskId = (deskThread.thread as { id: string }).id;
  await desktop.request("turn/start", { threadId: deskId, input: [{ type: "text", text: "desk only" }] });
  await desktop.waitTurn(deskId);
  assert.equal(adapterCounts(tag).claude.length, 1);

  await desktop.close();
  await until(() => adapterCounts(tag).claude.length === 0, "desktop-only Claude adapter released after desktop disconnect");

  await terminal.request("turn/start", { threadId: nativeId, input: [{ type: "text", text: "terminal native 2" }] });
  await terminal.waitTurn(nativeId);

  // Shared session + active turn: Desktop disconnects while Terminal is subscribed AND while another turn runs
  const desktop2 = await RpcClient.connect(socketPath);
  const sharedStart = await desktop2.request("thread/start", { model: "claude/sonnet", cwd: root });
  const sharedId = (sharedStart.thread as { id: string }).id;
  await desktop2.request("turn/start", { threadId: sharedId, input: [{ type: "text", text: "[wait] keep active" }] });
  await until(() => readJsonl(agentLog).filter(e => e.method === "session/prompt").length >= 2, "second Claude prompt running");

  // Also subscribe Terminal to sharedId
  await terminal.request("thread/resume", { threadId: sharedId });
  await desktop2.close();
  await pause(200);
  assert.equal(adapterCounts(tag).claude.length, 1, "active turn keeps adapter alive after desktop disconnect");

  // Complete the active turn while Terminal still subscribes -> adapter remains alive for shared Terminal viewer
  fs.writeFileSync(release, "go\n");
  await terminal.waitTurn(sharedId);
  await pause(200);
  assert.equal(adapterCounts(tag).claude.length, 1, "shared Terminal subscription preserves adapter");

  // Once Terminal unsubscribes, the now-unviewed adapter is released
  await terminal.request("thread/unsubscribe", { threadId: sharedId });
  await until(() => adapterCounts(tag).claude.length === 0, "adapter released after last subscriber leaves");
});

test("failed adapter startup and spawned descendants leave zero orphan processes", { timeout: 30000 }, async (t) => {
  const dir = createTestTempDir(path.join(os.tmpdir(), "elpis-fail-"));
  const badAdapter = path.join(dir, "bad-acp.mts");
  fs.writeFileSync(badAdapter, [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'child.unref();',
    'setTimeout(() => process.exit(2), 40);',
  ].join("\n"));
  t.after(() => removeTestTempDir(dir));

  const { root, tag, socketPath } = await setupFixture(t, {
    preCache: true,
    acpAdapter: badAdapter,
    extraEnv: { ELPIS_TEST_TAG_UNUSED: "1" },
  });

  const client = await RpcClient.connect(socketPath);
  t.after(() => client.close());

  const started = await client.request("thread/start", { model: "claude/sonnet", cwd: root });
  const tid = (started.thread as { id: string }).id;
  await client.request("turn/start", { threadId: tid, input: [{ type: "text", text: "fail startup" }] });
  const failedTurn = await client.waitTurn(tid);
  assert.equal((failedTurn?.params?.turn as { status?: string })?.status, "failed");

  await until(() => {
    const procs = taggedProcesses(tag).filter(p => p.cmdline.includes("bad-acp.mts") || p.cmdline.includes("setInterval"));
    return procs.length === 0;
  }, "failed startup leaves zero adapter or descendant processes");
});
