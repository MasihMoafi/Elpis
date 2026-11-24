import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mts";

const source = fileURLToPath(new URL("..", import.meta.url));
const ENGINE = path.join(source, "test/fake-app-server.mts");
const SHARED_RUNTIME = path.join(source, "shared-runtime.mts");
const BRIDGE = path.join(source, "acp-bridge.mts");
const CREDITS_ACP = path.join(source, "openai-credits-acp.mts");
const FAKE_AGY = path.join(source, "test/fake-agy.cts");

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type RecordedRequest = {
  model?: string;
  reasoning?: { effort?: string };
  tools?: { name?: string }[];
  input?: unknown[];
};

async function startMockOpenAI(t: TestContext, responder: (body: RecordedRequest, index: number) => Record<string, unknown>[] | null) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-only") {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        object: "list",
        data: ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-sol"].map(id => ({ id, object: "model", created: 1, owned_by: "openai" })),
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as RecordedRequest;
      const idx = requests.length;
      requests.push(body);
      const output = responder(body, idx);
      if (output === null) { res.destroy(); return; }
      const textDeltas = output
        .filter((item): item is { type: string; content?: { text?: string }[] } => item.type === "message")
        .flatMap(item => (item.content ?? []).map(part => part.text ?? ""))
        .map(delta => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
      const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${idx}`, status: "completed", output, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" }).end([...textDeltas, completed, "data: [DONE]\n\n"].join(""));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${addr.port}/v1`, requests };
}

class AcpClient {
  proc: ReturnType<typeof spawn>;
  seq = 0;
  pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  updates: Record<string, unknown>[] = [];
  permissions: { id: string | number; params: Record<string, unknown> }[] = [];
  allowPermissions = true;

  constructor(env: NodeJS.ProcessEnv, cwd: string) {
    this.proc = spawn(process.execPath, [CREDITS_ACP], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.proc.stdout!.on("data", chunk => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpc;
        if (msg.method === "session/update") {
          this.updates.push(msg.params ?? {});
        } else if (msg.method === "session/request_permission" && msg.id !== undefined) {
          this.permissions.push({ id: msg.id, params: msg.params ?? {} });
          const optionId = this.allowPermissions ? "allow" : "deny";
          this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId } } }) + "\n");
        } else if (msg.id !== undefined) {
          const slot = this.pending.get(Number(msg.id));
          if (!slot) continue;
          this.pending.delete(Number(msg.id));
          if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else slot.resolve(msg.result ?? {});
        }
      }
    });
  }

  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async close() {
    this.proc.stdin!.end();
    if (this.proc.exitCode === null) {
      const exited = once(this.proc, "exit");
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
  }
}

function answerMessage(text: string) {
  return { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

test("openai-credits ACP restores shell/file tools on new and resumed sessions, respects restrictions, and sends only supported effort", { timeout: 20_000 }, async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-credit-acp-"));
  t.after(() => removeTestTempDir(root));
  const elpisHome = path.join(root, "elpis-home");
  const ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(elpisHome, "openai-credits"), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });

  const mock = await startMockOpenAI(t, (body, idx) => {
    const last = body.input?.at(-1) as { type?: string; output?: string } | undefined;
    if (idx === 0) {
      return [{ type: "function_call", id: "fc_1", call_id: "call_bash", name: "bash", arguments: JSON.stringify({ command: "echo fresh-bash-ok" }) }];
    }
    if (idx === 1) {
      return [{ type: "function_call", id: "fc_2", call_id: "call_write", name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hi one\n" }) }];
    }
    if (idx === 2) {
      return [{ type: "function_call", id: "fc_3", call_id: "call_edit", name: "edit_file", arguments: JSON.stringify({ path: "hello.txt", old_string: "one", new_string: "two" }) }];
    }
    if (idx === 3) {
      return [answerMessage(`done:${last?.output ?? ""}`)];
    }
    if (idx === 4) {
      return [{ type: "function_call", id: "fc_4", call_id: "call_resumed", name: "bash", arguments: JSON.stringify({ command: "cat hello.txt" }) }];
    }
    return [answerMessage(`saw:${last?.output ?? ""}`)];
  });

  const acp = new AcpClient({
    PATH: process.env.PATH,
    HOME: root,
    ELPIS_HOME: elpisHome,
    OPENAI_CREDITS_API_KEY: "sk-test-credits",
    OPENAI_CREDITS_BASE_URL: mock.baseUrl,
  }, ws);
  t.after(() => acp.close());

  await acp.call("initialize", { protocolVersion: 1 });
  const started = await acp.call("session/new", { cwd: ws, mcpServers: [], _meta: { elpis: { sandbox: "workspace-write" } } });
  const sessionId = started.sessionId as string;
  const opts = started.configOptions as { id: string; currentValue: string; options: { value: string }[] }[];
  const effortOpt = opts.find(o => o.id === "effort");
  assert.ok(effortOpt);
  assert.deepEqual(effortOpt.options.map(o => o.value), ["low", "medium", "high", "xhigh", "max"]);

  // Unsupported efforts are rejected and never sent; supported effort reaches the request.
  await assert.rejects(() => acp.call("session/set_config_option", { sessionId, configId: "effort", value: "ultra" }), /Unsupported reasoning effort/);
  await acp.call("session/set_config_option", { sessionId, configId: "model", value: "gpt-6.2-astra" });
  await acp.call("session/set_config_option", { sessionId, configId: "effort", value: "high" });

  // The bridge must be told to retain a follow-up, not treat an absent RPC as uncertain delivery.
  const steer = await acp.call("_session/steering", { sessionId, prompt: [{ type: "text", text: "waiting follow-up" }] });
  assert.equal(steer.outcome, "promptRequired");
  assert.equal(mock.requests.length, 0, "steering must not issue another Responses request");

  await acp.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "run shell and edit" }] });
  assert.equal(fs.readFileSync(path.join(ws, "hello.txt"), "utf8"), "hi two\n");
  assert.equal(acp.permissions.length, 3);
  assert.equal(mock.requests[0]!.model, "gpt-6.2-astra");
  assert.deepEqual(mock.requests[0]!.reasoning, { effort: "high" });
  assert.ok(mock.requests[0]!.tools?.some(tool => tool.name === "bash"));
  assert.ok(mock.requests[0]!.tools?.some(tool => tool.name === "edit_file"));

  // Resumed session (with legacy saved history format) retains shell and edit tools, and "default" clears reasoning override.
  const resumedId = "00000000-0000-4000-8000-000000000001";
  fs.writeFileSync(path.join(elpisHome, "openai-credits", `${resumedId}.json`), JSON.stringify({
    version: 1,
    cwd: ws,
    items: [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }],
  }));
  await acp.call("session/load", { sessionId: resumedId, cwd: ws, mcpServers: [], _meta: { elpis: { sandbox: "workspace-write" } } });
  await acp.call("session/set_config_option", { sessionId: resumedId, configId: "effort", value: "default" });
  const resumedPrompt = await acp.call("session/prompt", { sessionId: resumedId, prompt: [{ type: "text", text: "check file" }] });
  assert.equal(resumedPrompt.stopReason, "end_turn");
  assert.equal(mock.requests[4]!.reasoning, undefined);
  assert.ok(mock.requests[4]!.tools?.some(tool => tool.name === "bash"));

  // Restricted sessions: plan mode, read-only sandbox, and tools: [] omit mutating/all tools.
  const plan = await acp.call("session/new", { cwd: ws, mcpServers: [], _meta: { elpis: { sandbox: "workspace-write" } } });
  await acp.call("session/set_mode", { sessionId: plan.sessionId, modeId: "plan" });
  await acp.call("session/prompt", { sessionId: plan.sessionId, prompt: [{ type: "text", text: "plan only" }] });
  assert.deepEqual(mock.requests[6]!.tools?.map(tool => tool.name), ["read_file", "list_directory", "glob_files", "grep_search"]);

  const ro = await acp.call("session/new", { cwd: ws, mcpServers: [], _meta: { elpis: { sandbox: "read-only" } } });
  await acp.call("session/prompt", { sessionId: ro.sessionId, prompt: [{ type: "text", text: "read only" }] });
  assert.deepEqual(mock.requests[7]!.tools?.map(tool => tool.name), ["read_file", "list_directory", "glob_files", "grep_search"]);

  const none = await acp.call("session/new", { cwd: ws, mcpServers: [], _meta: { claudeCode: { options: { tools: [] } } } });
  await acp.call("session/prompt", { sessionId: none.sessionId, prompt: [{ type: "text", text: "no tools" }] });
  assert.deepEqual(mock.requests[8]!.tools, []);
});

test("a failed credit turn keeps its prompt and finished tool result on resume without repeating the tool", { timeout: 15_000 }, async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-credit-recovery-"));
  t.after(() => removeTestTempDir(root));
  const mock = await startMockOpenAI(t, (_, index) => {
    if (index === 0) return [{ type: "function_call", id: "fc_once", call_id: "call_once", name: "write_file", arguments: JSON.stringify({ path: "marker.txt", content: "saved" }) }];
    return index === 1 ? null : [answerMessage("resumed")];
  });
  const acp = new AcpClient({ PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, OPENAI_CREDITS_API_KEY: "fixture", OPENAI_CREDITS_BASE_URL: mock.baseUrl }, root);
  t.after(() => acp.close());
  await acp.call("initialize", { protocolVersion: 1 });
  const args = { cwd: root, mcpServers: [] };
  const { sessionId } = await acp.call("session/new", args);
  await assert.rejects(acp.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "remember the missing request" }] }));
  assert.equal(fs.readFileSync(path.join(root, "marker.txt"), "utf8"), "saved");
  await acp.call("session/load", { sessionId, ...args });
  await acp.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] });
  const input = mock.requests[2]!.input ?? [];
  assert.deepEqual(input.slice(0, -1), mock.requests[1]!.input);
  assert.equal(input.filter(i => JSON.stringify(i).includes("remember the missing request")).length, 1);
  assert.equal(acp.permissions.length, 1);
});

test("bridge model/list exposes credit efforts without ultra, preserves sign-in models, and refreshes stale agy catalog", { timeout: 25_000 }, async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-credit-bridge-"));
  t.after(() => removeTestTempDir(root));
  const elpisHome = path.join(root, "elpis");
  const stateDir = path.join(elpisHome, "elpis-claude");
  const runtimeDir = path.join(root, "run");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const agyExe = path.join(root, "fake-agy");
  fs.copyFileSync(FAKE_AGY, agyExe);
  fs.chmodSync(agyExe, 0o755);

  const mock = await startMockOpenAI(t, () => [answerMessage("ok")]);

  // Seed a stale catalog-agy.json (>24h old) with an outdated model list, plus a stale/empty catalog-openai-credits.json.
  fs.writeFileSync(path.join(stateDir, "catalog-agy.json"), JSON.stringify({
    at: Date.now() - 2 * 86_400_000,
    models: [{ value: "gemini-old", name: "Old Gemini" }],
    efforts: {},
    fallback: { levels: [], current: null },
    modes: ["default"],
  }));
  fs.writeFileSync(path.join(stateDir, "catalog-openai-credits.json"), JSON.stringify({
    at: Date.now(),
    models: [{ value: "gpt-6.2-astra", name: "gpt-6.2-astra" }],
    efforts: { "gpt-6.2-astra": { levels: [], current: null } },
    fallback: { levels: [], current: null },
    modes: null,
  }));
  fs.writeFileSync(path.join(elpisHome, "config.toml"), [
    'model="gpt-6-astra"',
    'model_provider="offline"',
    `model_catalog_json=${JSON.stringify(path.resolve(source, "../../codex-rs/models-manager/models.json"))}`,
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
    ELPIS_ENGINE_BIN: ENGINE,
    ELPIS_SHARED_BRIDGE: "1",
    ELPIS_BRIDGE_IDLE_MS: "60000",
    ACP_ADAPTER: path.join(source, "test/fake-acp-agent.mts"),
    AGY_BIN: agyExe,
    ACP_BRIDGE_STORE: path.join(stateDir, "sessions.json"),
    ACP_BRIDGE_LOG: path.join(root, "bridge.log"),
    ACP_BRIDGE_NO_AGENTS: "1",
    FAKE_ENGINE_STATE: path.join(root, "native.json"),
    FAKE_ENGINE_LOG: path.join(root, "engine.jsonl"),
    FAKE_ACP_LOG: path.join(root, "acp.jsonl"),
    FAKE_ACP_MODELS: "sonnet",
    FAKE_AGY_LOG: path.join(root, "agy.jsonl"),
    OPENAI_CREDITS_API_KEY: "sk-test-credits",
    OPENAI_CREDITS_BASE_URL: mock.baseUrl,
  };
  // Pre-seed Claude catalog so only credits + stale agy run discovery.
  fs.writeFileSync(path.join(stateDir, "catalog.json"), JSON.stringify({
    at: Date.now(),
    models: [{ value: "sonnet", name: "Sonnet" }],
    efforts: { sonnet: { levels: [{ reasoningEffort: "medium", description: "Medium" }], current: "medium" } },
    fallback: { levels: [], current: null },
    modes: ["default"],
  }));

  const launch = spawn(process.execPath, [SHARED_RUNTIME, BRIDGE], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  launch.stdout.on("data", d => { out += d; });
  launch.stderr.on("data", d => { err += d; });
  await once(launch, "exit");
  assert.equal(launch.exitCode, 0, err);
  const socketPath = out.split("\n")[0]?.trim().replace(/^unix:\/\//, "") ?? "";
  assert.ok(socketPath);
  const bridgeStateFile = path.join(path.dirname(socketPath), "state.json");
  t.after(() => {
    try {
      const state = JSON.parse(fs.readFileSync(bridgeStateFile, "utf8")) as { pid?: number };
      if (state.pid) process.kill(state.pid, "SIGTERM");
    } catch {}
  });

  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  t.after(() => ws.close());
  let seq = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  ws.on("message", raw => {
    const msg = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    if (msg.id === undefined) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else slot.resolve(msg.result ?? {});
  });
  const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await rpc("initialize", { clientInfo: { name: "credits-bridge-test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  const list = await rpc("model/list", {});
  const models = list.data as { id: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }[];
  const astra = models.find(m => m.id === "openai-credits/gpt-6.2-astra");
  assert.ok(astra, "openai-credits/gpt-6.2-astra should be listed");
  assert.deepEqual(astra.supportedReasoningEfforts?.map(e => e.reasoningEffort), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(astra.defaultReasoningEffort, "low");

  const signInAstra = models.find(m => m.id === "gpt-6-astra");
  assert.ok(signInAstra, "native sign-in model remains in model/list untouched");
  assert.deepEqual(signInAstra.supportedReasoningEfforts, []);

  // Stale agy catalog refreshed with current fake-agy models.
  assert.ok(models.some(m => m.id === "agy/gemini-3.8-flash-medium"));
  assert.ok(!models.some(m => m.id === "agy/gemini-old"));
});
